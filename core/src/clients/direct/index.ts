import bodyParser from "body-parser";
import express from "express";
import { composeContext } from "../../core/context.ts";
import { AgentRuntime } from "../../core/runtime.ts";
import { Content, Memory, ModelClass, State } from "../../core/types.ts";
import { stringToUuid } from "../../core/uuid.ts";
import cors from "cors";
import { messageCompletionFooter } from "../../core/parsing.ts";
import multer, { File } from "multer";
import { Request as ExpressRequest } from "express";
import { generateMessageResponse } from "../../core/generation.ts";
import {
    generateCaption,
    generateImage,
} from "../../actions/imageGenerationUtils.ts";

const upload = multer({ storage: multer.memoryStorage() });

export const messageHandlerTemplate =
    // {{goals}}
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

export interface SimliClientConfig {
    apiKey: string;
    faceID: string;
    handleSilence: boolean;
    videoRef: any;
    audioRef: any;
}
class DirectClient {
    private agents: Map<string, AgentRuntime>;

    constructor() {
        this.agents = new Map();
    }

    public registerAgent(runtime: AgentRuntime) {
        this.agents.set(runtime.agentId, runtime);
    }

    public unregisterAgent(runtime: AgentRuntime) {
        this.agents.delete(runtime.agentId);
    }

    public start(_port: number) {
        // Server functionality moved to core/src/index.ts
        console.log("DirectClient initialized");
    }
}

export { DirectClient };
