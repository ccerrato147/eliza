/**
 * Twitter Search Client
 * 
 * An automated social media engagement system that searches for and responds to relevant tweets.
 * The client continuously monitors Twitter for topics of interest, selects engaging tweets using AI,
 * and generates contextually appropriate responses while maintaining the agent's character voice.
 * 
 * Key Features:
 * - Automated topic-based tweet search and filtering
 * - AI-powered tweet selection and response generation
 * - Comprehensive context building (timeline, threads, images)
 * - Rate limiting and safety features
 * - Detailed interaction logging
 * 
 * Safety measures include avoiding self-replies, non-English tweets, and maintaining response limits.
 */

import { SearchMode, Tweet } from "agent-twitter-client";
import fs from "fs";
import { composeContext } from "../../core/context.ts";
import {
    generateMessageResponse,
    generateText,
} from "../../core/generation.ts";
import { log_to_file } from "../../core/logger.ts";
import { messageCompletionFooter } from "../../core/parsing.ts";
import {
    Content,
    HandlerCallback,
    IAgentRuntime,
    ModelClass,
    State,
    Memory,
} from "../../core/types.ts";
import { stringToUuid } from "../../core/uuid.ts";
import { ClientBase } from "./base.ts";
import { buildConversationThread, sendTweetChunks, wait } from "./utils.ts";
import logger from "../../core/logger.ts";
import { embeddingZeroVector } from "../../core/memory.ts";

// Minimum interval between searches in minutes
const MIN_SEARCH_INTERVAL_MINUTES = 1; // 60
// Maximum interval between searches in minutes
const MAX_SEARCH_INTERVAL_MINUTES = 1.4; // 80
// Number of milliseconds in a minute
const MILLISECONDS_PER_MINUTE = 60 * 1000;

const messageHandlerTemplate =
    `{{relevantFacts}}
{{recentFacts}}

{{timeline}}

{{providers}}

Recent interactions between {{agentName}} and other users:
{{recentPostInteractions}}

About {{agentName}} (@{{twitterUserName}}):
{{bio}}
{{lore}}
{{topics}}

{{postDirections}}

{{recentPosts}}

# Task: Respond to the following post in the style and perspective of {{agentName}} (aka @{{twitterUserName}}). Write a {{adjective}} response for {{agentName}} to say directly in response to the post. don't generalize.
{{currentPost}}

IMPORTANT: Your response CANNOT be longer than 20 words.
Aim for 1-2 short sentences maximum. Be concise and direct.

Your response should not contain any questions. Brief, concise statements only. No emojis. Use \\n\\n (double spaces) between statements.

` + messageCompletionFooter;

export class TwitterSearchClient extends ClientBase {
    private searchInterval: NodeJS.Timeout | null = null;
    private static instances = new Set<TwitterSearchClient>();
    private isEngagementInProgress: boolean = false;
    private cachedRuntime: IAgentRuntime | null = null;

    constructor(runtime: IAgentRuntime) {
        super({
            runtime,
        });
        
        // Cache runtime reference
        this.cachedRuntime = runtime;
        
        // Track this instance
        if (TwitterSearchClient.instances.size > 0) {
            logger.warn('Multiple TwitterSearchClient instances detected', {
                existingInstances: TwitterSearchClient.instances.size,
                agentId: runtime?.agentId
            });
        }
        TwitterSearchClient.instances.add(this);

        // Listen for shutdown event
        this.on('shutdown', async () => {
            await this.shutdown();
        });
    }

    private validateRuntime(): boolean {
        // Check explicit shutdown flag
        if (this.isShutdown) {
            logger.warn("Client is shutdown, skipping operation");
            return false;
        }

        const runtime = this.cachedRuntime || this.runtime;
        
        // All these conditions can happen during shutdown, so log appropriately
        if (!runtime) {
            logger.warn("Runtime is not available (shutdown in progress)");
            return false;
        }

        // Recheck runtime before accessing agentId
        if (!runtime?.agentId) {
            logger.warn("Runtime is missing properties (shutdown in progress)");
            return false;
        }

        // Recheck runtime before accessing character
        if (!runtime?.character) {
            logger.warn("Runtime character is not available (shutdown in progress)");
            return false;
        }

        // Test if getSetting works
        try {
            // Recheck runtime before calling getSetting
            if (!runtime?.getSetting) {
                logger.warn("Runtime getSetting method is not available (shutdown in progress)");
                return false;
            }
            const twitterUsername = runtime.getSetting("TWITTER_USERNAME");
            if (!twitterUsername) {
                logger.error("Twitter username not found in settings");
                return false;
            }
        } catch (error) {
            // This could be due to shutdown or a real error, so check isShutdown
            if (this.isShutdown) {
                logger.warn("Error accessing runtime settings during shutdown");
            } else {
                logger.error("Error accessing runtime settings", {
                    error: error instanceof Error ? error.message : String(error)
                });
            }
            return false;
        }

        return true;
    }

