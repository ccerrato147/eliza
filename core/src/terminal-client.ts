// Import required modules
import readline from "readline";
import { PrettyConsole } from "./cli/colors.ts";
import { randomUUID } from "crypto";
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Get the directory name of the current module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize console
const prettyConsole = new PrettyConsole();
prettyConsole.clear();
prettyConsole.closeByNewLine = true;
prettyConsole.useIcons = true;

// Load environment variables
const envPath = path.resolve(__dirname, '../.env');
console.log('Loading .env from:', envPath);
const result = dotenv.config({ path: envPath });

if (result.error) {
    prettyConsole.error(`Error loading .env file: ${result.error}`);
    process.exit(1);
}

const API_KEY = process.env.DIRECT_API_KEY;
if (!API_KEY) {
    prettyConsole.error("DIRECT_API_KEY is not set in the environment variables");
    console.log('Available environment variables:', Object.keys(process.env));
    process.exit(1);
}

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

const API_BASE = "http://localhost:3773";
const agentId = args.agent;

// Generate a unique roomId for this session
const sessionRoomId = `terminal-${randomUUID()}`;

/**
 * Start the specified agent through the API
 */
async function startAgent() {
    try {
        const response = await fetch(`${API_BASE}/agents/${agentId}/start`, {
            method: 'POST',
            headers: {
                'x-api-key': API_KEY
            }
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
                    method: 'POST',
                    headers: {
                        'x-api-key': API_KEY
                    }
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
                        'x-api-key': API_KEY
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


