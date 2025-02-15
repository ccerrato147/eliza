// Imports commented out since they're not currently used
// import models from "./models.ts";
import { IAgentRuntime /*, ModelProvider */ } from "./types.ts";

/**
 * This function is currently disabled as we're not using embeddings.
 * The system is using zero vectors for database compatibility.
 * Uncomment and modify this code when similarity search is needed.
 */
export async function embed(_runtime: IAgentRuntime, _input: string) {
    // Return zero vector since embeddings are not currently used
    return Array(1536).fill(0);
    
    /* Original implementation commented out to save on API calls
    const model = models[runtime.character.settings.model];

    if (model !== ModelProvider.OPENAI) {
        return await runtime.llamaService.getEmbeddingResponse(input);
    }

    const embeddingModel = models[runtime.modelProvider].model.embedding;

    // Check if we already have the embedding in the lore
    const cachedEmbedding = await retrieveCachedEmbedding(runtime, input);
    if (cachedEmbedding) {
        return cachedEmbedding;
    }

    const requestOptions = {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${runtime.token}`,
        },
        body: JSON.stringify({
            input,
            model: embeddingModel,
            length: 1536,
        }),
    };
    try {
        const response = await fetch(
            `${runtime.serverUrl}/embeddings`,
            requestOptions
        );

        if (!response.ok) {
            throw new Error(
                "OpenAI API Error: " +
                    response.status +
                    " " +
                    response.statusText
            );
        }

        interface OpenAIEmbeddingResponse {
            data: Array<{ embedding: number[] }>;
        }

        const data: OpenAIEmbeddingResponse = await response.json();

        return data?.data?.[0].embedding;
    } catch (e) {
        console.error(e);
        throw e;
    }
    */
}

export async function retrieveCachedEmbedding(
    runtime: IAgentRuntime,
    input: string
) {
    const similaritySearchResult =
        await runtime.messageManager.getCachedEmbeddings(input);
    if (similaritySearchResult.length > 0) {
        return similaritySearchResult[0].embedding;
    }
    return null;
}