    async onReady() {
        // Start the search loop immediately
        if (this.validateRuntime()) {
            this.engageWithSearchTerms();
        }
        
        // Set up recurring interval
        this.searchInterval = setInterval(() => {
            if (!this.validateRuntime()) {
                if (this.searchInterval) {
                    clearInterval(this.searchInterval);
                    this.searchInterval = null;
                }
                return;
            }
            if (!this.isEngagementInProgress) {
                this.engageWithSearchTerms();
            }
        }, (Math.floor(Math.random() * (MAX_SEARCH_INTERVAL_MINUTES - MIN_SEARCH_INTERVAL_MINUTES + 1)) + MIN_SEARCH_INTERVAL_MINUTES) * MILLISECONDS_PER_MINUTE);
    }

    // Clean up method to clear interval if needed
    async onStop() {
        await this.shutdown();
    }

    public shutdown(): Promise<void> {
        // Set shutdown flag first to prevent new operations
        this.isShutdown = true;
        this.cachedRuntime = null;

        // Clear any running intervals
        if (this.searchInterval) {
            clearInterval(this.searchInterval);
            this.searchInterval = null;
        }

        // Remove this instance from tracking
        TwitterSearchClient.instances.delete(this);

        // Return a promise that resolves after cleanup
        return new Promise<void>(resolve => {
            const checkEngagement = () => {
                if (this.isEngagementInProgress) {
                    setTimeout(checkEngagement, 100);
                    return;
                }
                this.runtime = null;
                resolve();
            };
            
            checkEngagement();
        });
    }

    private async hasProcessedTweet(tweetId: string): Promise<boolean> {
        if (!this.runtime?.messageManager) {
            logger.warn('Runtime not available, skipping processed tweet check');
            return false;
        }
        
        const processedTweetId = stringToUuid(`twitter-search-${tweetId}-${this.runtime.agentId}`);
        try {
            const memory = await this.runtime.messageManager.getMemoryById(processedTweetId);
            return !!memory;
        } catch (error) {
            logger.error('Error checking processed tweet', {
                severity: 'ERROR',
                method: 'search.TwitterSearchClient.hasProcessedTweet',
                agentId: this.runtime?.agentId,
                twitterUsername: this.runtime?.getSetting("TWITTER_USERNAME"),
                tweetId: tweetId,
                processedTweetId: processedTweetId,
                errorMessage: error.message,
                errorStack: error.stack,
                timestamp: new Date().toISOString(),
                error: error
            });
            return false;
        }
    }

