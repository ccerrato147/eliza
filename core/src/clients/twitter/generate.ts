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

const MIN_TWEET_INTERVAL_MINUTES = 60;
const MAX_TWEET_INTERVAL_MINUTES = 80;

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

    onReady() {
        const generateNewTweetLoop = () => {
            // Check if shutdown was called or runtime is null
            if (this.isShutdown || !this.runtime?.agentId) {
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

    constructor(runtime: IAgentRuntime) {
        // Initialize the client and pass an optional callback to be called when the client is ready
        super({
            runtime,
        });

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
            if (this.generationLoopTimeout) {
                clearTimeout(this.generationLoopTimeout);
                this.generationLoopTimeout = null;
            }
            // Wait for any pending operations to complete
            await new Promise(resolve => setTimeout(resolve, 100));
            // Clear runtime reference on shutdown
            this.runtime = null;
        });
    }

    private async generateNewTweet() {
        // Early return if shutdown or no runtime
        if (this.isShutdown || !this.runtime?.agentId) {
            logger.log("Skipping tweet generation - client is shutdown or runtime is not available");
            return;
        }

        logger.log("Generating new tweet");
        try {
            // Cache runtime reference to ensure consistency
            const runtime = this.runtime;
            if (!runtime?.agentId) {
                logger.log("Runtime not available, skipping tweet generation");
                return;
            }

            await runtime.ensureUserExists(
                runtime.agentId,
                runtime.getSetting("TWITTER_USERNAME"),
                runtime.character.name,
                "twitter"
            );

            // Check runtime again before proceeding
            if (this.isShutdown || !runtime?.agentId) {
                logger.log("Runtime no longer available after user check");
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
                if (this.isShutdown || !runtime?.agentId) {
                    logger.log("Runtime no longer available before timeline fetch");
                    return;
                }
                homeTimeline = await this.fetchHomeTimeline(50);
                fs.writeFileSync(
                    "tweetcache/home_timeline.json",
                    JSON.stringify(homeTimeline, null, 2)
                );
            }

            // Check runtime before formatting timeline
            if (this.isShutdown || !runtime?.agentId) {
                logger.log("Runtime no longer available after timeline fetch");
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
            if (this.isShutdown || !runtime?.agentId) {
                logger.log("Runtime no longer available before state composition");
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
                        runtime.getSetting("TWITTER_USERNAME"),
                    timeline: formattedHomeTimeline,
                }
            );

            // Check runtime before context generation
            if (this.isShutdown || !runtime?.agentId) {
                logger.log("Runtime no longer available before context generation");
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
                `${runtime.getSetting("TWITTER_USERNAME")}_${datestr}_generate_context`,
                context
            );

            // Check runtime before text generation
            if (this.isShutdown || !runtime?.agentId) {
                logger.log("Runtime no longer available before text generation");
                return;
            }

            const newTweetContent = await generateText({
                runtime,
                context,
                modelClass: ModelClass.SMALL,
            });

            // Final runtime check before sending tweet
            if (this.isShutdown || !runtime?.agentId) {
                logger.log("Runtime no longer available before sending tweet");
                return;
            }

            logger.log("New Tweet:", newTweetContent);
            log_to_file(
                `${runtime.getSetting("TWITTER_USERNAME")}_${datestr}_generate_response`,
                JSON.stringify(newTweetContent)
            );

            const slice = newTweetContent.replaceAll(/\\n/g, "\n").trim();
            const content = slice;

            // Send the new tweet
            if (!this.dryRun) {
                try {
                    // Final check before API call
                    if (this.isShutdown || !runtime?.agentId) {
                        logger.log("Runtime no longer available before API call");
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
                    if (this.isShutdown || !runtime?.agentId || !runtime.messageManager) {
                        logger.log("Runtime no longer available after tweet sent");
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
                        permanentUrl: `https://twitter.com/${runtime.getSetting("TWITTER_USERNAME")}/status/${tweetResult.rest_id}`,
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
                    if (this.isShutdown || !runtime?.agentId || !runtime.messageManager) {
                        logger.log("Runtime no longer available before memory creation");
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
                        username: runtime?.getSetting("TWITTER_USERNAME"),
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
                agentId: this.runtime?.agentId,
                username: this.runtime?.getSetting("TWITTER_USERNAME"),
                errorMessage: error.message,
                errorStack: error.stack,
                timestamp: new Date().toISOString(),
                error: error
            });
        }
    }

    public shutdown(): Promise<void> {
        this.isShutdown = true;
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
