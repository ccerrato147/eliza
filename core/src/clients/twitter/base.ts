/**
 * Twitter Client Base Class
 * 
 * A foundational class that handles Twitter API interactions for AI agents.
 * Key features:
 * - Twitter authentication and session management
 * - Tweet fetching, caching, and search functionality
 * - Integration with agent memory system
 * - Request queue with rate limiting and backoff
 * - Conversion of Twitter data to agent-compatible memories
 * 
 * This base class can be extended for specific Twitter client implementations
 * while handling common concerns like rate limiting, caching, and data persistence.
 */

import {
    QueryTweetsResponse,
    Scraper,
    SearchMode,
    Tweet,
} from "agent-twitter-client";
import { EventEmitter } from "events";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { embeddingZeroVector } from "../../core/memory.ts";
import {
    Content,
    IAgentRuntime,
    Memory,
    State,
    UUID,
} from "../../core/types.ts";
import ImageDescriptionService from "../../services/image.ts";

import { glob } from "glob";

import { stringToUuid } from "../../core/uuid.ts";
import logger from "../../core/logger.ts";

interface TwitterCookie {
    key: string;
    value: string;
    domain: string;
    path: string;
    secure: boolean;
    httpOnly: boolean;
    sameSite?: string;
}

export function extractAnswer(text: string): string {
    const startIndex = text.indexOf("Answer: ") + 8;
    const endIndex = text.indexOf("<|endoftext|>", 11);
    return text.slice(startIndex, endIndex);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class RequestQueue {
    private queue: (() => Promise<any>)[] = [];
    private processing: boolean = false;

    async add<T>(request: () => Promise<T>): Promise<T> {
        return new Promise((resolve, reject) => {
            this.queue.push(async () => {
                try {
                    const result = await request();
                    resolve(result);
                } catch (error) {
                    reject(error);
                }
            });
            this.processQueue();
        });
    }

    private async processQueue(): Promise<void> {
        if (this.processing || this.queue.length === 0) {
            return;
        }
        this.processing = true;

        while (this.queue.length > 0) {
            const request = this.queue.shift()!;
            try {
                await request();
            } catch (error) {
                logger.error("Error processing request", {
                    severity: 'ERROR',
                    method: 'base.RequestQueue.processQueue',
                    queueLength: this.queue.length,
                    errorMessage: error.message,
                    errorStack: error.stack,
                    timestamp: new Date().toISOString(),
                    error: error
                });
                this.queue.unshift(request);
                const backoffDelay = Math.pow(2, this.queue.length) * 1000;
                logger.log("Request failed, applying exponential backoff", {
                    severity: 'WARN',
                    method: 'base.RequestQueue.processQueue',
                    queueLength: this.queue.length,
                    backoffDelay: `${backoffDelay/1000} seconds`,
                    retryCount: this.queue.length,
                    errorMessage: error.message,
                    errorStack: error.stack,
                    timestamp: new Date().toISOString(),
                    error: error
                });
                await this.exponentialBackoff(this.queue.length);
            }
            await this.randomDelay();
        }

        this.processing = false;
    }

    private async exponentialBackoff(retryCount: number): Promise<void> {
        const delay = Math.pow(2, retryCount) * 1000;
        await new Promise((resolve) => setTimeout(resolve, delay));
    }

    private async randomDelay(): Promise<void> {
        const delay = Math.floor(Math.random() * 2000) + 1500;
        await new Promise((resolve) => setTimeout(resolve, delay));
    }

    async shutdown(): Promise<void> {
        return this.processQueue();
    }
}

export class ClientBase extends EventEmitter {
    twitterClient: Scraper;
    runtime: IAgentRuntime;
    directions: string;
    lastCheckedTweetId: number | null = null;
    tweetCacheFilePath = "tweetcache/latest_checked_tweet_id.txt";
    imageDescriptionService: ImageDescriptionService;
    temperature: number = 0.5;
    dryRun: boolean = false;
    protected isShutdown: boolean = false;

    private tweetCache: Map<string, Tweet> = new Map();
    requestQueue: RequestQueue = new RequestQueue();
    twitterUserId: string;

    async cacheTweet(tweet: Tweet): Promise<void> {
        if (!tweet) {
            logger.warn("Tweet is undefined, skipping cache");
            return;
        }
        const cacheDir = path.join(
            __dirname,
            "../../../tweetcache",
            this.runtime.agentId,
            tweet.conversationId,
            `${tweet.id}.json`
        );
        await fs.promises.mkdir(path.dirname(cacheDir), { recursive: true });
        await fs.promises.writeFile(cacheDir, JSON.stringify(tweet, null, 2));
        this.tweetCache.set(tweet.id, tweet);
    }

    async getCachedTweet(tweetId: string): Promise<Tweet | undefined> {
        if (this.tweetCache.has(tweetId)) {
            return this.tweetCache.get(tweetId);
        }

        const cacheFile = path.join(
            __dirname,
            "tweetcache",
            "*",
            `${tweetId}.json`
        );
        const files = await glob(cacheFile);
        if (files.length > 0) {
            const tweetData = await fs.promises.readFile(files[0], "utf-8");
            const tweet = JSON.parse(tweetData) as Tweet;
            this.tweetCache.set(tweet.id, tweet);
            return tweet;
        }

        return undefined;
    }

    async getTweet(tweetId: string): Promise<Tweet> {
        const cacheDir = path.join(
            __dirname,
            "../../../tweetcache",
            this.runtime.agentId,
            `${tweetId}.json`
        );

        // Check cache first
        if (fs.existsSync(cacheDir)) {
            const cachedTweet = JSON.parse(await fs.promises.readFile(cacheDir, 'utf-8'));
            return cachedTweet;
        }

        const tweet = await this.requestQueue.add(() =>
            this.twitterClient.getTweet(tweetId)
        );
        await this.cacheTweet(tweet);
        return tweet;
    }

    callback: (self: ClientBase) => any = null;

    onReady() {
        throw new Error(
            "Not implemented in base class, please call from subclass"
        );
    }

    constructor({ runtime }: { runtime: IAgentRuntime }) {
        super();
        this.runtime = runtime;
        this.twitterClient = new Scraper();
        
        this.dryRun =
            this.runtime.getSetting("TWITTER_DRY_RUN")?.toLowerCase() ===
            "true";
        
        // Add null checks and default empty arrays for style properties
        const allStyles = this.runtime.character.style?.all || [];
        const postStyles = this.runtime.character.style?.post || [];
        
        this.directions = allStyles.length || postStyles.length
            ? `- ${allStyles.join("\n- ")}\n- ${postStyles.join("\n- ")}`
            : "";

        try {
            if (fs.existsSync(this.tweetCacheFilePath)) {
                const data = fs.readFileSync(this.tweetCacheFilePath, "utf-8");
                this.lastCheckedTweetId = parseInt(data.trim());
            } else {
                logger.warn("Tweet cache file not found.");
            }
        } catch (error) {
            logger.error("Error loading latest checked tweet ID from file:", error);
        }
        const cookiesFilePath = path.join(
            __dirname,
            "../../../tweetcache/" +
                this.runtime.getSetting("TWITTER_USERNAME") +
                "_cookies.json"
        );

        const dir = path.dirname(cookiesFilePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        // async initialization
        (async () => {
            try {
                // Check for Twitter cookies
                if (this.runtime.getSetting("TWITTER_COOKIES")) {
                    const cookiesArray = JSON.parse(
                        this.runtime.getSetting("TWITTER_COOKIES")
                    );
                    await this.setCookiesFromArray(cookiesArray);
                    await this.saveCookiesToDatabase(cookiesArray);
                } else {
                    const savedCookies = await this.loadCookiesFromDatabase();
                    if (savedCookies) {
                        await this.setCookiesFromArray(savedCookies);
                    } else {
                        try {
                            await this.twitterClient.login(
                                this.runtime.getSetting("TWITTER_USERNAME"),
                                this.runtime.getSetting("TWITTER_PASSWORD"),
                                this.runtime.getSetting("TWITTER_EMAIL")
                            );
                            logger.log("Logged in to Twitter");
                            const cookies = await this.twitterClient.getCookies();
                            const cookiesArray = cookies.map(cookie => ({
                                key: cookie.key,
                                value: cookie.value,
                                domain: '.twitter.com',
                                path: '/',
                                secure: true,
                                httpOnly: true,
                                sameSite: 'Lax'
                            }));
                            await this.saveCookiesToDatabase(cookiesArray);
                        } catch (error) {
                            logger.error("Failed to login to Twitter:", error);
                            this.emit('loginError', error);
                            return;
                        }
                    }
                }

                let loginAttempts = 0;
                const getRetryDelay = (attempt: number): number => {
                    switch (attempt) {
                        case 0: return 10 * 1000;        // 10 seconds
                        case 1: return 60 * 1000;        // 1 minute
                        case 2: return 10 * 60 * 1000;   // 10 minutes
                        case 3: return 30 * 60 * 1000;   // 30 minutes
                        default: return 60 * 60 * 1000;  // 1 hour
                    }
                };

                while (!(await this.twitterClient.isLoggedIn())) {
                    const delay = getRetryDelay(loginAttempts);
                    logger.log(`Login attempt ${loginAttempts + 1} failed. Waiting ${delay/1000} seconds before retrying...`);
                    await new Promise((resolve) => setTimeout(resolve, delay));
                    
                    try {
                        await this.twitterClient.login(
                            this.runtime.getSetting("TWITTER_USERNAME"),
                            this.runtime.getSetting("TWITTER_PASSWORD"),
                            this.runtime.getSetting("TWITTER_EMAIL")
                        );
                        const cookies = await this.twitterClient.getCookies();
                        const cookiesArray = cookies.map(cookie => ({
                            key: cookie.key,
                            value: cookie.value,
                            domain: '.twitter.com',
                            path: '/',
                            secure: true,
                            httpOnly: true,
                            sameSite: 'Lax'
                        }));
                        await this.saveCookiesToDatabase(cookiesArray);
                        logger.log("Successfully logged in to Twitter after retrying");
                    } catch (error) {
                        logger.error(`Login retry attempt ${loginAttempts + 1} failed:`, error);
                    }
                    
                    loginAttempts++;
                }

                const userId = await this.requestQueue.add(async () => {
                    // wait 3 seconds before getting the user id
                    await new Promise((resolve) => setTimeout(resolve, 10000));
                    try {
                        return await this.twitterClient.getUserIdByScreenName(
                            this.runtime.getSetting("TWITTER_USERNAME")
                        );
                    } catch (error) {
                        logger.error("Error getting user ID:", {
                            severity: 'ERROR',
                            method: 'base.ClientBase.getUserIdByScreenName',
                            agentId: this.runtime.agentId,
                            username: this.runtime.getSetting("TWITTER_USERNAME"),
                            errorMessage: error.message,
                            errorStack: error.stack,
                            timestamp: new Date().toISOString(),
                            error: error
                        });
                        return null;
                    }
                });
                if (!userId) {
                    logger.error("Failed to get user ID");
                    return;
                }
                logger.log("Twitter user ID:", userId);
                this.twitterUserId = userId;

                await this.populateTimeline();

                this.onReady();
            } catch (error) {
                logger.error("Error during Twitter client initialization:", {
                    severity: 'ERROR',
                    method: 'base.ClientBase.constructor',
                    agentId: this.runtime.agentId,
                    errorMessage: error.message,
                    errorStack: error.stack,
                    timestamp: new Date().toISOString(),
                    error: error
                });
                this.emit('initializationError', error);
            }
        })();
    }

    async fetchHomeTimeline(count: number): Promise<Tweet[]> {
        const homeTimeline = await this.twitterClient.fetchHomeTimeline(
            count,
            []
        );

        return homeTimeline
            .filter((t) => t.__typename !== "TweetWithVisibilityResults")
            .map((tweet) => {
                logger.log("tweet is", tweet);
                const obj = {
                    id: tweet.rest_id,
                    name:
                        tweet.name ??
                        tweet.core?.user_results?.result?.legacy.name,
                    username:
                        tweet.username ??
                        tweet.core?.user_results?.result?.legacy.screen_name,
                    text: tweet.text ?? tweet.legacy?.full_text,
                    inReplyToStatusId:
                        tweet.inReplyToStatusId ??
                        tweet.legacy?.in_reply_to_status_id_str,
                    createdAt: tweet.createdAt ?? tweet.legacy?.created_at,
                    userId: tweet.userId ?? tweet.legacy?.user_id_str,
                    conversationId:
                        tweet.conversationId ??
                        tweet.legacy?.conversation_id_str,
                    hashtags: tweet.hashtags ?? tweet.legacy?.entities.hashtags,
                    mentions:
                        tweet.mentions ?? tweet.legacy?.entities.user_mentions,
                    photos:
                        tweet.photos ??
                        tweet.legacy?.entities.media?.filter(
                            (media) => media.type === "photo"
                        ) ??
                        [],
                    thread: [],
                    urls: tweet.urls ?? tweet.legacy?.entities.urls,
                    videos:
                        tweet.videos ??
                        tweet.legacy?.entities.media?.filter(
                            (media) => media.type === "video"
                        ) ??
                        [],
                };

                logger.log("obj is", obj);

                return obj;
            });
    }

    async fetchSearchTweets(
        query: string,
        maxTweets: number,
        searchMode: SearchMode,
        cursor?: string
    ): Promise<QueryTweetsResponse> {
        try {
            // Sometimes this fails because we are rate limited. in this case, we just need to return an empty array
            // if we dont get a response in 5 seconds, something is wrong
            const timeoutPromise = new Promise((resolve) =>
                setTimeout(() => resolve({ tweets: [] }), 10000)
            );

            try {
                const result = await this.requestQueue.add(
                    async () =>
                        await Promise.race([
                            this.twitterClient.fetchSearchTweets(
                                query,
                                maxTweets,
                                searchMode,
                                cursor
                            ),
                            timeoutPromise,
                        ])
                );
                return (result ?? { tweets: [] }) as QueryTweetsResponse;
            } catch (error) {
                logger.error("Error fetching search tweets:", {
                    severity: 'ERROR',
                    method: 'base.ClientBase.fetchSearchTweets',
                    agentId: this.runtime.agentId,
                    query,
                    maxTweets,
                    searchMode,
                    errorMessage: error.message,
                    errorStack: error.stack,
                    timestamp: new Date().toISOString(),
                    error: error
                });
                return { tweets: [] };
            }
        } catch (error) {
            logger.error("Error fetching search tweets:", error);
            return { tweets: [] };
        }
    }

    private async populateTimeline() {
        const cacheFile = "timeline_cache.json";

        // Check if the cache file exists
        if (fs.existsSync(cacheFile)) {
            // Read the cached search results from the file
            const cachedResults = JSON.parse(
                fs.readFileSync(cacheFile, "utf-8")
            );

            // Get the existing memories from the database
            const existingMemories =
                await this.runtime.messageManager.getMemoriesByRoomIds({
                    agentId: this.runtime.agentId,
                    roomIds: cachedResults.map((tweet) =>
                        stringToUuid(tweet.conversationId + "-" + this.runtime.agentId)
                    ),
                });

            // Create a Set to store the IDs of existing memories
            const existingMemoryIds = new Set(
                existingMemories.map((memory) => memory.id.toString())
            );

            // Check if any of the cached tweets exist in the existing memories
            const someCachedTweetsExist = cachedResults.some((tweet) =>
                existingMemoryIds.has(tweet.id)
            );

            if (someCachedTweetsExist) {
                // Filter out the cached tweets that already exist in the database
                const tweetsToSave = cachedResults.filter(
                    (tweet) => !existingMemoryIds.has(tweet.id)
                );

                // Save the missing tweets as memories
                for (const tweet of tweetsToSave) {
                    const roomId = stringToUuid(
                        tweet.conversationId ??
                            "default-room-" + this.runtime.agentId
                    );
                    const tweetuserId =
                        tweet.userId === this.twitterUserId
                            ? this.runtime.agentId
                            : stringToUuid(tweet.userId);

                    await this.runtime.ensureConnection(
                        tweetuserId,
                        roomId,
                        tweet.username,
                        tweet.name,
                        "twitter"
                    );

                    const content = {
                        text: tweet.text,
                        url: tweet.permanentUrl,
                        source: "twitter",
                        inReplyTo: tweet.inReplyToStatusId
                            ? stringToUuid(tweet.inReplyToStatusId + "-" + this.runtime.agentId)
                            : undefined,
                    } as Content;

                    logger.log("Creating memory for tweet", tweet.id);

                    // check if it already exists
                    const memory =
                        await this.runtime.messageManager.getMemoryById(
                            stringToUuid(tweet.id + "-" + this.runtime.agentId)
                        );
                    if (memory) {
                        logger.log(
                            "Memory already exists, skipping timeline population"
                        );
                        break;
                    }

                    await this.runtime.messageManager.createMemory({
                        id: stringToUuid(tweet.id + "-" + this.runtime.agentId),
                        userId: tweetuserId,
                        content: content,
                        agentId: this.runtime.agentId,
                        roomId,
                        embedding: embeddingZeroVector,
                        createdAt: tweet.timestamp * 1000,
                    });
                }

                logger.log(
                    `Populated ${tweetsToSave.length} missing tweets from the cache.`
                );
                return;
            }
        }

        // Get the most recent 20 mentions and interactions
        const mentionsAndInteractions = await this.fetchSearchTweets(
            `@${this.runtime.getSetting("TWITTER_USERNAME")}`,
            20,
            SearchMode.Latest
        );

        // Combine the timeline tweets and mentions/interactions
        const allTweets = [...mentionsAndInteractions.tweets];

        // Create a Set to store unique tweet IDs
        const tweetIdsToCheck = new Set<string>();

        // Add tweet IDs to the Set
        for (const tweet of allTweets) {
            tweetIdsToCheck.add(tweet.id);
        }

        // Convert the Set to an array of UUIDs
        const tweetUuids = Array.from(tweetIdsToCheck).map((id) =>
            stringToUuid(id + "-" + this.runtime.agentId)
        );

        // Check the existing memories in the database
        const existingMemories =
            await this.runtime.messageManager.getMemoriesByRoomIds({
                agentId: this.runtime.agentId,
                roomIds: tweetUuids,
            });

        // Create a Set to store the existing memory IDs
        const existingMemoryIds = new Set<UUID>(
            existingMemories.map((memory) => memory.roomId)
        );

        // Filter out the tweets that already exist in the database
        const tweetsToSave = allTweets.filter(
            (tweet) => !existingMemoryIds.has(stringToUuid(tweet.id + "-" + this.runtime.agentId))
        );

        await this.runtime.ensureUserExists(
            this.runtime.agentId,
            this.runtime.getSetting("TWITTER_USERNAME"),
            this.runtime.character.name,
            "twitter"
        );

        // Save the new tweets as memories
        for (const tweet of tweetsToSave) {
            const roomId = stringToUuid(
                tweet.conversationId ?? "default-room-" + this.runtime.agentId
            );
            const tweetuserId =
                tweet.userId === this.twitterUserId
                    ? this.runtime.agentId
                    : stringToUuid(tweet.userId);

            await this.runtime.ensureConnection(
                tweetuserId,
                roomId,
                tweet.username,
                tweet.name,
                "twitter"
            );

            const content = {
                text: tweet.text,
                url: tweet.permanentUrl,
                source: "twitter",
                inReplyTo: tweet.inReplyToStatusId
                    ? stringToUuid(tweet.inReplyToStatusId)
                    : undefined,
            } as Content;

            await this.runtime.messageManager.createMemory({
                id: stringToUuid(tweet.id + "-" + this.runtime.agentId),
                userId: tweetuserId,
                content: content,
                agentId: this.runtime.agentId,
                roomId,
                embedding: embeddingZeroVector,
                createdAt: tweet.timestamp * 1000,
            });
        }

        // Cache the search results to the file
        fs.writeFileSync(cacheFile, JSON.stringify(allTweets));
    }

    async setCookiesFromArray(cookiesArray: TwitterCookie[]) {
        const cookieStrings = cookiesArray.map(
            (cookie) =>
                `${cookie.key}=${cookie.value}; Domain=${cookie.domain}; Path=${cookie.path}; ${
                    cookie.secure ? "Secure" : ""
                }; ${cookie.httpOnly ? "HttpOnly" : ""}; SameSite=${
                    cookie.sameSite || "Lax"
                }`
        );
        await this.twitterClient.setCookies(cookieStrings);
    }

    private async saveCookiesToDatabase(cookies: TwitterCookie[]) {
        const memory: Memory = {
            id: stringToUuid(`twitter-cookies-${this.runtime.agentId}`),
            userId: this.runtime.agentId,
            content: {
                type: 'twitter-cookies',
                cookies: cookies,
                text: `Twitter authentication cookies storage for ${this.runtime.character.name}`,
            },
            agentId: this.runtime.agentId,
            roomId: stringToUuid(`twitter-system-${this.runtime.agentId}`),
            embedding: embeddingZeroVector,
            createdAt: Date.now()
        };

        await this.runtime.messageManager.createMemory(memory);
    }

    private async loadCookiesFromDatabase(): Promise<TwitterCookie[] | null> {
        const memories = await this.runtime.messageManager.getMemories({
            roomId: stringToUuid(`twitter-system-${this.runtime.agentId}`),
            count: 1,
            agentId: this.runtime.agentId
        });

        const cookieMemory = memories.find(m => 
            m.content.type === 'twitter-cookies' && 
            Array.isArray(m.content.cookies) &&
            m.content.cookies.length > 0
        );

        return (cookieMemory?.content.cookies as TwitterCookie[]) || null;
    }

    async saveRequestMessage(message: Memory, state: State) {
        if (message.content.text) {
            const recentMessage = await this.runtime.messageManager.getMemories(
                {
                    roomId: message.roomId,
                    agentId: this.runtime.agentId,
                    count: 1,
                    unique: false,
                }
            );

            if (
                recentMessage.length > 0 &&
                recentMessage[0].content === message.content
            ) {
                logger.log("Message already saved", recentMessage[0].id);
            } else {
                await this.runtime.messageManager.createMemory({
                    ...message,
                    embedding: embeddingZeroVector,
                });
            }

            await this.runtime.evaluate(message, {
                ...state,
                twitterClient: this.twitterClient,
            });
        }
    }

    /**
     * Gracefully shuts down the Twitter client and cleans up resources
     */
    async shutdown(): Promise<void> {
        if (this.isShutdown) {
            return;
        }
        
        this.isShutdown = true;
        logger.log("Starting Twitter client shutdown...");
        
        // Clear event listeners
        this.removeAllListeners();
        
        // Wait for any pending requests in the queue to complete
        if (this.requestQueue) {
            // Add a timeout to prevent infinite waiting
            const timeout = new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Queue processing timeout')), 30000)
            );
            
            try {
                await Promise.race([
                    this.requestQueue.shutdown(),
                    timeout
                ]);
            } catch (error) {
                logger.warn("Request queue shutdown timed out:", {
                    method: 'base.ClientBase.shutdown',
                    agentId: this.runtime?.agentId,
                    error: error
                });
            }
            
            // Clear the queue
            this.requestQueue = new RequestQueue();
        }
        
        // Clear tweet cache
        this.tweetCache.clear();
        
        // Emit shutdown event before nullifying runtime
        this.emit('shutdown');
        
        // Nullify references to allow garbage collection
        this.twitterClient = null;
        this.runtime = null;
        this.imageDescriptionService = null;
        
        logger.log("Twitter client shutdown complete");
    }
}
