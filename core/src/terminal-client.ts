// Import required modules
import * as Client from "./clients/index.ts";
import { Character } from "./core/types.ts";
import readline from "readline";
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
import { randomUUID } from "crypto";

// logger.configure({
//     type: 'google-cloud',
//     projectId: process.env.GOOGLE_PROJECT_ID,
//     logName: process.env.GOOGLE_LOGS_NAME,
//     keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS
// });

// Initialize console
const prettyConsole = new PrettyConsole();
prettyConsole.clear();
prettyConsole.closeByNewLine = true;
prettyConsole.useIcons = true;

// Parse command line arguments
const parseArgs = () => {
    const args = process.argv.slice(2);
    const result: { agent?: string } = {};
    
    for (let i = 0; i < args.length; i++) {
        if (args[i].startsWith('--agent=')) {
            result.agent = args[i].split('=')[1];
        }
    }
    
    return result;
};

const args = parseArgs();

if (!args.agent) {
    prettyConsole.error("Please provide an agent ID with --agent=<id>");
    process.exit(1);
}

const API_BASE = "http://localhost:3000";
const agentId = args.agent;

// Generate a unique roomId for this session
const sessionRoomId = `terminal-${randomUUID()}`;

/**
 * Start the specified agent through the API
 */
async function startAgent() {
    try {
        const response = await fetch(`${API_BASE}/agents/${agentId}/start`, {
            method: 'POST'
        });
        
        if (!response.ok) {
            const error = await response.json();
            if (response.status !== 400) { // Ignore "already running" error
                throw new Error(error.error || 'Failed to start agent');
            }
        }
        
        console.log(`Agent ${agentId} is ready`);
    } catch (error) {
        prettyConsole.error(`Failed to start agent: ${error}`);
        process.exit(1);
    }
}

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
    console.log("Chat started. Type 'exit' to quit.");
    
    while (true) {
        const input = await new Promise<string>(resolve => {
            rl.question("You: ", resolve);
        });

        if (input.toLowerCase() === "exit") {
            // Try to stop the agent before exiting
            try {
                await fetch(`${API_BASE}/agents/${agentId}/stop`, {
                    method: 'POST'
                });
            } catch (error) {
                console.error(`Error stopping agent: ${error}`);
            }
            rl.close();
            return;
        }

        try {
            const response = await fetch(
                `${API_BASE}/agents/${agentId}/message`,
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                        text: input,
                        userId: "terminal-user",
                        userName: "Terminal User",
                        roomId: sessionRoomId,
                    }),
                }
            );

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const messages = await response.json();
            
            for (const message of messages) {
                if (typeof message === 'string') {
                    console.log(`Agent: ${message}`);
                } else if (message.user && message.text) {
                    console.log(`${message.user}: ${message.text}`);
                } else if (message.content && message.content.text) {
                    console.log(`Agent: ${message.content.text}`);
                } else if (message.text) {
                    console.log(`Agent: ${message.text}`);
                }
            }
        } catch (error) {
            console.error(`Error: ${error}`);
        }
    }
}

// Start the agent and begin chat
startAgent().then(() => {
    chat();
}).catch(error => {
    prettyConsole.error(`Fatal error: ${error}`);
    process.exit(1);
});


