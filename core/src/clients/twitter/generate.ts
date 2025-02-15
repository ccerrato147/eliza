/*
 * This file handles the automatic generation of new tweets.
 * It contains the main tweet generation loop and controls tweet timing.
 * Currently configured to post every 2-20 minutes (random interval).
 * To adjust tweet frequency, modify the setTimeout interval in generateNewTweetLoop().
 */
import { Tweet } from "agent-twitter-client";
import fs from "fs";
import { composeContext } from "../../core/context.ts";
import { log_to_file } from "../../core/logger.ts";
import { embeddingZeroVector } from "../../core/memory.ts";
import { IAgentRuntime, ModelClass } from "../../core/types.ts";
import { stringToUuid } from "../../core/uuid.ts";
import { ClientBase } from "./base.ts";
import { generateText } from "../../core/generation.ts";
import logger from "../../core/logger.ts";

const MIN_TWEET_INTERVAL_MINUTES = 0.5; // 60
const MAX_TWEET_INTERVAL_MINUTES = 1; // 80

const newTweetPrompt = `{{timeline}}

{{providers}}

About {{agentName}} (@{{twitterUserName}}):
{{bio}}
{{lore}}
{{postDirections}}

{{recentPosts}}

{{characterPostExamples}}

# Task: Generate a post in the voice and style of {{agentName}}, aka @{{twitterUserName}}
Write a single sentence post that is {{adjective}} about {{topic}} (without mentioning {{topic}} directly), from the perspective of {{agentName}}. Try to write something totally different than previous posts. Do not add commentary or ackwowledge this request, just write the post.
Your response should not contain any questions. Brief, concise statements only. No emojis. Use \\n\\n (double spaces) between statements.`;

export class TwitterGenerationClient extends ClientBase {
    private generationLoopTimeout: NodeJS.Timeout | null = null;
    private static instances = new Set<TwitterGenerationClient>();
    private cachedRuntime: IAgentRuntime | null = null;
    private isGeneratingTweet = false;

