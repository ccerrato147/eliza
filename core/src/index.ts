/**
 * Core exports for the Eliza system.
 * Provides access to actions, clients, adapters, and providers.
 */
export * from "./actions/index.ts";
export * from "./clients/index.ts";
export * from "./adapters/index.ts";
export * from "./providers/index.ts";

import * as Client from "./clients/index.ts";
import { Character } from "./core/types.ts";
import { Arguments } from "./types/index.ts";
import {
    createAgentRuntime,
    getTokenForProvider,
    initializeClients,
    initializeDatabase,
    loadCharacters,
    parseArguments,
} from "./cli/index.ts";
import { PrettyConsole } from "./cli/colors.ts";
import logger from "./core/logger.ts";

// Configure logger
logger.configure({
    type: 'google-cloud',
    projectId: process.env.GOOGLE_PROJECT_ID,
    logName: process.env.GOOGLE_LOGS_NAME,
    keyFilename: process.env.GOOGLE_LOGGER_SERVICE_CREDENTIALS
});

// Initialize console
export const prettyConsole = new PrettyConsole();
prettyConsole.clear();
prettyConsole.closeByNewLine = true;
prettyConsole.useIcons = true;

/**
 * Main function to start the agent
 */
async function main() {
    // Parse command line arguments
    const argv: Arguments = parseArguments();
    
    if (!argv.character) {
        logger.error('No character provided. Please use --character parameter.');
        process.exit(1);
    }

    try {
        // Load character
        const characters = await loadCharacters(argv.character);
        
        if (!characters || characters.length === 0) {
            logger.error(`No character found for ID: ${argv.character}`);
            process.exit(1);
        }

        const character = characters[0]; // We only need the first character
        logger.log(`Starting agent for character ${character.name}`, 'green');

        // Initialize the agent
        const token = getTokenForProvider(character.modelProvider, character);
        const db = initializeDatabase();
        const runtime = await createAgentRuntime(character, db, token);
        const clients = await initializeClients(character, runtime);

        // Keep the process running
        process.on('SIGINT', async () => {
            logger.log('Received SIGINT. Gracefully shutting down...', 'yellow');
            // Add any cleanup needed for your agent here
            process.exit(0);
        });

        logger.log(`Agent ${character.name} is running`, 'green');
    } catch (error) {
        logger.error(`Failed to start agent: ${error.message}`);
        process.exit(1);
    }
}

// Run the main function
main().catch(error => {
    logger.error('Unexpected error:', error);
    process.exit(1);
});

// Log environment variables
console.log('Environment variables:');
console.log('POSTGRES_URL:', process.env.POSTGRES_URL);
console.log('Database connection string available:', !!process.env.POSTGRES_URL);