    private async markTweetAsProcessed(tweetId: string): Promise<void> {
        // Early return if shutdown or no runtime
        if (this.isShutdown || !this.runtime?.agentId) {
            logger.warn('Skipping marking tweet as processed - client is shutdown or runtime is not available');
            return;
        }

        // Cache runtime reference to ensure consistency
        const runtime = this.runtime;
        if (!runtime?.agentId) {
            logger.warn('Runtime not available, skipping marking tweet as processed');
            return;
        }

        const processedTweetId = stringToUuid(`twitter-search-${tweetId}-${runtime.agentId}`);
        const memory: Memory = {
            id: processedTweetId,
            userId: runtime.agentId,
            content: {
                type: 'twitter-search-processed',
                tweetId: tweetId,
                text: `Search-processed tweet ${tweetId} for agent ${runtime.agentId}`
            },
            agentId: runtime.agentId,
            roomId: stringToUuid(`twitter-search-${runtime.agentId}`),
            embedding: embeddingZeroVector,
            createdAt: Date.now()
        };

        try {
            // Check runtime again before proceeding with memory creation
            if (this.isShutdown || !runtime?.agentId || !runtime.messageManager) {
                logger.warn('Runtime no longer available before memory creation');
                return;
            }

            await runtime.messageManager.createMemory(memory);
            logger.log(`Marked tweet ${tweetId} as search-processed`);
        } catch (error) {
            // Check if error is due to shutdown
            if (this.isShutdown) {
                logger.warn('Error occurred after shutdown, ignoring');
                return;
            }
            logger.error('Failed to mark tweet as processed', {
                severity: 'ERROR',
                method: 'search.TwitterSearchClient.markTweetAsProcessed',
                agentId: runtime.agentId,
                twitterUsername: runtime.getSetting("TWITTER_USERNAME"),
                tweetId: tweetId,
                processedTweetId: processedTweetId,
                errorMessage: error.message,
                errorStack: error.stack,
                timestamp: new Date().toISOString(),
                error: error
            });
            throw error;
        }
    }

