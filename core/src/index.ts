/**
 * Core exports for the Eliza system.
 * Provides access to actions, clients, adapters, and providers.
 */
// Export core functionality for handling agent actions (message processing, commands, etc.)
export * from "./actions/index.ts";
// Export client implementations for different platforms (Discord, Direct, etc.)
export * from "./clients/index.ts";
// Export adapters for connecting to different services and APIs
export * from "./adapters/index.ts";
// Export providers for different AI models and services
export * from "./providers/index.ts";

// Import client implementations for direct messaging functionality
import * as Client from "./clients/index.ts";

// Import character type definition for agent configuration
import { Character } from "./core/types.ts";

// Import Node.js readline for interactive command-line interface
import readline from "readline";
// Import command-line argument type definitions
import { Arguments } from "./types/index.ts";
// Import core runtime and initialization functions
import {
    createAgentRuntime,     // Creates runtime environment for AI agents
    createDirectRuntime,    // Creates runtime for direct messaging
    getTokenForProvider,    // Retrieves API tokens for AI providers
    initializeClients,      // Sets up communication clients
    initializeDatabase,     // Sets up persistent storage
    loadCharacters,         // Loads character configurations
    parseArguments,         // Processes command-line arguments
} from "./cli/index.ts";
// Import console formatting utilities
import { PrettyConsole } from "./cli/colors.ts";

// Import fs and path modules for file operations
import fs from 'fs';
import path from 'path';

// Parse command line arguments and initialize configuration
let argv: Arguments = parseArguments();

/**
 * Pretty console instance for formatted output.
 * Configured with newline closing and icons enabled.
 */
export const prettyConsole = new PrettyConsole();
prettyConsole.clear();
prettyConsole.closeByNewLine = true;
prettyConsole.useIcons = true;

// Load characters - if argv.characters is undefined, loadCharacters will use defaultCharacter
let characters = await loadCharacters(argv.characters);

if (characters.length === 0) {
    prettyConsole.error("No characters could be loaded. Exiting...");
    process.exit(1);
}

const directClient = new Client.DirectClient();

// Start the direct client
const serverPort = parseInt(process.env.SERVER_PORT || "3000");
directClient.start(serverPort);

/**
 * Initializes and starts an agent for a given character.
 * @param character - The character configuration to create an agent for
 * @returns Promise containing initialized clients
 */
async function startAgent(character: Character) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] Starting agent for character ${character.name}\n`;
    
    // Ensure logs directory exists
    const logsDir = path.join(process.cwd(), 'logs');
    if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir);
    }
    
    // Append to log file
    fs.appendFileSync(path.join(logsDir, 'agents.log'), logMessage);
    
    prettyConsole.success(`Starting agent for character ${character.name}`);
    const token = getTokenForProvider(character.modelProvider, character);
    const db = initializeDatabase();

    // Create main runtime for handling interactions through various clients (Discord, Telegram, etc)
    const runtime = await createAgentRuntime(character, db, token);
    
    // Create separate runtime specifically for direct HTTP API interactions
    // This allows the agent to handle direct messages through the REST API endpoints
    // while keeping that logic separate from the main client integrations
    const directRuntime = createDirectRuntime(character, db, token);

    const clients = await initializeClients(character, runtime);
    directClient.registerAgent(await directRuntime);

    return clients;
}

/**
 * Initializes agents for all configured characters.
 * Iterates through the character list and starts individual agents.
 */
const startAgents = async () => {
    for (const character of characters) {
        await startAgent(character);
    }
};

startAgents();

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});

/**
 * Handles the interactive chat interface.
 * Provides a readline interface for user input and displays agent responses.
 * Supports 'exit' command to terminate the chat session.
 */
async function chat() {
    while (true) {
        const input = await new Promise<string>(resolve => {
            rl.question("You: ", resolve);
        });

        if (input.toLowerCase() === "exit") {
            rl.close();
            return;
        }

        const agentId = characters[0].name.toLowerCase();
        const response = await fetch(
            `http://localhost:3000/${agentId}/message`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    text: input,
                    userId: "user",
                    userName: "User",
                }),
            }
        );

        const data = await response.json();
        for (const message of data) {
            console.log(`${characters[0].name}: ${message.text}`);
        }
    }
}
console.log("Chat started. Type 'exit' to quit.");
chat();

