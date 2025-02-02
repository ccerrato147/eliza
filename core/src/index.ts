/**
 * Core exports for the Eliza system.
 * Provides access to actions, clients, adapters, and providers.
 */
export * from "./actions/index.ts";
export * from "./clients/index.ts";
export * from "./adapters/index.ts";
export * from "./providers/index.ts";

import { Arguments } from "./types/index.ts";
import express, { Router, RequestHandler } from "express";
import { ParamsDictionary } from "express-serve-static-core";
import cors from "cors";
import bodyParser from "body-parser";

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
import { AgentRuntime } from "./core/runtime.ts";
import { UUID } from "crypto";

//Configure logger
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

// Map to keep track of running agents
const runningAgents = new Map<string, AgentRuntime>();

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
        runningAgents.set(character.id || character.name, runtime);
        logger.log(`Agent ${character.name} is running`, 'green');
        return runtime;
    } catch (error) {
        logger.error(`Failed to start agent for character ${character.name}:`, error);
        throw error;
    }
}

/**
 * Stop a running agent
 */
async function stopAgent(agentId: string) {
    const runtime = runningAgents.get(agentId);
    if (!runtime) {
        throw new Error(`No agent found with ID ${agentId}`);
    }

    try {
        // Clean up resources using the runtime's shutdown method
        await runtime.shutdown();
        // Remove from running agents map
        runningAgents.delete(agentId);
        logger.log(`Agent ${agentId} stopped`, 'yellow');
    } catch (error) {
        logger.error(`Error while stopping agent ${agentId}:`, error);
        // Still remove the agent from running agents even if cleanup fails
        runningAgents.delete(agentId);
        throw error;
    }
}

interface AgentParams extends ParamsDictionary {
    id: string;
}

/**
 * Initialize the HTTP API server
 */
function initializeApiServer(port: number = 4419) {
    const app = express();
    const router = Router();
    
    app.use(cors());
    app.use(bodyParser.json());

    /**
     * Get the latest tweet timestamp for an agent directly from the database
     */
    async function getLatestTweetTimestamp(runtime: AgentRuntime, agentId: UUID): Promise<string | null> {
        return await runtime.messageManager.getLatestTweetTimestamp(agentId);
    }

    // Get list of running agents with their health status
    const listAgents: RequestHandler = async (_req, res) => {
        try {
            const agentStatuses = await Promise.all(
                Array.from(runningAgents.entries()).map(async ([id, runtime]) => {
                    const lastTweetTimestamp = await getLatestTweetTimestamp(runtime, id as UUID);

                    return {
                        id,
                        name: runtime.character.name,
                        status: 'running',
                        lastTweetTimestamp
                    };
                })
            );
            res.json(agentStatuses);
        } catch (error) {
            logger.error('Error getting agent statuses:', error);
            res.status(500).json({ error: 'Failed to get agent statuses' });
        }
    };

    // Start a new agent
    const startAgentHandler: RequestHandler<AgentParams> = async (req, res) => {
        try {
            const agentId = req.params.id;
            
            // Check if agent is already running
            if (runningAgents.has(agentId)) {
                res.status(400).json({ error: 'Agent is already running' });
                return;
            }

            // Load character and start agent
            const character = await loadCharacters(agentId);
            if (!character || character.length === 0) {
                res.status(404).json({ error: 'Character not found' });
                return;
            }

            const runtime = await startAgent(character[0]);
            res.json({ 
                id: agentId,
                name: runtime.character.name,
                status: 'running'
            });
        } catch (error) {
            logger.error('Error starting agent:', error);
            res.status(500).json({ 
                error: error.message,
                details: error.stack
            });
        }
    };

    // Stop a running agent
    const stopAgentHandler: RequestHandler<AgentParams> = async (req, res) => {
        try {
            const agentId = req.params.id;
            
            // Check if agent is running
            if (!runningAgents.has(agentId)) {
                res.status(404).json({ error: 'Agent not found or not running' });
                return;
            }

            await stopAgent(agentId);
            res.json({ 
                id: agentId,
                status: 'stopped'
            });
        } catch (error) {
            logger.error('Error stopping agent:', error);
            res.status(500).json({ 
                error: error.message,
                details: error.stack
            });
        }
    };

    router.get('/agents', listAgents);
    router.post('/agents/:id/start', startAgentHandler);
    router.post('/agents/:id/stop', stopAgentHandler);

    app.use(router);
    app.listen(port, () => {
        logger.log(`API server running at http://localhost:${port}`, 'green');
    });

    return app;
}

/**
 * Main function to start the API server
 */
async function main() {
    logger.log('Application starting...', 'info');
    
    try {
        const argv: Arguments = parseArguments();
        logger.log('Arguments parsed successfully: ' + JSON.stringify(argv), 'info');
        
        // Initialize API server using port from arguments
        const apiPort = argv.port || 4419;
        initializeApiServer(apiPort);

        // Keep the process running and handle graceful shutdown
        process.on('SIGINT', async () => {
            logger.log('Received SIGINT. Gracefully shutting down...', 'yellow');
            // Stop all running agents, but don't let individual failures prevent full shutdown
            const shutdownPromises = Array.from(runningAgents.keys()).map(async (agentId) => {
                try {
                    await stopAgent(agentId);
                } catch (error) {
                    logger.error(`Error stopping agent ${agentId} during shutdown:`, error);
                }
            });
            
            await Promise.allSettled(shutdownPromises);
            process.exit(0);
        });

        logger.log(`System is running with API server on port ${apiPort}`, 'green');
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
process.on('uncaughtException', async (error) => {
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

    // If it's a critical error, try to identify and stop the affected agent
    if (error.message.includes('CRITICAL:')) {
        // Try to extract agent ID from the error message or stack trace
        const agentMatch = error.message.match(/agent[:\s]+([a-zA-Z0-9-]+)/i) || 
                          error.stack?.match(/agent[:\s]+([a-zA-Z0-9-]+)/i);
        const agentId = agentMatch?.[1];
        
        if (agentId && runningAgents.has(agentId)) {
            logger.error(`Stopping agent ${agentId} due to critical error`);
            try {
                await stopAgent(agentId);
            } catch (stopError) {
                logger.error(`Error while stopping agent ${agentId}:`, stopError);
            }
        } else {
            logger.error('Critical error occurred but could not identify affected agent:', error);
        }
    }
});

// Update unhandled rejection handler with structured logging
process.on('unhandledRejection', async (reason, promise) => {
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

    // If it's a critical error, try to identify and stop the affected agent
    if (reason instanceof Error && reason.message.includes('CRITICAL:')) {
        // Try to extract agent ID from the error message or stack trace
        const agentMatch = reason.message.match(/agent[:\s]+([a-zA-Z0-9-]+)/i) || 
                          reason.stack?.match(/agent[:\s]+([a-zA-Z0-9-]+)/i);
        const agentId = agentMatch?.[1];
        
        if (agentId && runningAgents.has(agentId)) {
            logger.error(`Stopping agent ${agentId} due to critical error`);
            try {
                await stopAgent(agentId);
            } catch (stopError) {
                logger.error(`Error while stopping agent ${agentId}:`, stopError);
            }
        } else {
            logger.error('Critical error occurred but could not identify affected agent:', reason);
        }
    }
});

main().catch(error => {
    logger.error('Fatal error in main():');
    logger.error(error.stack || error.message);
    process.exit(1);
});