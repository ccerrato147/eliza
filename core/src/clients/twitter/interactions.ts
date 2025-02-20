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
import { sendTweetChunks, wait } from "./utils.ts";
import {
    generateMessageResponse,
    generateShouldRespond,
} from "../../core/generation.ts";
import { embeddingZeroVector } from "../../core/memory.ts";

const MAX_INTERACTIONS_PER_THREAD = 12;
const MIN_CHECK_INTERVAL_MINUTES = 2;
const MAX_CHECK_INTERVAL_MINUTES = 5;
const DEFAULT_MAX_THREAD_DEPTH = 10;

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

Thread of Tweets You Are Replying To:
{{formattedConversation}}

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

Thread of Tweets You Are Replying To:
{{formattedConversation}}

# INSTRUCTIONS: Respond with [RESPOND] if {{agentName}} should respond, or [IGNORE] if {{agentName}} should not respond to the last message and [STOP] if {{agentName}} should stop participating in the conversation.
` + shouldRespondFooter;

export class TwitterInteractionClient extends ClientBase {
    private static instances = new Set<TwitterInteractionClient>();
    protected isShutdown: boolean = false;
    private isInteractionInProgress: boolean = false;
    private cachedRuntime: IAgentRuntime | null = null;
    private interactionLoop: NodeJS.Timeout | null = null;
    public lastCheckedTweetId: number | null = null;

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
                logger.error('Twitter username not found in settings', {
                    severity: 'ERROR',
                    method: 'interactions.TwitterInteractionClient.validateRuntime',
                    agentId: runtime?.agentId,
                    twitterUsername: runtime?.getSetting("TWITTER_USERNAME"),
                    errorMessage: 'Twitter username setting is missing',
                    timestamp: new Date().toISOString()
                });
                return false;
            }
        } catch (error) {
            // This could be due to shutdown or a real error, so check isShutdown
            if (this.isShutdown) {
                logger.warn("Error accessing runtime settings during shutdown");
            } else {
                logger.error('Error accessing runtime settings', {
                    severity: 'ERROR',
                    method: 'interactions.TwitterInteractionClient.validateRuntime',
                    agentId: runtime?.agentId,
                    twitterUsername: runtime?.getSetting("TWITTER_USERNAME"),
                    errorMessage: error instanceof Error ? error.message : String(error),
                    errorStack: error instanceof Error ? error.stack : undefined,
                    timestamp: new Date().toISOString(),
                    error: error
                });
            }
            return false;
        }

        return true;
    }

    public shutdown(): Promise<void> {
        // Set shutdown flag first to prevent new operations
        this.isShutdown = true;
        this.cachedRuntime = null;

        // Clear any running intervals
        if (this.interactionLoop) {
            clearTimeout(this.interactionLoop);
            this.interactionLoop = null;
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

    onReady() {
        const handleTwitterInteractionsLoop = async () => {
            if (!this.validateRuntime()) {
                if (this.interactionLoop) {
                    clearTimeout(this.interactionLoop);
                    this.interactionLoop = null;
                }
                return;
            }

            await this.loadLastCheckedTweetId();
            await this.handleTwitterInteractions();
            
            // Only schedule next run if not shutdown
            if (!this.isShutdown) {
                this.interactionLoop = setTimeout(
                    handleTwitterInteractionsLoop,
                    (Math.floor(Math.random() * (MAX_CHECK_INTERVAL_MINUTES - MIN_CHECK_INTERVAL_MINUTES + 1)) + MIN_CHECK_INTERVAL_MINUTES) * 60 * 1000
                );
            }
        };
        handleTwitterInteractionsLoop();
    }

    private async buildThreadContext(tweet: Tweet, maxDepth = DEFAULT_MAX_THREAD_DEPTH): Promise<Tweet[]> {
        if (!this.validateRuntime()) {
            return [];
        }

        const thread: Tweet[] = [];
        const visited = new Set<string>();
        const runtime = this.cachedRuntime || this.runtime;

        const processThread = async (currentTweet: Tweet, depth = 0) => {
            logger.log("Processing tweet in thread:", {
                id: currentTweet.id,
                inReplyToStatusId: currentTweet.inReplyToStatusId,
                depth: depth,
                isReply: currentTweet.isReply,
                isRetweet: currentTweet.isRetweet,
                username: currentTweet.username
            });

            if (!currentTweet) {
                logger.log("No current tweet found for thread building");
                return;
            }

            // Validate runtime again after async operation
            if (!this.validateRuntime()) {
                return;
            }

            if (depth >= maxDepth) {
                logger.log("Reached maximum thread depth", depth);
                return;
            }

            if (visited.has(currentTweet.id)) {
                logger.log("Already visited tweet:", currentTweet.id);
                return;
            }

            // Store tweet in memory during thread building
            try {
                const tweetId = stringToUuid(currentTweet.id + "-" + runtime.agentId);
                const tweetExists = await runtime.messageManager.getMemoryById(tweetId);

                if (!tweetExists) {
                    logger.log(`Storing tweet ${currentTweet.id} in memory`);
                    const userIdUUID = stringToUuid(currentTweet.userId as string);
                    const roomId = stringToUuid(currentTweet.conversationId + "-" + runtime.agentId);

                    // Ensure connection before storing memory
                    await runtime.ensureConnection(
                        userIdUUID,
                        roomId,
                        currentTweet.username,
                        currentTweet.name,
                        "twitter"
                    );

                    const tweetMemory: Memory = {
                        id: tweetId,
                        agentId: runtime.agentId,
                        content: {
                            text: currentTweet.text,
                            url: currentTweet.permanentUrl,
                            imageUrls: currentTweet.photos?.map(photo => photo.url) || [],
                            inReplyTo: currentTweet.inReplyToStatusId
                                ? stringToUuid(currentTweet.inReplyToStatusId + "-" + runtime.agentId)
                                : undefined,
                            metadata: {
                                isReply: currentTweet.isReply,
                                isRetweet: currentTweet.isRetweet,
                                type: currentTweet.isRetweet ? 'retweet' : currentTweet.isReply ? 'reply' : 'tweet'
                            }
                        },
                        userId: userIdUUID,
                        roomId,
                        createdAt: currentTweet.timestamp * 1000,
                        embedding: embeddingZeroVector
                    };

                    await runtime.messageManager.addEmbeddingToMemory(tweetMemory);
                    await runtime.messageManager.createMemory(tweetMemory);
                }
            } catch (error) {
                if (this.isShutdown) {
                    logger.warn("Error storing tweet memory during shutdown");
                    return;
                }
                logger.error("Error storing tweet in memory:", {
                    tweetId: currentTweet.id,
                    error: error instanceof Error ? error.message : String(error),
                    stack: error instanceof Error ? error.stack : undefined
                });
            }

            visited.add(currentTweet.id);
            thread.unshift(currentTweet); // Add to beginning to maintain chronological order

            if (currentTweet.inReplyToStatusId) {
                logger.log("Fetching parent tweet:", currentTweet.inReplyToStatusId);
                try {
                    const parentTweet = await this.twitterClient.getTweet(currentTweet.inReplyToStatusId);
                    if (parentTweet) {
                        logger.log("Found parent tweet:", {
                            id: parentTweet.id,
                            text: parentTweet.text?.slice(0, 50),
                            username: parentTweet.username
                        });
                        await processThread(parentTweet, depth + 1);
                    } else {
                        logger.log("No parent tweet found for:", currentTweet.inReplyToStatusId);
                    }
                } catch (error) {
                    if (this.isShutdown) {
                        logger.warn("Error fetching parent tweet during shutdown");
                        return;
                    }
                    logger.error("Error fetching parent tweet:", {
                        tweetId: currentTweet.inReplyToStatusId,
                        error: error instanceof Error ? error.message : String(error),
                        stack: error instanceof Error ? error.stack : undefined
                    });
                }
            } else {
                logger.log("Reached end of reply chain at:", currentTweet.id);
            }
        };

        await processThread(tweet, 0);
        return thread;
    }

    private formatConversation(thread: Tweet[]): string {
        if (!thread || thread.length === 0) {
            return "";
        }
        
        return thread.map((tweet) => 
            `@${tweet.username} (${new Date(tweet.timestamp * 1000).toLocaleString("en-US", {
                hour: "2-digit",
                minute: "2-digit",
                month: "short",
                day: "numeric",
            })})${tweet.isRetweet ? ' [Retweet]' : tweet.isReply ? ' [Reply]' : ''}:
