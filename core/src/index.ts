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
    // Change console.error to logger.log
    logger.log('Application starting...', 'info');
    
    try {
        const argv: Arguments = parseArguments();
        logger.log('Arguments parsed successfully: ' + JSON.stringify(argv), 'info');
        
        if (!argv.character) {
            logger.error('No character provided. Please use --character parameter.');
            process.exit(1);
        }

        // Update character loading logs
        logger.log('Attempting to load character...', 'info');
        const characters = await loadCharacters(argv.character).catch(e => {
            logger.error('Error loading characters: ' + e);
            throw e;
        });
        
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