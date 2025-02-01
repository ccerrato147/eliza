/*
 * This file handles responses to mentions and interactions on Twitter.
 * - Checks for new mentions every 2-5 minutes
 * - Determines whether to respond to tweets mentioning the agent
 * - Generates appropriate responses to interactions
 * 
 * IMPORTANT: Conversation IDs are always stored with the agent ID appended
 * (e.g., "conversationId-agentId") to ensure consistent tracking across
 * different agents. This format must be maintained when tracking thread
 * counts and interactions.
 */

import { SearchMode, Tweet } from "agent-twitter-client";
import { composeContext } from "../../core/context.ts";
import logger from "../../core/logger.ts";
import {
    messageCompletionFooter,
    shouldRespondFooter,
} from "../../core/parsing.ts";
import {
    Content,
    HandlerCallback,
    IAgentRuntime,
    Memory,
    ModelClass,
    State,
} from "../../core/types.ts";
import { stringToUuid } from "../../core/uuid.ts";
import { ClientBase } from "./base.ts";
import { buildConversationThread, sendTweetChunks, wait } from "./utils.ts";
import {
    generateMessageResponse,
    generateShouldRespond,
} from "../../core/generation.ts";
import { embeddingZeroVector } from "../../core/memory.ts";

const MAX_INTERACTIONS_PER_THREAD = 12;
const MIN_CHECK_INTERVAL_MINUTES = 1;
const MAX_CHECK_INTERVAL_MINUTES = 2.5;

export const messageHandlerTemplate =
    `{{relevantFacts}}
{{recentFacts}}

{{timeline}}

{{providers}}

# Task: Generate a post for the character {{agentName}}.
About {{agentName}} (@{{twitterUserName}}):
{{bio}}
{{lore}}
{{topics}}

{{characterPostExamples}}

{{postDirections}}

Recent interactions between {{agentName}} and other users:
{{recentPostInteractions}}

{{recentPosts}}

# Task: Generate a post in the voice, style and perspective of {{agentName}} (@{{twitterUserName}}):
{{currentPost}}

` + messageCompletionFooter;

export const shouldRespondTemplate =
    `# INSTRUCTIONS: Determine if {{agentName}} (@{{twitterUserName}}) should respond to the message and participate in the conversation. Do not comment. Just respond with "true" or "false".

Response options are RESPOND, IGNORE and STOP.

{{agentName}} should respond to messages that are directed at them, or participate in conversations that are interesting or relevant to their background, IGNORE messages that are irrelevant to them, and should STOP if the conversation is concluded.

{{agentName}} is in a room with other users and wants to be conversational, but not annoying.
{{agentName}} should RESPOND to messages that are directed at them, or participate in conversations that are interesting or relevant to their background.
If a message is not interesting or relevant, {{agentName}} should IGNORE.
Unless directly RESPONDing to a user, {{agentName}} should IGNORE messages that are very short or do not contain much information.
If a user asks {{agentName}} to stop talking, {{agentName}} should STOP.
If {{agentName}} concludes a conversation and isn't part of the conversation anymore, {{agentName}} should STOP.

{{recentPosts}}

IMPORTANT: {{agentName}} (aka @{{twitterUserName}}) is particularly sensitive about being annoying, so if there is any doubt, it is better to IGNORE than to RESPOND.

{{currentPost}}

# INSTRUCTIONS: Respond with [RESPOND] if {{agentName}} should respond, or [IGNORE] if {{agentName}} should not respond to the last message and [STOP] if {{agentName}} should stop participating in the conversation.
` + shouldRespondFooter;

export class TwitterInteractionClient extends ClientBase {
    public lastCheckedTweetId: number | null = null;
    private interactionLoopTimeout: NodeJS.Timeout | null = null;
    private static instances = new Set<TwitterInteractionClient>();
    private isInteractionInProgress: boolean = false;
    private cachedRuntime: IAgentRuntime | null = null;

