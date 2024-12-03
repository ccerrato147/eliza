import fs from "fs";
import path from "path";
import { Logging } from '@google-cloud/logging';

// Type for logger configuration
type LoggerConfig = {
    type: 'console' | 'google-cloud';
    projectId?: string;  // For Google Cloud Logging
    logName?: string;    // For Google Cloud Logging
    keyFilename?: string; // Path to service account key file
};

class Logger {
    private static instance: Logger | null = null;
    private frameChar = "*";
    private config: LoggerConfig = { type: 'console' }; // Default to console logging
    private googleLogging?: Logging;
    private googleLog?: any;  // Will store the Log instance

    private constructor() {}

    public static getInstance(): Logger {
        if (!Logger.instance) {
            Logger.instance = new Logger();
        }
        return Logger.instance;
    }

    public configure(config: LoggerConfig): void {
        this.config = config;
        
        if (config.type === 'google-cloud') {
            this.googleLogging = new Logging({
                projectId: config.projectId,
                keyFilename: config.keyFilename
            });
            this.googleLog = this.googleLogging.log(config.logName || 'default');
        }
    }

    async log(...args: any[]): Promise<void> {
        try {
            if (this.config.type === 'google-cloud' && this.googleLog) {
                const metadata = {
                    severity: 'INFO',
                    resource: {
                        type: 'global'
                    }
                };
                const message = args
                    .map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg))
                    .join(' ');
                
                await this.googleLog.write(this.googleLog.entry(metadata, message));
                return;
            }
            
            if (this.config.type === 'console') {
                // Handle different input patterns
                if (args.length === 0) {
                    return;
                }
                
                // Convert all arguments to strings and join them
                const message = args
                    .map(arg => 
                        typeof arg === 'object' 
                            ? JSON.stringify(arg, null, 2)
                            : String(arg)
                    )
                    .join(' ');

                // Check if the last argument is a valid color
                const color = typeof args[args.length - 1] === 'string' 
                    && ['red', 'blue', 'green', 'yellow', 'white'].includes(args[args.length - 1])
                    ? args[args.length - 1]
                    : 'white';

                const c = await import("ansi-colors");
                const ansiColors = c.default;
                console.log(ansiColors[color](message));
            } else {
                // Future remote logging implementation
                console.log(...args); // Fallback for now
            }
        } catch (error) {
            console.error("Logging failed:", error);
            // Fallback to basic logging
            console.log(...args);
        }
    }

    async error(...args: any[]): Promise<void> {
        try {
            if (this.config.type === 'google-cloud' && this.googleLog) {
                const metadata = {
                    severity: 'ERROR',
                    resource: {
                        type: 'global'
                    }
                };
                const message = args
                    .map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg))
                    .join(' ');
                
                await this.googleLog.write(this.googleLog.entry(metadata, message));
                return;
            }
            
            if (this.config.type === 'console') {
                console.error(...args);
            } else {
                // Future remote error implementation
                console.error(...args);
            }
        } catch (error) {
            console.error("Error logging failed:", error);
            // Fallback to basic error logging
            console.log("ERROR:", ...args);
        }
    }

    async warn(...args: any[]): Promise<void> {
        try {
            if (this.config.type === 'google-cloud' && this.googleLog) {
                const metadata = {
                    severity: 'WARNING',
                    resource: {
                        type: 'global'
                    }
                };
                const message = args
                    .map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg))
                    .join(' ');
                
                await this.googleLog.write(this.googleLog.entry(metadata, message));
                return;
            }
            
            if (this.config.type === 'console') {
                console.warn(...args);
            } else {
                // Future remote warning implementation
                console.warn(...args);
            }
        } catch (error) {
            console.error("Warning failed:", error);
        }
    }

    frameMessage(message: string, title: string): string {
        const lines = message.split("\n");
        const frameHorizontalLength = 30;
        const topFrame =
            this.frameChar.repeat(frameHorizontalLength + 4) +
            " " +
            this.frameChar +
            " " +
            (title ?? "log") +
            " ".repeat(
                frameHorizontalLength -
                    ((title as string) ?? ("log" as string)).length +
                    1
            ) +
            this.frameChar.repeat(frameHorizontalLength + 4);
        const bottomFrame = this.frameChar.repeat(frameHorizontalLength + 4);
        return [topFrame, ...lines, bottomFrame].join("\n");
    }
}

// Create the singleton instance
const logger = Logger.getInstance();

export function log_to_file(
    filename: string,
    message: string,
    logDirectory: string = "./logs"
): void {
    // Ensure the log directory exists
    if (!fs.existsSync(logDirectory)) {
        fs.mkdirSync(logDirectory, { recursive: true });
    }

    let fullPath = path.join(logDirectory, filename);
    const timestamp = new Date().toUTCString();
    const logEntry = `[${timestamp}] ${message}\n`;

    // if full path doesnt end in .log or .txt, append .log
    if (!fullPath.endsWith(".log") && !fullPath.endsWith(".txt")) {
        fullPath += ".log";
    }

    // Append the log entry to the file
    fs.appendFileSync(fullPath, logEntry);

    // Print a message to the console
    const preview =
        message.length > 200 ? message.substring(0, 200) + "..." : message;
    logger.log(`Logged to ${filename}: ${preview}`, filename);
}

export { LoggerConfig };
export default logger;
