/**
 * Core exports for the Eliza system.
 * Provides access to actions, clients, adapters, and providers.
 */
export * from "./actions/index.ts";
export * from "./clients/index.ts";
export * from "./adapters/index.ts";
export * from "./providers/index.ts";

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
import { Character } from "./core/types.ts";

// Configure logger
// logger.configure({
//     type: 'google-cloud',
//     projectId: process.env.GOOGLE_PROJECT_ID,
//     logName: process.env.GOOGLE_LOGS_NAME,
//     keyFilename: process.env.GOOGLE_LOGGER_SERVICE_CREDENTIALS
// });

// Initialize console
export const prettyConsole = new PrettyConsole();
prettyConsole.clear();
prettyConsole.closeByNewLine = true;
prettyConsole.useIcons = true;

/**
 * Initialize and start an agent for a given character
 */
async function startAgent(character: Character) {
    logger.log(`Starting agent for character ${character.name}`, 'green');

    try {
        const token = getTokenForProvider(character.modelProvider, character);
        const db = initializeDatabase();
        const runtime = await createAgentRuntime(character, db, token);
        await initializeClients(character, runtime);
        logger.log(`Agent ${character.name} is running`, 'green');
    } catch (error) {
        logger.error(`Failed to start agent for character ${character.name}:`, error);
        throw error;
    }
}

/**
 * Main function to start the agent(s)
 */
async function main() {
    logger.log('Application starting...', 'info');
    
    try {
        const argv: Arguments = parseArguments();
        logger.log('Arguments parsed successfully: ' + JSON.stringify(argv), 'info');
        
        // Support both --character and --characters parameters
        const characterIds = argv.characters || argv.character;
        if (!characterIds) {
            logger.error('No characters provided. Please use --character or --characters parameter.');
            process.exit(1);
        }

        logger.log('Attempting to load characters...', 'info');
        const characters = await loadCharacters(characterIds).catch(e => {
            logger.error('Error loading characters: ' + e);
            throw e;
        });
        
        if (!characters || characters.length === 0) {
            logger.error(`No characters found for IDs: ${characterIds}`);
            process.exit(1);
        }

        // Start all agents in parallel
        logger.log(`Starting ${characters.length} agent(s)...`, 'info');
        await Promise.all(characters.map(startAgent));

        // Keep the process running
        process.on('SIGINT', async () => {
            logger.log('Received SIGINT. Gracefully shutting down...', 'yellow');
            // Add any cleanup needed for your agents here
            process.exit(0);
        });

        logger.log(`All agents are running`, 'green');
    } catch (error) {
        // Create a structured error log entry with metadata
        const errorData = {
            severity: 'ERROR',
            message: error.message,
            stack: error.stack,
            context: {
                type: 'APPLICATION_ERROR',
                timestamp: new Date().toISOString(),
                processId: process.pid,
                nodeVersion: process.version
            }
        };
        
        logger.error(errorData);
        process.exit(1);
    }
}

// Update uncaught exception handler with structured logging
process.on('uncaughtException', (error) => {
    const errorData = {
        severity: 'ERROR',
        message: error.message,
        stack: error.stack,
        context: {
            type: 'UNCAUGHT_EXCEPTION',
            timestamp: new Date().toISOString(),
            processId: process.pid,
            nodeVersion: process.version
        }
    };
    logger.error(errorData);
    process.exit(1);
});

// Update unhandled rejection handler with structured logging
process.on('unhandledRejection', (reason, promise) => {
    const errorData = {
        severity: 'ERROR',
        message: reason instanceof Error ? reason.message : String(reason),
        stack: reason instanceof Error ? reason.stack : undefined,
        context: {
            type: 'UNHANDLED_REJECTION',
            timestamp: new Date().toISOString(),
            processId: process.pid,
            nodeVersion: process.version,
            promise: promise.toString()
        }
    };
    logger.error(errorData);
    process.exit(1);
});

main().catch(error => {
    logger.error('Fatal error in main():');
    logger.error(error.stack || error.message);
    process.exit(1);
});