    private async engageWithSearchTerms() {
        // Early return if runtime validation fails
        if (!this.validateRuntime()) {
            return;
        }

        this.isEngagementInProgress = true;
        try {
            const runtime = this.cachedRuntime || this.runtime;
            if (!runtime?.agentId || !runtime.character?.topics) {
                return;
            }

            // Verify essential runtime components are available
            if (!runtime.messageManager || !runtime.getSetting("TWITTER_USERNAME")) {
                return;
            }

            logger.log("Starting search engagement cycle");
            const searchTerm = [...runtime.character.topics][
                Math.floor(Math.random() * runtime.character.topics.length)
            ];

            if (!searchTerm) {
                logger.error("No search terms available");
                return;
            }

            // Check runtime before proceeding with search
            if (!this.validateRuntime()) {
                return;
            }

            logger.log(`Searching for term: "${searchTerm}"`);
            const recentTweets = await this.fetchSearchTweets(
                searchTerm,
                20,
                SearchMode.Latest
            );
            logger.log(`Found ${recentTweets.tweets.length} tweets for search term`);

            // Check runtime before processing tweets
            if (!this.validateRuntime()) {
                return;
            }

            // Filter out already processed tweets
            const unprocessedTweets = await Promise.all(
                recentTweets.tweets.map(async (tweet) => {
                    const isProcessed = await this.hasProcessedTweet(tweet.id);
                    return !isProcessed ? tweet : null;
                })
            );

            const validTweets = unprocessedTweets
                .filter(tweet => tweet !== null)
                .filter((tweet) => {
                    // ignore tweets where any of the thread tweets contain a tweet by the bot
                    const thread = tweet.thread;
                    const botTweet = thread.find(
                        (t) => t.username === this.runtime.getSetting("TWITTER_USERNAME")
                    );
                    return !botTweet;
                });

            if (validTweets.length === 0) {
                logger.log(`No unprocessed tweets found for term: ${searchTerm}`);
                return;
            }

            logger.log(`Found ${validTweets.length} valid unprocessed tweets`);

            const homeTimeline = await this.fetchHomeTimeline(50);
            
            if (!this.validateRuntime()) {
                logger.warn('Stopping search engagement - client was shutdown');
                return;
            }

            fs.writeFileSync(
                "tweetcache/home_timeline.json",
                JSON.stringify(homeTimeline, null, 2)
            );

            const formattedHomeTimeline =
                `# ${this.runtime.character.name}'s Home Timeline\n\n` +
                homeTimeline
                    .map((tweet) => {
                        return `ID: ${tweet.id}\nFrom: ${tweet.name} (@${tweet.username})${tweet.inReplyToStatusId ? ` In reply to: ${tweet.inReplyToStatusId}` : ""}\nText: ${tweet.text}\n---\n`;
                    })
                    .join("\n");

            // randomly slice .tweets down to 20
            const slicedTweets = validTweets
                .sort(() => Math.random() - 0.5)
                .slice(0, 20);

            if (slicedTweets.length === 0) {
                logger.warn(
                    "No valid tweets found for the search term",
                    searchTerm
                );
                return;
            }

            const prompt = `
  Here are some tweets related to the search term "${searchTerm}":
  
  ${[...slicedTweets, ...homeTimeline]
      .map(
          (tweet) => `
    ID: ${tweet.id}${tweet.inReplyToStatusId ? ` In reply to: ${tweet.inReplyToStatusId}` : ""}
    From: ${tweet.name} (@${tweet.username})
    Text: ${tweet.text}
  `
      )
      .join("\n")}
  
  Which tweet is the most interesting and relevant for Ruby to reply to? Please provide only the ID of the tweet in your response.
  Notes:
    - Respond to English tweets only
    - Respond to tweets that don't have a lot of hashtags, links, URLs or images
    - Respond to tweets that are not retweets
    - Respond to tweets where there is an easy exchange of ideas to have with the user
    - ONLY respond with the ID of the tweet`;

            const datestr = new Date().toUTCString().replace(/:/g, "-");
            const logName = `${this.runtime.character.name}_search_${datestr}`;
            log_to_file(logName, prompt);

            const mostInterestingTweetResponse = await generateText({
                runtime: this.runtime,
                context: prompt,
                modelClass: ModelClass.SMALL,
            });

            if (!this.validateRuntime()) {
                logger.warn('Stopping search engagement - client was shutdown');
                return;
            }

            const responseLogName = `${this.runtime.character.name}_search_${datestr}_result`;
            log_to_file(responseLogName, mostInterestingTweetResponse);

            const tweetId = mostInterestingTweetResponse.trim();
            const selectedTweet = slicedTweets.find(
                (tweet) =>
                    tweet.id.toString().includes(tweetId) ||
                    tweetId.includes(tweet.id.toString())
            );

            if (!selectedTweet) {
                logger.warn("No matching tweet found for the selected ID");
                return logger.warn("Selected tweet ID:", tweetId);
            }

            logger.log("Selected tweet to reply to:", selectedTweet?.text);

            if (
                selectedTweet.username ===
                runtime.getSetting("TWITTER_USERNAME")
            ) {
                logger.warn("Skipping tweet from bot itself");
                return;
            }

            // Mark the tweet as processed BEFORE handling it
            await this.markTweetAsProcessed(selectedTweet.id);

            const conversationId = selectedTweet.conversationId;
            const roomId = stringToUuid(conversationId + "-" + runtime.agentId);

            const userIdUUID = stringToUuid(selectedTweet.userId as string);

            await runtime.ensureConnection(
                userIdUUID,
                roomId,
                selectedTweet.username,
                selectedTweet.name,
                "twitter"
            );

            // crawl additional conversation tweets, if there are any
            await buildConversationThread(selectedTweet, this);

            const message = {
                id: stringToUuid(selectedTweet.id + "-" + runtime.agentId),
                agentId: runtime.agentId,
                content: {
                    text: selectedTweet.text,
                    url: selectedTweet.permanentUrl,
                    inReplyTo: selectedTweet.inReplyToStatusId
                        ? stringToUuid(selectedTweet.inReplyToStatusId + "-" + runtime.agentId)
                        : undefined,
                },
                userId: userIdUUID,
                roomId,
                createdAt: selectedTweet.timestamp * 1000,
            };

            if (!message.content.text) {
                return { text: "", action: "IGNORE" };
            }

            // Format the entire conversation thread in chronological order
            const formatTweet = (tweet: Tweet) => {
                return `ID: ${tweet.id}
From: ${tweet.name} (@${tweet.username})
Text: ${tweet.text}
${tweet.photos?.length > 0 ? '[Contains media]' : ''}
---`;
            };

            // Sort thread by timestamp to ensure chronological order
            const sortedThread = [...selectedTweet.thread].sort((a, b) => a.timestamp - b.timestamp);
            
            const conversationContext = `# Full Conversation Thread\n\n${
                sortedThread.map(formatTweet).join('\n\n')
            }\n\n# Current Tweet to Reply to:\n${formatTweet(selectedTweet)}`;

            let tweetBackground = "";
            if (selectedTweet.isRetweet) {
                const originalTweet = await this.requestQueue.add(() =>
                    this.twitterClient.getTweet(selectedTweet.id)
                );
                tweetBackground = `Retweeting @${originalTweet.username}: ${originalTweet.text}`;
            }

            // Generate image descriptions using GPT-4 vision API
            const imageDescriptions = [];
            for (const photo of selectedTweet.photos) {
                const description =
                    await runtime.imageDescriptionService.describeImage(
                        photo.url
                    );
                imageDescriptions.push(description);
            }

            let state = await runtime.composeState(message, {
                twitterClient: this.twitterClient,
                twitterUserName: runtime.getSetting("TWITTER_USERNAME"),
                timeline: formattedHomeTimeline,
                currentPost: conversationContext,
                tweetContext: `${tweetBackground}

${conversationContext}
${selectedTweet.urls.length > 0 ? `URLs: ${selectedTweet.urls.join(", ")}\n` : ""}${imageDescriptions.length > 0 ? `\nImages in Post (Described): ${imageDescriptions.join(", ")}\n` : ""}
`,
            });

            await this.saveRequestMessage(message, state as State);

            const context = composeContext({
                state,
                template: messageHandlerTemplate,
            });

            // log context to file
            log_to_file(
                `${runtime.getSetting("TWITTER_USERNAME")}_${datestr}_search_context`,
                context
            );

            const responseContent = await generateMessageResponse({
                runtime: runtime,
                context,
                modelClass: ModelClass.SMALL,
            });

            responseContent.inReplyTo = message.id;

            log_to_file(
                `${runtime.getSetting("TWITTER_USERNAME")}_${datestr}_search_response`,
                JSON.stringify(responseContent)
            );

            const response = responseContent;

            if (!response.text) {
                logger.warn("Returning: No response text found");
                return;
            }

            logger.log(
                `Bot would respond to tweet ${selectedTweet.id} with: ${response.text}`
            );
            try {
                const callback: HandlerCallback = async (response: Content) => {
                    if (!this.validateRuntime()) {
                        logger.warn('Skipping tweet send - client is shutdown');
                        return [];
                    }

                    const memories = await sendTweetChunks(
                        this,
                        response,
                        message.roomId,
                        runtime.getSetting("TWITTER_USERNAME"),
                        tweetId
                    );
                    return memories;
                };

                const responseMessages = await callback(responseContent);

                state = await runtime.updateRecentMessageState(state);

                for (const responseMessage of responseMessages) {
                    await runtime.messageManager.createMemory(
                        responseMessage,
                        false
                    );
                }

                state = await runtime.updateRecentMessageState(state);

                await runtime.evaluate(message, state);

                await runtime.processActions(
                    message,
                    responseMessages,
                    state,
                    callback
                );

                const responseInfo = `Context:\n\n${context}\n\nSelected Post: ${selectedTweet.id} - ${selectedTweet.username}: ${selectedTweet.text}\nAgent's Output:\n${response.text}`;
                const debugFileName = `tweetcache/tweet_generation_${selectedTweet.id}.txt`;

                fs.writeFileSync(debugFileName, responseInfo);
                await wait();
            } catch (error) {
                logger.error('Error sending response post', {
                    severity: 'ERROR',
                    method: 'search.TwitterSearchClient.engageWithSearchTerms',
                    agentId: this.cachedRuntime?.agentId || this.runtime?.agentId,
                    twitterUsername: this.cachedRuntime?.getSetting("TWITTER_USERNAME") || this.runtime?.getSetting("TWITTER_USERNAME"),
                    tweetId: selectedTweet.id,
                    responseText: response.text,
                    errorMessage: error.message,
                    errorStack: error.stack,
                    timestamp: new Date().toISOString(),
                    error: error
                });
            }
        } catch (error) {
            // Check if error is due to shutdown
            if (this.isShutdown) {
                logger.warn("Error occurred after shutdown, ignoring");
                return;
            }
            logger.error('Error engaging with search terms', {
                severity: 'ERROR',
                method: 'search.TwitterSearchClient.engageWithSearchTerms',
                agentId: this.cachedRuntime?.agentId || this.runtime?.agentId,
                twitterUsername: this.cachedRuntime?.getSetting("TWITTER_USERNAME") || this.runtime?.getSetting("TWITTER_USERNAME"),
                errorMessage: error.message,
                errorStack: error.stack,
                timestamp: new Date().toISOString(),
                error: error
            });
        } finally {
            this.isEngagementInProgress = false;
        }
    }
}