${tweet.text}`
        ).join("\n\n");
    }

    private async loadLastCheckedTweetId(): Promise<void> {
        if (!this.validateRuntime()) {
            return;
        }

        const stateId = stringToUuid(`twitter-state-${this.runtime.agentId}`);
        try {
            const stateMemory = await this.runtime.messageManager.getMemoryById(stateId);
            if (!stateMemory) {
                logger.log('No previous state found, starting fresh');
                this.lastCheckedTweetId = null;
                return;
            }
            
            const savedId = stateMemory.content.lastCheckedTweetId;
            this.lastCheckedTweetId = typeof savedId === 'number' ? savedId : null;
            logger.log(`Loaded last checked tweet ID: ${this.lastCheckedTweetId}`);
        } catch (error) {
            logger.error('Failed to load last checked tweet ID:', error);
            this.lastCheckedTweetId = null;
        }
    }

    private async saveLastCheckedTweetId(tweetId: number): Promise<void> {
        if (!this.validateRuntime()) {
            return;
        }

        const stateId = stringToUuid(`twitter-state-${this.runtime.agentId}`);
        
        try {
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
            // Check if error is due to shutdown
            if (this.isShutdown) {
                logger.warn('Error occurred after shutdown, ignoring');
                return;
            }
            logger.error('Failed to save/update last checked tweet ID:', error);
            throw error;
        }
    }

    private async hasProcessedTweet(tweetId: string): Promise<boolean> {
        if (!this.validateRuntime()) {
            return false;
        }

        const processedTweetId = stringToUuid(`twitter-processed-${tweetId}-${this.runtime.agentId}`);
        try {
            const memory = await this.runtime.messageManager.getMemoryById(processedTweetId);
            return !!memory;
        } catch (error) {
            // Check if error is due to shutdown
            if (this.isShutdown) {
                logger.warn('Error checking processed tweet during shutdown');
                return false;
            }
            logger.error(`Error checking processed tweet ${tweetId}:`, error);
            return false;
        }
    }

    private async markTweetAsProcessed(tweetId: string): Promise<void> {
        if (!this.validateRuntime()) {
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
            await this.runtime.messageManager.createMemory(memory);
            logger.log(`Marked tweet ${tweetId} as processed`);
        } catch (error) {
            // Check if error is due to shutdown
            if (this.isShutdown) {
                logger.warn('Error marking tweet as processed during shutdown');
                return;
            }
            logger.error(`Failed to mark tweet ${tweetId} as processed:`, error);
            throw error;
        }
    }

    private async countThreadInteractions(conversationId: string): Promise<number> {
        if (!this.validateRuntime()) {
            return 0;
        }

        const runtime = this.cachedRuntime || this.runtime;
        
        try {
            const roomId = stringToUuid(conversationId + "-" + runtime.agentId);
            
            // Validate runtime before async operation
            if (!this.validateRuntime()) {
                return 0;
            }
            
            const count = await runtime.messageManager.countMemories(roomId, false);
            return count;
        } catch (error) {
            // Check if error is due to shutdown
            if (this.isShutdown) {
                logger.warn('Error counting thread interactions during shutdown');
                return 0;
            }
            logger.error("Error counting thread interactions:", error);
            return 0;
        }
    }

    async handleTwitterInteractions() {
        if (!this.validateRuntime()) {
            return;
        }

        this.isInteractionInProgress = true;
        try {
            const tweetCandidates = (
                await this.fetchSearchTweets(
                    `@${this.runtime.getSetting("TWITTER_USERNAME")}`,
                    20,
                    SearchMode.Latest
                )
            ).tweets;

            if (!tweetCandidates || tweetCandidates.length === 0) {
                logger.log("No tweet candidates found");
                return;
            }

            const uniqueTweetCandidates = [...new Set(tweetCandidates)]
                .sort((a, b) => a.id.localeCompare(b.id))
                .filter((tweet) => tweet.userId !== this.twitterUserId);

            logger.log(`Processing ${uniqueTweetCandidates.length} unique tweets`);

            for (const tweet of uniqueTweetCandidates) {
                try {
                    if (!this.validateRuntime()) {
                        logger.warn('Stopping tweet processing - client was shutdown');
                        return;
                    }

                    if (
                        !this.lastCheckedTweetId ||
                        parseInt(tweet.id) > this.lastCheckedTweetId
                    ) {
                        const isProcessed = await this.hasProcessedTweet(tweet.id);
                        if (isProcessed) {
                            logger.log(`Skipping tweet ${tweet.id} - already processed`);
                            continue;
                        }

                        logger.log(`Processing new tweet ${tweet.id} from @${tweet.username}`);

                        const conversationId = tweet.conversationId + "-" + this.runtime.agentId;
                        const roomId = stringToUuid(conversationId);
                        const userIdUUID = stringToUuid(tweet.userId as string);

                        await this.runtime.ensureConnection(
                            userIdUUID,
                            roomId,
                            tweet.username,
                            tweet.name,
                            "twitter"
                        );

                        // Build thread context before handling tweet
                        const thread = await this.buildThreadContext(tweet);
                        const formattedConversation = this.formatConversation(thread);

                        const message = {
                            content: { 
                                text: tweet.text,
                                imageUrls: tweet.photos?.map(photo => photo.url) || []
                            },
                            agentId: this.runtime.agentId,
                            userId: userIdUUID,
                            roomId,
                        };

                        // Mark the tweet as processed BEFORE handling it
                        await this.markTweetAsProcessed(tweet.id);
                        
                        await this.handleTweet({
                            tweet,
                            message,
                            thread,
                            formattedConversation
                        });

                        await this.saveLastCheckedTweetId(parseInt(tweet.id));
                    }
                } catch (error) {
                    logger.error(`Error processing tweet ${tweet.id}:`, error);
                    continue;
                }
            }

            logger.log("Finished checking Twitter interactions");
        } catch (error) {
            logger.error("Error in handleTwitterInteractions:", error);
        } finally {
            this.isInteractionInProgress = false;
        }
    }

    private async handleTweet({
        tweet,
        message,
        thread,
        formattedConversation
    }: {
        tweet: Tweet;
        message: Memory;
        thread: Tweet[];
        formattedConversation: string;
    }) {
        if (!this.validateRuntime()) {
            return { text: "", action: "IGNORE" };
        }

        const runtime = this.cachedRuntime || this.runtime;
        
        try {
            // Check thread interaction count early, adding 1 to account for this new interaction
            try {
                const interactionCount = await this.countThreadInteractions(tweet.conversationId);
                if ((interactionCount) >= MAX_INTERACTIONS_PER_THREAD) {
                    logger.log(`Skipping tweet ${tweet.id} - thread interaction limit reached (${interactionCount}/${MAX_INTERACTIONS_PER_THREAD})`);
                    return { text: "", action: "IGNORE" };
                }
            } catch (error) {
                if (this.isShutdown) {
                    logger.warn("Error checking thread interaction count during shutdown");
                    return { text: "", action: "IGNORE" };
                }
                logger.error(`Error checking thread interaction count for tweet ${tweet.id}:`, {
                    error: error instanceof Error ? error.message : String(error),
                    stack: error instanceof Error ? error.stack : undefined
                });
                return { text: "", action: "IGNORE" };
            }

            // Validate runtime again after async operation
            if (!this.validateRuntime()) {
                return { text: "", action: "IGNORE" };
            }

            if (tweet.username === runtime.getSetting("TWITTER_USERNAME")) {
                logger.log(`Skipping tweet ${tweet.id} - from self`);
                return { text: "", action: "IGNORE" };
            }

            if (!message.content.text) {
                logger.log(`Skipping tweet ${tweet.id} - no text content`);
                return { text: "", action: "IGNORE" };
            }

            logger.log("Processing tweet", {
                id: tweet.id,
                username: tweet.username,
                isReply: tweet.isReply,
                isRetweet: tweet.isRetweet,
                threadLength: thread.length
            });

            const formatTweet = (tweet: Tweet) => {
                return `  ID: ${tweet.id}
  From: ${tweet.name} (@${tweet.username})
  Text: ${tweet.text}`;
            };
            const currentPost = formatTweet(tweet);

            let homeTimeline = await this.fetchHomeTimeline(50);

            const formattedHomeTimeline =
                `# ${this.runtime.character.name}'s Home Timeline\n\n` +
                homeTimeline
                    .map((tweet) => {
                        return `ID: ${tweet.id}\nFrom: ${tweet.name} (@${tweet.username})${tweet.inReplyToStatusId ? ` In reply to: ${tweet.inReplyToStatusId}` : ""}\nText: ${tweet.text}\n---\n`;
                    })
                    .join("\n");

            // Include thread context in state
            let state = await this.runtime.composeState(message, {
                twitterClient: this.twitterClient,
                twitterUserName: this.runtime.getSetting("TWITTER_USERNAME"),
                currentPost,
                timeline: formattedHomeTimeline,
                formattedConversation,
                threadContext: thread.map(t => ({
                    id: t.id,
                    username: t.username,
                    text: t.text,
                    timestamp: t.timestamp,
                    isReply: t.isReply,
                    isRetweet: t.isRetweet
                }))
            });

            logger.log("State composed for tweet", {
                tweetId: tweet.id,
                stateSize: JSON.stringify(state).length
            });

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
                    const callback: HandlerCallback = async (responseContent: Content) => {
                        const memories = await sendTweetChunks(
                            this,
                            responseContent,
                            message.roomId,
                            this.runtime.getSetting("TWITTER_USERNAME"),
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
                    await this.runtime.processActions(message, responseMessages, state);
                } else {
                    logger.log("Dry run, not sending tweet:", response.text);
                }
                
                const responseInfo = `Context:\n\n${context}\n\nSelected Post: ${tweet.id} - ${tweet.username}: ${tweet.text}\nAgent's Output:\n${response.text}`;
                logger.log("Tweet generation info:", responseInfo);
                
                await wait();
            }
        } catch (error) {
            logger.error(`Error handling tweet ${tweet.id}:`, error);
            throw error;
        }
    }
}