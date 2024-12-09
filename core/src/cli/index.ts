import defaultCharacter from "../core/defaultCharacter.ts";
import settings from "../core/settings.ts";
import { Character, IAgentRuntime, ModelProvider } from "../core/types.ts";
import * as Action from "../actions/index.ts";
import * as Client from "../clients/index.ts";
import * as Adapter from "../adapters/index.ts";
import * as Provider from "../providers/index.ts";
import yargs from "yargs";
import { wait } from "../clients/twitter/utils.ts";

import fs from "fs";
import Database from "better-sqlite3";
import { AgentRuntime } from "../core/runtime.ts";
import { defaultActions } from "../core/actions.ts";
import { Arguments } from "../types/index.ts";
import { loadActionConfigs, loadCustomActions } from "./config.ts";
import dotenv from "dotenv";
import logger from "../core/logger.ts";

// Load .env file
dotenv.config();

export async function initializeClients(
    character: Character,
    runtime: IAgentRuntime
) {
    const clients = [];
    const clientTypes =
        character.clients?.map((str) => str.toLowerCase()) || [];

    if (clientTypes.includes("discord")) {
        clients.push(startDiscord(runtime));
    }

    if (clientTypes.includes("telegram")) {
        const telegramClient = await startTelegram(runtime, character);
        if (telegramClient) clients.push(telegramClient);
    }

    if (clientTypes.includes("twitter")) {
        const twitterClients = await startTwitter(runtime);
        clients.push(...twitterClients);
    }

    return clients;
}

export function parseArguments(): Arguments {
    try {
        return yargs(process.argv.slice(2))
            .option("character", {
                type: "string",
                description: "Path to the character JSON file",
            })
            .option("characters", {
                type: "string",
                description:
                    "Comma separated list of paths to character JSON files",
            })
            .option("telegram", {
                type: "boolean",
                description: "Enable Telegram client",
                default: false,
            })
            .parseSync() as Arguments;
    } catch (error) {
        logger.error("Error parsing arguments:", error);
        return {};
    }
}

async function fetchCharacter(uuid: string, apiKey: string): Promise<Character | null> {
    const charactersURL = process.env.CHARACTERS_URL;
    try {
        const response = await fetch(`${charactersURL}/${uuid}`, {
            headers: {
                'x-api-key': apiKey
            }
        });
        
        if (!response.ok) {
            logger.error(`Error fetching character ${uuid}: ${response.statusText}`);
            return null;
        }
        
        const data = await response.json();
        
        // Map the character data to match the expected structure
        const mappedCharacter: Character = {
            name: data.name || '',
            id: data.id,
            modelProvider: data.modelProvider ? 
                ModelProvider[data.modelProvider.toUpperCase() as keyof typeof ModelProvider] : 
                ModelProvider.OPENAI,
            clients: Array.isArray(data.clients) ? data.clients : [],
            settings: {
                secrets: data.settings?.secrets || {},
                voice: data.settings?.voice || {}
            },
            system: data.system || '',
            bio: Array.isArray(data.bio) ? data.bio : [],
            lore: Array.isArray(data.lore) ? data.lore : [],
            messageExamples: Array.isArray(data.messageExamples) ? data.messageExamples : [],
            postExamples: Array.isArray(data.postExamples) ? data.postExamples : [],
            topics: Array.isArray(data.topics) ? data.topics : [],
            style: {
                all: Array.isArray(data.style?.all) ? data.style.all : [],
                chat: Array.isArray(data.style?.chat) ? data.style.chat : [],
                post: Array.isArray(data.style?.post) ? data.style.post : []
            },
            adjectives: Array.isArray(data.adjectives) ? data.adjectives : [],
            people: Array.isArray(data.people) ? data.people : [],
            nicknames: data.nicknames || {},
            phrases: data.phrases || {}
        };
        
        return mappedCharacter;
    } catch (e) {
        logger.error(`Error fetching character ${uuid}:`, e);
        return null;
    }
}

export async function loadCharacters(charactersArg: string): Promise<Character[]> {
    const apiKey = process.env.CHARACTERS_API_KEY;
    if (!apiKey) {
        logger.error('CHARACTERS_API_KEY not found in environment variables');
        logger.log('Falling back to default character');
        return [defaultCharacter];
    }

    const characterIds = charactersArg?.split(',').map(id => id.trim()) || [];
    const loadedCharacters: Character[] = [];

    if (characterIds.length > 0) {
        const characterPromises = characterIds.map(id => fetchCharacter(id, apiKey));
        const characters = await Promise.all(characterPromises);
        
        loadedCharacters.push(...characters.filter((char): char is Character => char !== null));
    }

    if (loadedCharacters.length === 0) {
        logger.log('No characters found or failed to load, using default character');
        loadedCharacters.push(defaultCharacter);
    }

    return loadedCharacters;
}

