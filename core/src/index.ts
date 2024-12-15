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
    getTokenForProvider,    // Retrieves API tokens for AI providers
    initializeClients,      // Sets up communication clients
    initializeDatabase,     // Sets up persistent storage
    loadCharacters,         // Loads character configurations
    parseArguments,         // Processes command-line arguments
} from "./cli/index.ts";
// Import console formatting utilities
import { PrettyConsole } from "./cli/colors.ts";

// Add import for logger
import logger from "./core/logger.ts";

logger.configure({
    type: 'google-cloud',
    projectId: process.env.GOOGLE_PROJECT_ID,
    logName: process.env.GOOGLE_LOGS_NAME,
    keyFilename: process.env.GOOGLE_LOGGER_SERVICE_CREDENTIALS
});

import express, { Express, Request, Response, Router } from 'express';

// Initialize Express app
const app: Express = express();
const router = Router();
const port = process.env.PORT || 8080;

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

// Add a Map to store running agents
const runningAgents = new Map<string, {
    runtime: any, // Replace 'any' with your runtime type if available
    clients: any[] // Replace 'any[]' with your client type if available
}>();

/**
 * Initializes and starts an agent for a given character.
 * @param character - The character configuration to create an agent for
 * @returns Promise containing initialized clients
 */
async function startAgent(character: Character) {
    // Check if agent is already running
    if (runningAgents.has(character.id)) {
        logger.log(`Agent ${character.name} (${character.id}) is already running`, 'yellow');
        return runningAgents.get(character.id)?.clients;
    }

    logger.log(`Starting agent for character ${character.name}`, 'green');
    
    const token = getTokenForProvider(character.modelProvider, character);
    const db = initializeDatabase();

    // Create main runtime for handling interactions through various clients
    const runtime = await createAgentRuntime(character, db, token);
    const clients = await initializeClients(character, runtime);
    
    // Store the running agent
    runningAgents.set(character.id, { runtime, clients });
    
    return clients;
}

// Add error handling middleware
app.use((err: Error, req: Request, res: Response, next: any) => {
    logger.error('Express error:', err);
    res.status(500).send('Internal Server Error');
});

// Modify the endpoint to handle existing agents
router.get('/:characterIDs', async (req: Request, res: Response): Promise<void> => {
    logger.log(`Received request for characters: ${req.params.characterIDs}`, 'blue');
    
    try {
        let characters;
        try {
            characters = await loadCharacters(req.params.characterIDs);
            if (!characters || characters.length === 0) {
                logger.warn(`No characters found for ID: ${req.params.characterIDs}`);
                res.status(404).send(`No characters found for ID: ${req.params.characterIDs}`);
                return;
            }
        } catch (error) {
            logger.error(`Failed to load characters: ${error.message}`);
            res.status(400).send(`Failed to load characters: ${error.message}`);
            return;
        }

        const startedAgents: string[] = [];
        const existingAgents: string[] = [];
        
        for (const character of characters) {
            try {
                if (runningAgents.has(character.id)) {
                    existingAgents.push(character.name);
                } else {
                    await startAgent(character);
                    startedAgents.push(character.name);
                }
            } catch (error) {
                logger.error(`Failed to start agent ${character.name}: ${error.message}`);
                res.status(500).send(`Failed to start agent ${character.name}: ${error.message}`);
                return;
            }
        }
        
        const response = [
            startedAgents.length ? `Started new agents for: ${startedAgents.join(', ')}` : null,
            existingAgents.length ? `Agents already running for: ${existingAgents.join(', ')}` : null
        ].filter(Boolean).join('. ');
        
        logger.log(`Successfully processed request: ${response}`, 'green');
        res.send(response || 'No agents to start');
    } catch (error) {
        logger.error(`Unexpected error: ${error.message}`);
        res.status(500).send('An unexpected error occurred');
    }
});

// Mount the router before starting the server
app.use(router);

// Start the server first and store the instance
const server = app.listen(port, () => {
    logger.log(`Server running at http://localhost:${port}`, 'blue');
});

// Set shutdown timer for Cloud Run (10 minutes = 600000ms)
const SHUTDOWN_TIMEOUT = 300000; // Adjust this value as needed
const shutdownTimer = setTimeout(() => {
    logger.log('Shutdown timer expired, initiating graceful shutdown', 'yellow');
    
    // Close all running agents
    for (const [id, agent] of runningAgents.entries()) {
        logger.log(`Shutting down agent ${id}`, 'yellow');
        // Add any cleanup needed for your agents here
    }
    
    // Close the Express server
    server.close(() => {
        logger.log('Server closed successfully', 'green');
        process.exit(0); // Exit with success code
    });
}, SHUTDOWN_TIMEOUT);

// Keep the timer reference in case you need to clear it
shutdownTimer.unref();

// Add near the start of your index.ts file, before database initialization
console.log('Environment variables:');
console.log('POSTGRES_URL:', process.env.POSTGRES_URL);
console.log('Database connection string available:', !!process.env.POSTGRES_URL);