    constructor(runtime: IAgentRuntime) {
        super({
            runtime,
        });
        
        // Cache runtime reference
        this.cachedRuntime = runtime;
        
        // Track this instance
        if (TwitterInteractionClient.instances.size > 0) {
            logger.warn('Multiple TwitterInteractionClient instances detected', {
                existingInstances: TwitterInteractionClient.instances.size,
                agentId: runtime?.agentId
            });
        }
        TwitterInteractionClient.instances.add(this);
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

    onReady() {
        const handleTwitterInteractionsLoop = async () => {
            // Check if shutdown was called or runtime validation fails
            if (!this.validateRuntime()) {
                if (this.interactionLoopTimeout) {
                    clearTimeout(this.interactionLoopTimeout);
                    this.interactionLoopTimeout = null;
                }
                return;
            }

            try {
                // Load last checked tweet ID at the start of each loop
                await this.loadLastCheckedTweetId();
                logger.log(`Starting interaction loop with last checked tweet ID: ${this.lastCheckedTweetId}`);
                await this.handleTwitterInteractions();
            } catch (error) {
                // Only log if runtime is still available
                if (this.validateRuntime()) {
                    logger.error('Error in Twitter interactions loop', {
                        severity: 'ERROR',
                        method: 'interactions.TwitterInteractionClient.handleTwitterInteractionsLoop',
                        agentId: this.runtime?.agentId,
                        errorMessage: error.message,
                        errorStack: error.stack,
                        timestamp: new Date().toISOString(),
                        error: error
                    });
                }
            }

            // Only schedule next iteration if not shutdown and runtime exists
            if (this.validateRuntime()) {
                const interval = (Math.floor(Math.random() * (MAX_CHECK_INTERVAL_MINUTES - MIN_CHECK_INTERVAL_MINUTES + 1)) + MIN_CHECK_INTERVAL_MINUTES) * 60 * 1000;
                logger.log(`Scheduling next interaction check in ${Math.round(interval/1000/60)} minutes`);
                this.interactionLoopTimeout = setTimeout(
                    handleTwitterInteractionsLoop,
                    interval
                );
            }
        };

        // Listen for shutdown event
        this.on('shutdown', async () => {
            await this.shutdown();
        });

        // Start the interaction loop
        handleTwitterInteractionsLoop();
    }

    private async loadLastCheckedTweetId(): Promise<void> {
        // Early return if runtime validation fails
        if (!this.validateRuntime()) {
            return;
        }

        const stateId = stringToUuid(`twitter-state-${this.runtime?.agentId}`);
        try {
            const stateMemory = await this.runtime?.messageManager?.getMemoryById(stateId);
            if (!stateMemory) {
                logger.log('No previous state found, starting fresh');
                this.lastCheckedTweetId = null;
                return;
            }
            
            const savedId = stateMemory.content.lastCheckedTweetId;
            this.lastCheckedTweetId = typeof savedId === 'number' ? savedId : null;
            logger.log(`Loaded last checked tweet ID: ${this.lastCheckedTweetId}`);
        } catch (error) {
            logger.error('Failed to load last checked tweet ID', {
                severity: 'ERROR',
                method: 'interactions.TwitterInteractionClient.loadLastCheckedTweetId',
                agentId: this.runtime?.agentId,
                twitterUsername: this.runtime?.getSetting("TWITTER_USERNAME"),
                stateId: stateId,
                errorMessage: error.message,
                errorStack: error.stack,
                timestamp: new Date().toISOString(),
                error: error
            });
            this.lastCheckedTweetId = null;
        }
    }

    private async saveLastCheckedTweetId(tweetId: number): Promise<void> {
        // Early return if shutdown or no runtime
        if (this.isShutdown || !this.runtime?.agentId) {
            return;
        }

        const stateId = stringToUuid(`twitter-state-${this.runtime.agentId}`);
        
        try {
            // Double check runtime still exists and has required services
            if (!this.runtime?.messageManager) {
                logger.log('Runtime or messageManager not available, skipping state save');
                return;
            }

            // First check if we already have a state memory
            const existingMemory = await this.runtime.messageManager.getMemoryById(stateId);
            
            if (existingMemory) {
                // Update case - just update the lastCheckedTweetId
                existingMemory.content.lastCheckedTweetId = tweetId;
                await this.runtime.messageManager.createMemory(existingMemory);
                this.lastCheckedTweetId = tweetId;
                logger.log(`Updated last checked tweet ID: ${tweetId}`);
            } else {
                // Create case - create new memory with initial state
                const memory: Memory = {
                    id: stateId,
                    userId: this.runtime.agentId,
                    content: {
                        type: 'twitter-state',
                        lastCheckedTweetId: tweetId,
                        text: `Twitter state information for agent ${this.runtime.agentId}`
                    },
                    agentId: this.runtime.agentId,
                    roomId: stringToUuid(`twitter-state-${this.runtime.agentId}`),
                    embedding: embeddingZeroVector,
                    createdAt: Date.now()
                };
                await this.runtime.messageManager.createMemory(memory);
                this.lastCheckedTweetId = tweetId;
                logger.log(`Created new state with last checked tweet ID: ${tweetId}`);
            }
        } catch (error) {
            logger.error('Failed to save/update last checked tweet ID', {
                severity: 'ERROR',
                method: 'interactions.TwitterInteractionClient.saveLastCheckedTweetId',
                agentId: this.runtime?.agentId,
                twitterUsername: this.runtime?.getSetting("TWITTER_USERNAME"),
                stateId: stateId,
                tweetId: tweetId,
                errorMessage: error.message,
                errorStack: error.stack,
                timestamp: new Date().toISOString(),
                error: error
            });
            throw error;
        }
    }

    private async hasProcessedTweet(tweetId: string): Promise<boolean> {
        // Early return if shutdown or no runtime
        if (this.isShutdown || !this.runtime?.agentId || !this.runtime?.messageManager) {
            return false;
        }

        try {
            // First check if the tweet ID is older than our last checked ID
            if (this.lastCheckedTweetId && parseInt(tweetId) <= this.lastCheckedTweetId) {
                logger.log(`Tweet ${tweetId} is older than last checked ID ${this.lastCheckedTweetId}`);
                return true;
            }

            // Then check if we've explicitly marked it as processed
            const processedTweetId = stringToUuid(`twitter-processed-${tweetId}-${this.runtime.agentId}`);
            const memory = await this.runtime.messageManager.getMemoryById(processedTweetId);
            return !!memory;
        } catch (error) {
            logger.error('Error checking processed tweet', {
                severity: 'ERROR',
                method: 'interactions.TwitterInteractionClient.hasProcessedTweet',
                agentId: this.runtime?.agentId,
                twitterUsername: this.runtime?.getSetting("TWITTER_USERNAME"),
                tweetId: tweetId,
                lastCheckedTweetId: this.lastCheckedTweetId,
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
            return;
        }

        const processedTweetId = stringToUuid(`twitter-processed-${tweetId}-${this.runtime.agentId}`);
        const memory: Memory = {
            id: processedTweetId,
            userId: this.runtime.agentId,
            content: {
                type: 'twitter-processed',
                tweetId: tweetId,
                text: `Processed tweet ${tweetId} for agent ${this.runtime.agentId}`
            },
            agentId: this.runtime.agentId,
            roomId: stringToUuid(`twitter-processed-${this.runtime.agentId}`),
            embedding: embeddingZeroVector,
            createdAt: Date.now()
        };

        try {
            if (!this.runtime?.messageManager) {
                logger.error('Runtime or messageManager not available');
                return;
            }
            await this.runtime.messageManager.createMemory(memory);
            logger.log(`Marked tweet ${tweetId} as processed`);
        } catch (error) {
            logger.error('Failed to mark tweet as processed', {
                severity: 'ERROR',
                method: 'interactions.TwitterInteractionClient.markTweetAsProcessed',
                agentId: this.runtime?.agentId,
                twitterUsername: this.runtime?.getSetting("TWITTER_USERNAME"),
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

    private async countThreadInteractions(conversationId: string): Promise<number> {
        if (this.isShutdown || !this.runtime?.agentId || !this.runtime?.messageManager) {
            return 0;
        }

        try {
            const roomId = stringToUuid(conversationId + "-" + this.runtime.agentId);
            const count = await this.runtime.messageManager.countMemories(roomId, false);
            return count;
        } catch (error) {
            logger.error('Error counting thread interactions', {
                severity: 'ERROR',
                method: 'interactions.TwitterInteractionClient.countThreadInteractions',
                agentId: this.runtime?.agentId,
                twitterUsername: this.runtime?.getSetting("TWITTER_USERNAME"),
                conversationId: conversationId,
                errorMessage: error.message,
                errorStack: error.stack,
                timestamp: new Date().toISOString(),
                error: error
            });
            return 0;
        }
    }

    async handleTwitterInteractions() {
        // Early return if shutdown or no runtime
        if (this.isShutdown || !this.runtime?.agentId || !this.runtime?.messageManager) {
            return;
        }

        // Prevent concurrent executions
        if (this.isInteractionInProgress) {
            logger.log("Interaction already in progress, skipping");
            return;
        }

        logger.log("Starting Twitter interactions check");
        this.isInteractionInProgress = true;

        try {
            // Cache runtime reference to ensure consistency
            const runtime = this.runtime;
            if (!runtime?.agentId) {
                logger.log("Runtime not available, skipping interactions check");
                return;
            }

            // Double check runtime still exists and has required settings
            const twitterUsername = runtime?.getSetting("TWITTER_USERNAME");
            if (!twitterUsername) {
                logger.error('Twitter username not available in runtime settings');
                return;
            }

            // Check for mentions
            logger.log(`Checking mentions for @${twitterUsername}`);
            const tweetCandidates = (
                await this.fetchSearchTweets(
                    `@${twitterUsername}`,
                    20,
                    SearchMode.Latest
                )
            ).tweets;

            if (!tweetCandidates || tweetCandidates.length === 0) {
                logger.log("No new mentions found");
                return;
            }

            // Check runtime again before processing tweets
            if (!runtime?.messageManager) {
                logger.error('Runtime or messageManager not available');
                return;
            }

            // de-duplicate tweetCandidates and filter out self-tweets
            const uniqueTweetCandidates = [...new Set(tweetCandidates)]
                .sort((a, b) => parseInt(b.id) - parseInt(a.id)) // Sort in descending order (newest first)
                .filter((tweet) => tweet.userId !== this.twitterUserId);

            logger.log(`Processing ${uniqueTweetCandidates.length} unique tweets`);

            let highestProcessedId = this.lastCheckedTweetId || 0;

            // for each tweet candidate, handle the tweet
            for (const tweet of uniqueTweetCandidates) {
                // Check for shutdown or missing runtime before each tweet
                if (this.isShutdown || !runtime?.messageManager || !runtime?.agentId) {
                    logger.log("Runtime no longer available, stopping tweet processing");
                    return;
                }

                try {
                    const tweetId = parseInt(tweet.id);
                    
                    // Skip if we've already processed this tweet
                    const isProcessed = await this.hasProcessedTweet(tweet.id);
                    if (isProcessed) {
                        logger.log(`Skipping tweet ${tweet.id} - already processed`);
                        continue;
                    }

                    logger.log(`Processing new tweet ${tweet.id} from @${tweet.username}`);

                    // Mark the tweet as processed BEFORE handling it to prevent race conditions
                    await this.markTweetAsProcessed(tweet.id);
                    
                    // Update highest processed ID if this tweet's ID is higher
                    if (tweetId > highestProcessedId) {
                        highestProcessedId = tweetId;
                    }

                    const conversationId = tweet.conversationId + "-" + runtime?.agentId;
                    const roomId = stringToUuid(conversationId);
                    const userIdUUID = stringToUuid(tweet.userId as string);

                    await runtime?.ensureConnection(
                        userIdUUID,
                        roomId,
                        tweet.username,
                        tweet.name,
                        "twitter"
                    );

                    await buildConversationThread(tweet, this as unknown as ClientBase);

                    const message = {
                        id: stringToUuid(tweet.id + "-" + runtime.agentId),
                        content: { 
                            text: tweet.text,
                            url: tweet.permanentUrl,
                            inReplyTo: tweet.inReplyToStatusId
                                ? stringToUuid(tweet.inReplyToStatusId + "-" + runtime.agentId)
                                : undefined,
                        },
                        agentId: runtime.agentId,
                        userId: userIdUUID,
                        roomId,
                        createdAt: tweet.timestamp * 1000,
                    };
                    
                    await this.handleTweet({
                        tweet,
                        message,
                    });

                    logger.log(`Successfully processed tweet ${tweet.id}`);
                } catch (error) {
                    logger.error('Error processing tweet', {
                        severity: 'ERROR',
                        method: 'interactions.TwitterInteractionClient.handleTwitterInteractions',
                        agentId: runtime?.agentId,
                        twitterUsername: runtime?.getSetting("TWITTER_USERNAME"),
                        tweetId: tweet.id,
                        errorMessage: error.message,
                        errorStack: error.stack,
                        timestamp: new Date().toISOString(),
                        error: error
                    });
                    // Continue with next tweet instead of breaking the loop
                    continue;
                }
            }

            // After processing all tweets, update the last checked ID to the highest we've seen
            if (highestProcessedId > (this.lastCheckedTweetId || 0)) {
                await this.saveLastCheckedTweetId(highestProcessedId);
                logger.log(`Updated last checked tweet ID to ${highestProcessedId}`);
            }

            logger.log("Finished checking Twitter interactions");
        } catch (error) {
            logger.error('Error in handleTwitterInteractions', {
                severity: 'ERROR',
                method: 'interactions.TwitterInteractionClient.handleTwitterInteractions',
                agentId: this.runtime?.agentId,
                twitterUsername: this.runtime?.getSetting("TWITTER_USERNAME"),
                errorMessage: error.message,
                errorStack: error.stack,
                timestamp: new Date().toISOString(),
                error: error
            });
        } finally {
            // Always reset the interaction flag when we're done
            this.isInteractionInProgress = false;
            logger.log("Interaction check completed, ready for next check");
        }
    }

    private async handleTweet({
        tweet,
        message,
    }: {
        tweet: Tweet;
        message: Memory;
    }) {
        try {
            // Validate runtime and required components
            if (!this.runtime?.agentId || !this.runtime?.messageManager || !this.runtime?.character) {
                logger.error('Required runtime components not available');
                return;
            }

            // Check thread interaction count early, adding 1 to account for this new interaction
            try {
                const interactionCount = await this.countThreadInteractions(tweet.conversationId);
                if ((interactionCount) >= MAX_INTERACTIONS_PER_THREAD) {
                    return;
                }
            } catch (error) {
                logger.error(`Error checking thread interaction count for tweet ${tweet.id}:`, error);
                return;
            }

            if (tweet.username === this.runtime?.getSetting("TWITTER_USERNAME")) {
                return;
            }

            // Save the tweet message if it doesn't exist
            const tweetId = stringToUuid(tweet.id + "-" + this.runtime.agentId);
            const tweetExists = await this.runtime.messageManager.getMemoryById(tweetId);

            if (!tweetExists) {
                logger.log(`Saving new tweet ${tweet.id}`);
                const userIdUUID = stringToUuid(tweet.userId as string);
                const roomId = stringToUuid(tweet.conversationId);

                const tweetMemory: Memory = {
                    id: tweetId,
                    agentId: this.runtime.agentId,
                    content: {
                        text: tweet.text,
                        url: tweet.permanentUrl,
                        inReplyTo: tweet.inReplyToStatusId
                            ? stringToUuid(tweet.inReplyToStatusId + "-" + this.runtime.agentId)
                            : undefined,
                    },
                    userId: userIdUUID,
                    roomId,
                    createdAt: tweet.timestamp * 1000,
                    embedding: embeddingZeroVector // Will be added by addEmbeddingToMemory
                };

                await this.runtime.messageManager.addEmbeddingToMemory(tweetMemory);
                await this.runtime.messageManager.createMemory(tweetMemory);
            }

            if (!message.content.text) {
                logger.log("skipping tweet with no text", tweet.id);
                return { text: "", action: "IGNORE" };
            }

            logger.log("handling tweet", tweet.id);
            const formatTweet = (tweet: Tweet) => {
                return `  ID: ${tweet.id}
  From: ${tweet.name} (@${tweet.username})
  Text: ${tweet.text}`;
            };
            const currentPost = formatTweet(tweet);

            const homeTimeline = await this.fetchHomeTimeline(50);

            const formattedHomeTimeline =
                `# ${this.runtime.character.name}'s Home Timeline\n\n` +
                homeTimeline
                    .map((tweet) => {
                        return `ID: ${tweet.id}\nFrom: ${tweet.name} (@${tweet.username})${tweet.inReplyToStatusId ? ` In reply to: ${tweet.inReplyToStatusId}` : ""}\nText: ${tweet.text}\n---\n`;
                    })
                    .join("\n");

            let state = await this.runtime.composeState(message, {
                twitterClient: this.twitterClient,
                twitterUserName: this.runtime.getSetting("TWITTER_USERNAME"),
                currentPost,
                timeline: formattedHomeTimeline,
            });

            await this.saveRequestMessage(message, state as State);

            logger.log("composeState done");

            const shouldRespondContext = composeContext({
                state,
                template: shouldRespondTemplate,
            });

            const shouldRespond = await generateShouldRespond({
                runtime: this.runtime,
                context: shouldRespondContext,
                modelClass: ModelClass.SMALL,
            });

            if (!shouldRespond) {
                logger.log("Not responding to message");
                return { text: "", action: "IGNORE" };
            }

            const context = composeContext({
                state,
                template: messageHandlerTemplate,
            });

            const datestr = new Date().toUTCString().replace(/:/g, "-");

            // log context to file
            logger.log(
                `${this.runtime.getSetting("TWITTER_USERNAME")}_${datestr}_interactions_context`,
                context
            );

            const response = await generateMessageResponse({
                runtime: this.runtime,
                context,
                modelClass: ModelClass.SMALL,
            });

            logger.log("response", response);
            logger.log("tweet is", tweet);
            logger.log("stringId is", stringToUuid(tweet.id + "-" + this.runtime.agentId), "while tweet.id is", tweet.id);
            logger.log("response is", response);

            response.inReplyTo = stringToUuid(tweet.id + "-" + this.runtime.agentId);

            logger.log(
                `${this.runtime.getSetting("TWITTER_USERNAME")}_${datestr}_interactions_response`,
                JSON.stringify(response)
            );

            if (response.text) {
                if (!this.dryRun) {
                    const callback: HandlerCallback = async (response: Content) => {
                        const memories = await sendTweetChunks(
                            this,
                            response,
                            message.roomId,
                            this.runtime?.getSetting("TWITTER_USERNAME"),
                            tweet.id
                        );
                        return memories;
                    };

                    const responseMessages = await callback(response);

                    state = (await this.runtime.updateRecentMessageState(
                        state
                    )) as State;

                    for (const responseMessage of responseMessages) {
                        await this.runtime.messageManager.createMemory(
                            responseMessage
                        );
                    }

                    await this.runtime.evaluate(message, state);

                    await this.runtime.processActions(
                        message,
                        responseMessages,
                        state,
                        callback
                    );
                } else {
                    logger.log("Dry run, not sending tweet:", response.text);
                }
                
                // Log response info without writing to file
                const responseInfo = `Context:\n\n${context}\n\nSelected Post: ${tweet.id} - ${tweet.username}: ${tweet.text}\nAgent's Output:\n${response.text}`;
                logger.log("Tweet generation info:", responseInfo);
                
                await wait();
            }
        } catch (error) {
            logger.error('Error handling tweet', {
                severity: 'ERROR',
                method: 'interactions.TwitterInteractionClient.handleTweet',
                agentId: this.runtime?.agentId,
                twitterUsername: this.runtime?.getSetting("TWITTER_USERNAME"),
                tweetId: tweet.id,
                username: tweet.username,
                errorMessage: error.message,
                errorStack: error.stack,
                timestamp: new Date().toISOString(),
                error: error
            });
            throw error;
        }
    }

    public shutdown(): Promise<void> {
        // Set shutdown flag first to prevent new operations
        this.isShutdown = true;
        this.cachedRuntime = null;

        // Clear any running intervals
        if (this.interactionLoopTimeout) {
            clearTimeout(this.interactionLoopTimeout);
            this.interactionLoopTimeout = null;
        }

        // Remove this instance from tracking
        TwitterInteractionClient.instances.delete(this);

        // Return a promise that resolves after cleanup
        return new Promise<void>(resolve => {
            const checkInteraction = () => {
                if (this.isInteractionInProgress) {
                    setTimeout(checkInteraction, 100);
                    return;
                }
                this.runtime = null;
                resolve();
            };
            
            checkInteraction();
        });
    }
}