export function getTokenForProvider(
    provider: ModelProvider,
    character: Character
) {
    switch (provider) {
        case ModelProvider.OPENAI:
            return (
                character.settings?.secrets?.OPENAI_API_KEY ||
                settings.OPENAI_API_KEY
            );
        case ModelProvider.ANTHROPIC:
            return (
                character.settings?.secrets?.ANTHROPIC_API_KEY ||
                character.settings?.secrets?.CLAUDE_API_KEY ||
                settings.ANTHROPIC_API_KEY ||
                settings.CLAUDE_API_KEY
            );
        case ModelProvider.REDPILL:
            return (
                character.settings?.secrets?.REDPILL_API_KEY ||
                settings.REDPILL_API_KEY
            );
        case ModelProvider.GOOGLE:
            return(
                character.settings?.secrets?.GOOGLE_GENERATIVE_AI_API_KEY ||
                settings.GOOGLE_GENERATIVE_AI_API_KEY
            );
    }
}
// Function to initialize and return the appropriate database adapter based on configuration
export function initializeDatabase() {
    // Check if a Postgres connection URL is provided in environment variables
    if (process.env.POSTGRES_URL) {
        // If Postgres URL exists, create and return a Postgres database adapter
        // with the connection string from environment variables
        return new Adapter.PostgresDatabaseAdapter({
            connectionString: process.env.POSTGRES_URL,
        });
    } else {
        // If no Postgres URL is provided, fall back to SQLite
        // Create and return a SQLite database adapter with a local db.sqlite file
        return new Adapter.SqliteDatabaseAdapter(new Database("./db.sqlite"));
    }
}

export async function createAgentRuntime(
    character: Character,
    db: any,
    token: string,
    configPath: string = "./elizaConfig.yaml"
) {
    const actionConfigs = loadActionConfigs(configPath);
    const customActions = await loadCustomActions(actionConfigs);

    logger.log("Creating runtime for character", character.name);

    return new AgentRuntime({
        databaseAdapter: db,
        token,
        modelProvider: character.modelProvider,
        evaluators: [],
        character,
        providers: [Provider.timeProvider, Provider.boredomProvider],
        actions: [
            // Default actions
            ...defaultActions,

            // Custom actions
            Action.followRoom,
            Action.unfollowRoom,
            Action.unmuteRoom,
            Action.muteRoom,
            Action.imageGeneration,

            // imported from elizaConfig.yaml
            ...customActions,
        ],
    });
}

export async function createDirectRuntime(
    character: Character,
    db: any,
    token: string,
    configPath: string = "./elizaConfig.yaml"
) {
    const actionConfigs = loadActionConfigs(configPath);
    const customActions = await loadCustomActions(actionConfigs);

    logger.log("Creating runtime for character", character.name);
    return new AgentRuntime({
        databaseAdapter: db,
        token,
        modelProvider: character.modelProvider,
        evaluators: [],
        character,
        providers: [
            Provider.timeProvider,
            Provider.boredomProvider,
            character.settings?.secrets?.WALLET_PUBLIC_KEY &&
                Provider.walletProvider,
        ].filter(Boolean),
        actions: [
            ...defaultActions,
            // Custom actions
            Action.followRoom,
            Action.unfollowRoom,
            Action.unmuteRoom,
            Action.muteRoom,
            Action.imageGeneration,

            // imported from elizaConfig.yaml
            ...customActions,
        ],
    });
}

export function startDiscord(runtime: IAgentRuntime) {
    return new Client.DiscordClient(runtime);
}

export async function startTelegram(
    runtime: IAgentRuntime,
    character: Character
) {
    logger.log("🔍 Attempting to start Telegram bot...");
    const botToken = runtime.getSetting("TELEGRAM_BOT_TOKEN");

    if (!botToken) {
        logger.error(
            `❌ Telegram bot token is not set for character ${character.name}.`
        );
        return null;
    }

    try {
        const telegramClient = new Client.TelegramClient(runtime, botToken);
        await telegramClient.start();
        logger.log(
            `✅ Telegram client successfully started for character ${character.name}`
        );
        return telegramClient;
    } catch (error) {
        logger.error(
            `❌ Error creating/starting Telegram client for ${character.name}:`,
            error
        );
        return null;
    }
}

export async function startTwitter(runtime: IAgentRuntime) {
    logger.log("Starting Twitter clients...");
    const twitterSearchClient = new Client.TwitterSearchClient(runtime);
    await wait();
    const twitterInteractionClient = new Client.TwitterInteractionClient(
        runtime
    );
    await wait();
    const twitterGenerationClient = new Client.TwitterGenerationClient(runtime);

    return [
        twitterInteractionClient,
        twitterSearchClient,
        twitterGenerationClient,
    ];
}