    constructor(runtime: IAgentRuntime) {
        // Initialize the client and pass an optional callback to be called when the client is ready
        super({
            runtime,
        });

        // Cache runtime reference
        this.cachedRuntime = runtime;

        // Track this instance
        if (TwitterGenerationClient.instances.size > 0) {
            logger.warn('Multiple TwitterGenerationClient instances detected', {
                existingInstances: TwitterGenerationClient.instances.size,
                agentId: runtime?.agentId
            });
        }
        TwitterGenerationClient.instances.add(this);

        // Listen for shutdown event
        this.on('shutdown', async () => {
            this.isShutdown = true;
            this.cachedRuntime = null;
            if (this.generationLoopTimeout) {
                clearTimeout(this.generationLoopTimeout);
                this.generationLoopTimeout = null;
            }
            // Wait for any pending tweet generation to complete
            while (this.isGeneratingTweet) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            // Clear runtime reference on shutdown
            this.runtime = null;
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
                // This is still an error because it should be set if we have a valid runtime
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
        const generateNewTweetLoop = () => {
            if (!this.validateRuntime()) {
                if (this.generationLoopTimeout) {
                    clearTimeout(this.generationLoopTimeout);
                    this.generationLoopTimeout = null;
                }
                return;
            }

            this.generateNewTweet();
            this.generationLoopTimeout = setTimeout(
                generateNewTweetLoop,
                (Math.floor(Math.random() * (MAX_TWEET_INTERVAL_MINUTES - MIN_TWEET_INTERVAL_MINUTES + 1)) + MIN_TWEET_INTERVAL_MINUTES) * 60 * 1000
            );
        };
        generateNewTweetLoop();
    }

    private async generateNewTweet() {
        if (!this.validateRuntime()) {
            return;
        }

        this.isGeneratingTweet = true;
        logger.log("Generating new tweet");

        try {
            const runtime = this.cachedRuntime || this.runtime;
            if (!runtime?.agentId) {
                logger.error("Runtime validation failed during tweet generation");
                return;
            }

            const twitterUsername = runtime.getSetting("TWITTER_USERNAME");
            if (!twitterUsername) {
                logger.error("Twitter username not found in settings");
                return;
            }

            await runtime.ensureUserExists(
                runtime.agentId,
                twitterUsername,
                runtime.character.name,
                "twitter"
            );

            // Revalidate runtime after async operation
            if (!this.validateRuntime()) {
                return;
            }

            let homeTimeline = [];

            if (!fs.existsSync("tweetcache")) fs.mkdirSync("tweetcache");
            // read the file if it exists
            if (fs.existsSync("tweetcache/home_timeline.json")) {
                homeTimeline = JSON.parse(
                    fs.readFileSync("tweetcache/home_timeline.json", "utf-8")
                );
            } else {
                // Check runtime before fetching timeline
                if (!this.validateRuntime()) {
                    return;
                }
                homeTimeline = await this.fetchHomeTimeline(50);
                fs.writeFileSync(
                    "tweetcache/home_timeline.json",
                    JSON.stringify(homeTimeline, null, 2)
                );
            }

            // Check runtime before formatting timeline
            if (!this.validateRuntime()) {
                return;
            }

            const formattedHomeTimeline =
                `# ${runtime.character.name}'s Home Timeline\n\n` +
                homeTimeline
                    .map((tweet) => {
                        return `ID: ${tweet.id}\nFrom: ${tweet.name} (@${tweet.username})${tweet.inReplyToStatusId ? ` In reply to: ${tweet.inReplyToStatusId}` : ""}\nText: ${tweet.text}\n---\n`;
                    })
                    .join("\n");

            // Check runtime before composing state
            if (!this.validateRuntime()) {
                return;
            }

            const state = await runtime.composeState(
                {
                    userId: runtime.agentId,
                    roomId: stringToUuid("twitter_generate_room"),
                    agentId: runtime.agentId,
                    content: { text: "", action: "" },
                },
                {
                    twitterUserName:
                        twitterUsername,
                    timeline: formattedHomeTimeline,
                }
            );

            // Check runtime before context generation
            if (!this.validateRuntime()) {
                return;
            }

            // Generate new tweet
            const context = composeContext({
                state,
                template: newTweetPrompt,
            });

            const datestr = new Date().toUTCString().replace(/:/g, "-");

            // log context to file
            log_to_file(
                `${twitterUsername}_${datestr}_generate_context`,
                context
            );

            // Check runtime before text generation
            if (!this.validateRuntime()) {
                return;
            }

            const newTweetContent = await generateText({
                runtime,
                context,
                modelClass: ModelClass.SMALL,
            });

            // Final runtime check before sending tweet
            if (!this.validateRuntime()) {
                return;
            }

            logger.log("New Tweet:", newTweetContent);
            log_to_file(
                `${twitterUsername}_${datestr}_generate_response`,
                JSON.stringify(newTweetContent)
            );

            const slice = newTweetContent.replaceAll(/\\n/g, "\n").trim();
            const content = slice + " #life";

            // Send the new tweet
            if (!this.dryRun) {
                try {
                    // Final check before API call
                    if (!this.validateRuntime()) {
                        return;
                    }

                    const result = await this.requestQueue.add(
                        async () => await this.twitterClient.sendTweet(content)
                    );
                    // read the body of the response
                    const body = await result.json();
                    const tweetResult =
                        body.data.create_tweet.tweet_results.result;

                    // Check runtime before processing response
                    if (!this.validateRuntime() || !runtime.messageManager) {
                        logger.error("Runtime or message manager not available after sending tweet");
                        return;
                    }

                    const tweet = {
                        id: tweetResult.rest_id,
                        text: tweetResult.legacy.full_text,
                        conversationId: tweetResult.legacy.conversation_id_str,
                        createdAt: tweetResult.legacy.created_at,
                        userId: tweetResult.legacy.user_id_str,
                        inReplyToStatusId:
                            tweetResult.legacy.in_reply_to_status_id_str,
                        permanentUrl: `https://twitter.com/${twitterUsername}/status/${tweetResult.rest_id}`,
                        hashtags: [],
                        mentions: [],
                        photos: [],
                        thread: [],
                        urls: [],
                        videos: [],
                    } as Tweet;

                    const postId = tweet.id;
                    const conversationId = tweet.conversationId + "-" + runtime.agentId;
                    const roomId = stringToUuid(conversationId);

                    // make sure the agent is in the room
                    await runtime.ensureRoomExists(roomId);
                    await runtime.ensureParticipantInRoom(
                        runtime.agentId,
                        roomId
                    );

                    await this.cacheTweet(tweet);

                    // Final runtime check before creating memory
                    if (!this.validateRuntime() || !runtime.messageManager) {
                        logger.error("Runtime or message manager not available before creating memory");
                        return;
                    }

                    await runtime.messageManager.createMemory({
                        id: stringToUuid(postId + "-" + runtime.agentId),
                        userId: runtime.agentId,
                        agentId: runtime.agentId,
                        content: {
                            text: newTweetContent.trim(),
                            url: tweet.permanentUrl,
                            source: "twitter",
                        },
                        roomId,
                        embedding: embeddingZeroVector,
                        createdAt: tweet.timestamp * 1000,
                    });
                } catch (error) {
                    // Check if error is due to shutdown
                    if (this.isShutdown) {
                        logger.log("Error occurred after shutdown, ignoring");
                        return;
                    }
                    logger.error("Error sending tweet:", {
                        severity: 'ERROR',
                        method: 'twitter.TwitterGenerationClient.sendTweet',
                        agentId: runtime?.agentId,
                        username: twitterUsername,
                        content: content,
                        errorMessage: error.message,
                        errorStack: error.stack,
                        timestamp: new Date().toISOString(),
                        error: error
                    });
                }
            } else {
                logger.log("Dry run, not sending tweet:", newTweetContent);
            }
        } catch (error) {
            // Check if error is due to shutdown
            if (this.isShutdown) {
                logger.log("Error occurred after shutdown, ignoring");
                return;
            }
            logger.error("Error generating new tweet:", {
                severity: 'ERROR',
                method: 'twitter.TwitterGenerationClient.generateNewTweet',
                agentId: this.cachedRuntime?.agentId || this.runtime?.agentId,
                username: this.cachedRuntime?.getSetting("TWITTER_USERNAME") || this.runtime?.getSetting("TWITTER_USERNAME"),
                errorMessage: error.message,
                errorStack: error.stack,
                timestamp: new Date().toISOString(),
                error: error
            });
        } finally {
            this.isGeneratingTweet = false;
        }
    }

    public shutdown(): Promise<void> {
        this.isShutdown = true;
        this.cachedRuntime = null;
        if (this.generationLoopTimeout) {
            clearTimeout(this.generationLoopTimeout);
            this.generationLoopTimeout = null;
        }
        // Remove this instance from tracking
        TwitterGenerationClient.instances.delete(this);
        // Wait for any pending operations to complete
        return new Promise<void>(resolve => setTimeout(() => {
            this.runtime = null;
            resolve();
        }, 100));
    }
}
