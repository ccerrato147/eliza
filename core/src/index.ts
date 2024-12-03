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

// logger.configure({
//     type: 'google-cloud',
//     projectId: process.env.GOOGLE_PROJECT_ID,
//     logName: process.env.GOOGLE_LOGS_NAME,
//     keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS
// });

import express, { Express, Request, Response, Router } from 'express';

// Initialize Express app
const app: Express = express();
const router = Router();
const port = process.env.PORT || 3000;

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

// Load characters directly without CLI arguments

/**
 * Initializes and starts an agent for a given character.
 * @param character - The character configuration to create an agent for
 * @returns Promise containing initialized clients
 */
async function startAgent(character: Character) {
    logger.log(`Starting agent for character ${character.name}`, 'green');
    
    const token = getTokenForProvider(character.modelProvider, character);
    const db = initializeDatabase();

    // Create main runtime for handling interactions through various clients
    const runtime = await createAgentRuntime(character, db, token);
    
    const clients = await initializeClients(character, runtime);
    return clients;
}

// Modify the existing characterID endpoint
router.get('/:characterID', async (req: Request, res: Response): Promise<void> => {
    const characterIDs = req.params.characterID.split(',');
    
    try {
        let characters = await loadCharacters(req.params.characterID);
        
        for (const character of characters) {
            await startAgent(character);
        }
        
        res.send(`Agents started for characters: ${characters.map(c => c.name).join(', ')}`);
    } catch (error) {
        logger.error(`Failed to start agents: ${error.message}`);
        res.status(500).send('Failed to start agents');
    }
});

// Mount the router before starting the server
app.use(router);

// Start the Express server
app.listen(port, () => {
    logger.log(`Server running at http://localhost:${port}`, 'blue');
});


