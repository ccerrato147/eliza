/**
 * Core exports for the Eliza system.
 * Provides access to actions, clients, adapters, and providers.
 */
import express from "express";
import type { Request, Response, RequestHandler } from "express";
import cors from "cors";
import bodyParser from "body-parser";
import * as Client from "./clients/index.ts";
import { Arguments } from "./types/index.ts";
import {
    createAgentRuntime,
    createDirectRuntime,
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
import { ParamsDictionary } from "express-serve-static-core";
import multer, { File } from "multer";
import { composeContext } from "./core/context.ts";
import { generateMessageResponse } from "./core/generation.ts";
import { messageCompletionFooter } from "./core/parsing.ts";
import { stringToUuid } from "./core/uuid.ts";
import { Content, Memory, ModelClass, State } from "./core/types.ts";
import { ParsedQs } from "qs";

//Configure logger
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

// Initialize DirectClient
const directClient = new Client.DirectClient();

// Map to keep track of running agents
const runningAgents = new Map<string, AgentRuntime>();

/**
 * Initialize and start an agent for a given character
 */
async function startAgent(character: Character) {
    logger.log({
        severity: 'INFO',
        message: `Starting agent initialization`,
        context: {
            characterName: character.name,
            characterId: character.id,
            modelProvider: character.modelProvider,
            timestamp: new Date().toISOString()
        }
    });

    try {
        const token = getTokenForProvider(character.modelProvider, character);
        logger.log({
            severity: 'DEBUG',
            message: 'Provider token obtained successfully',
            context: {
                characterName: character.name,
                provider: character.modelProvider
            }
        });

        const db = initializeDatabase();
        logger.log({
            severity: 'DEBUG',
            message: 'Database initialized successfully',
            context: { characterName: character.name }
        });
        
        const runtime = await createDirectRuntime(character, db, token);
        logger.log({
            severity: 'DEBUG',
            message: 'Direct runtime created successfully',
            context: { characterName: character.name }
        });
        
        runningAgents.set(character.id || character.name, runtime);
        logger.log({
            severity: 'INFO',
            message: 'Agent started successfully',
            context: {
                characterName: character.name,
                agentId: character.id || character.name,
                timestamp: new Date().toISOString()
            }
        });
        return runtime;
    } catch (error) {
        logger.error({
            severity: 'ERROR',
            message: 'Failed to start agent',
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            context: {
                characterName: character.name,
                characterId: character.id,
                timestamp: new Date().toISOString()
            }
        });
        throw error;
    }
}

/**
 * Stop a running agent
 */
async function stopAgent(agentId: string) {
    logger.log({
        severity: 'INFO',
        message: 'Attempting to stop agent',
        context: { agentId, timestamp: new Date().toISOString() }
    });

    const runtime = runningAgents.get(agentId);
    if (!runtime) {
        const error = `No agent found with ID ${agentId}`;
        logger.error({
            severity: 'ERROR',
            message: 'Agent stop failed - agent not found',
            context: { agentId, timestamp: new Date().toISOString() }
        });
        throw new Error(error);
    }

    try {
        await runtime.shutdown();
        runningAgents.delete(agentId);
        logger.log({
            severity: 'INFO',
            message: 'Agent stopped successfully',
            context: {
                agentId,
                characterName: runtime.character.name,
                timestamp: new Date().toISOString()
            }
        });
    } catch (error) {
        logger.error({
            severity: 'ERROR',
            message: 'Error while stopping agent',
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            context: {
                agentId,
                characterName: runtime.character.name,
                timestamp: new Date().toISOString()
            }
        });
        runningAgents.delete(agentId);
        throw error;
    }
}

interface AgentParams extends ParamsDictionary {
    id: string;
}

interface MessageRequest {
    roomId?: string;
    userId?: string;
    userName?: string;
    name?: string;
    text: string;
}

const upload = multer({ storage: multer.memoryStorage() });

export const messageHandlerTemplate =
    `# Action Examples
{{actionExamples}}
(Action examples are for reference only. Do not use the information from them in your response.)

# Task: Generate dialog and actions for the character {{agentName}}.
About {{agentName}}:
{{bio}}
{{lore}}

{{providers}}

{{attachments}}

# Capabilities
Note that {{agentName}} is capable of reading/seeing/hearing various forms of media, including images, videos, audio, plaintext and PDFs. Recent attachments have been included above under the "Attachments" section.

{{messageDirections}}

{{recentMessages}}

{{actions}}

# Instructions: Write the next message for {{agentName}}. Ignore "action".
` + messageCompletionFooter;

/**
 * Initialize the HTTP API server for agent management and direct client functionality
 */
function initializeApiServer(port: number = 3000) {
    const app = express();
    
    app.use(cors());
    app.use(bodyParser.json());
    app.use(bodyParser.urlencoded({ extended: true }));

    // Define an interface that extends the Express Request interface
    interface CustomRequest extends Request {
        file: File;
    }
    
    // Message endpoint
    app.post("/agents/:agentId/message", 
        (async (req, res, next) => {
            const startTime = Date.now();
            logger.log({
                severity: 'INFO',
                message: 'Received message request',
                context: {
                    agentId: req.params.agentId,
                    roomId: req.body.roomId,
                    userId: req.body.userId,
                    timestamp: new Date().toISOString()
                }
            });

            try {
                const agentId = req.params.agentId;
                const roomId = stringToUuid(
                    req.body.roomId ?? "default-room-" + agentId
                );
                const userId = stringToUuid(req.body.userId ?? "user");

                const runtime = runningAgents.get(agentId);
                if (!runtime) {
                    logger.error({
                        severity: 'ERROR',
                        message: 'Message processing failed - agent not found',
                        context: { agentId, timestamp: new Date().toISOString() }
                    });
                    return res.status(404).send("Agent not found");
                }

                logger.log({
                    severity: 'DEBUG',
                    message: 'Ensuring connection',
                    context: {
                        agentId,
                        roomId: roomId.toString(),
                        userId: userId.toString(),
                        userName: req.body.userName
                    }
                });

                await runtime.ensureConnection(
                    userId,
                    roomId,
                    req.body.userName,
                    req.body.name,
                    "direct"
                );

                const text = req.body.text;
                const messageId = stringToUuid(Date.now().toString());

                const content: Content = {
                    text,
                    attachments: [],
                    source: "direct",
                    inReplyTo: undefined,
                };

                const userMessage = { content, userId, roomId, agentId: runtime.agentId };

                const memory: Memory = {
                    id: messageId,
                    agentId: runtime.agentId,
                    userId,
                    roomId,
                    content,
                    createdAt: Date.now(),
                };

                await runtime.messageManager.createMemory(memory);

                const state = (await runtime.composeState(userMessage, {
                    agentName: runtime.character.name,
                })) as State;

                const context = composeContext({
                    state,
                    template: messageHandlerTemplate,
                });

                const response = await generateMessageResponse({
                    runtime: runtime,
                    context,
                    modelClass: ModelClass.SMALL,
                });

                if (!response) {
                    return res.status(500).send("No response generated");
                }

                const responseMessage = {
                    ...userMessage,
                    userId: runtime.agentId,
                    content: response,
                };

                await runtime.messageManager.createMemory(responseMessage);

                let message = null as Content | null;

                await runtime.processActions(
                    memory,
                    [responseMessage],
                    state,
                    async (newMessages) => {
                        message = newMessages;
                        return [memory];
                    }
                );

                const processingTime = Date.now() - startTime;
                logger.log({
                    severity: 'INFO',
                    message: 'Message processed successfully',
                    context: {
                        agentId,
                        roomId: roomId.toString(),
                        processingTimeMs: processingTime,
                        timestamp: new Date().toISOString()
                    }
                });

                logger.log({
                    severity: 'DEBUG',
                    message: 'Sending response',
                    context: {
                        response: response,
                        message: message,
                        finalResponse: message ? [message, response] : [response]
                    }
                });

                res.json(message ? [message, response] : [response]);
            } catch (error) {
                logger.error({
                    severity: 'ERROR',
                    message: 'Message processing failed',
                    error: error instanceof Error ? error.message : String(error),
                    stack: error instanceof Error ? error.stack : undefined,
                    context: {
                        agentId: req.params.agentId,
                        processingTimeMs: Date.now() - startTime,
                        timestamp: new Date().toISOString()
                    }
                });
                next(error);
            }
        }) as unknown as RequestHandler<{ agentId: string }, any, MessageRequest>
    );

    // Get list of running agents with their health status
    app.get('/agents', async (_req, res) => {
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
    });

    // Start a new agent
    app.post('/agents/:id/start', 
        (async (req, res, next) => {
            try {
                const agentId = req.params.id;
                
                if (runningAgents.has(agentId)) {
                    return res.status(400).json({ error: 'Agent is already running' });
                }

                const characters = await loadCharacters(agentId);
                if (!characters || characters.length === 0) {
                    return res.status(404).json({ error: 'Character not found' });
                }

                const runtime = await startAgent(characters[0]);
                res.json({ id: agentId, name: runtime.character.name, status: 'running' });
            } catch (error) {
                next(error);
            }
        }) as unknown as RequestHandler<{id: string}>
    );

    // Stop a running agent
    app.post('/agents/:id/stop',
        (async (req, res, next) => {
            try {
                const agentId = req.params.id;
                
                if (!runningAgents.has(agentId)) {
                    return res.status(404).json({ error: 'Agent not found or not running' });
                }

                await stopAgent(agentId);
                res.json({ id: agentId, status: 'stopped' });
            } catch (error) {
                next(error);
            }
        }) as unknown as RequestHandler<{id: string}>
    );

    app.listen(port, () => {
        logger.log(`Server running at http://localhost:${port}/`, 'green');
    });

    return app;
}

/**
 * Main function to start the system
 */
async function main() {
    logger.log({
        severity: 'INFO',
        message: 'Application starting',
        context: {
            nodeVersion: process.version,
            environment: process.env.NODE_ENV,
            timestamp: new Date().toISOString()
        }
    });
    
    try {
        const serverPort = parseInt(process.env.SERVER_PORT || "3000");
        
        logger.log({
            severity: 'DEBUG',
            message: 'Initializing API server',
            context: { serverPort }
        });
        
        // Initialize only one server instance
        const app = initializeApiServer(serverPort);

        logger.log({
            severity: 'INFO',
            message: 'System initialization complete',
            context: {
                serverPort,
                timestamp: new Date().toISOString()
            }
        });
    } catch (error) {
        logger.error({
            severity: 'CRITICAL',
            message: 'Fatal error during system initialization',
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            context: {
                nodeVersion: process.version,
                environment: process.env.NODE_ENV,
                timestamp: new Date().toISOString()
            }
        });
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
    logger.error('Fatal error in main():', error);
    process.exit(1);
});

// Get list of running agents - Add the getLatestTweetTimestamp function
async function getLatestTweetTimestamp(runtime: AgentRuntime, id: string): Promise<number | null> {
    // This is a placeholder implementation - implement according to your needs
    return null;
}