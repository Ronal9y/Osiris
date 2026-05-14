import { createAgent, createNetwork } from '@inngest/agent-kit';
import { inngest } from "@/inngest/client";
import { Id } from "../../../../convex/_generated/dataModel";
import { NonRetriableError } from "inngest";
import { convex } from "@/lib/convex-client";
import { api } from "../../../../convex/_generated/api";
import { gemini } from '@inngest/agent-kit';

// Importar constantes
import { 
  CODING_AGENT_SYSTEM_PROMPT, 
  TITLE_GENERATOR_SYSTEM_PROMPT 
} from "./constants";
import { DEFAULT_CONVERSATION_TITLE } from "../constants";

import { createReadFilesTool } from './tools/read-files';
import { createListFilesTool } from './tools/list-files';
import { createUpdateFileTool } from './tools/update-file';
import { createCreateFilesTool } from './tools/create-files';
import { createCreateFolderTool } from './tools/create-folder';
import { createRenameFileTool } from './tools/rename-file';
import { createDeleteFilesTool } from './tools/delete-files';
import { createScrapeUrlsTool } from './tools/scrape-urls';

// Definir tipos
interface MessageEvent {
  messageId: Id<"messages">;
  conversationId: Id<"conversations">;
  projectId: Id<"projects">;
  message: string;
}

interface RecentMessage {
  _id: Id<"messages">;
  role: "user" | "assistant";
  content: string;
  status?: string;
}

type InngestStep = Parameters<Parameters<typeof inngest.createFunction>[1]>[0]['step'];


const geminiModel = gemini({ 
  model: "gemini-2.5-flash",
  apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY // Usamos tu variable existente
});

export const processMessage = inngest.createFunction(
  // Opciones
  {
    id: "process-message",
    triggers: [{ event: "message/sent" }],
    cancelOn: [
      {
        event: "message/cancel",
        if: "event.data.messageId == async.data.messageId",
      },
    ],
    onFailure: async ({ event, step }) => {
      const { messageId } = event.data.event.data as MessageEvent;
      const internalKey = process.env.OSIRIS_CONVEX_INTERNAL_KEY;

      if (internalKey) {
        await step.run("update-message-on-failure", async () => {
          await convex.mutation(api.system.updateMessageContent, {
            internalKey,
            messageId,
            content: "My apologies, I encountered an error while processing your request. Let me know if you need anything else!",
          });
        });
      }
    }
  },
  // Handler con tipado correcto
  async ({ event, step }: { event: { data: MessageEvent }; step: InngestStep }) => {
    const { messageId, conversationId, projectId, message } = event.data;

    const internalKey = process.env.OSIRIS_CONVEX_INTERNAL_KEY;

    if (!internalKey) {
      throw new NonRetriableError("OSIRIS_CONVEX_INTERNAL_KEY is not configured");
    }

    await step.sleep("wait-for-db-sync", "1s");

    // Get conversation
    const conversation = await step.run("get-conversation", async () => {
      return await convex.query(api.system.getConversationById, {
        internalKey,
        conversationId,
      });
    });

    if (!conversation) {
      throw new NonRetriableError("Conversation not found");
    }

    // Fetch recent messages
    const recentMessages = await step.run("get-recent-messages", async () => {
      return await convex.query(api.system.getRecentMessages, {
        internalKey,
        conversationId,
        limit: 10,
      });
    });

    // Build system prompt
    let systemPrompt = CODING_AGENT_SYSTEM_PROMPT;

    const contextMessages = recentMessages.filter(
      (msg: RecentMessage) => msg._id !== messageId && msg.content.trim() !== ""
    );

    if (contextMessages.length > 0) {
      const historyText = contextMessages
        .map((msg: RecentMessage) => `${msg.role.toUpperCase()}: ${msg.content}`)
        .join("\n\n");

      systemPrompt += `\n\n## Previous Conversation:\n${historyText}\n\n## Current Request:\n${message}`;
    }

    // Generate title if needed
    const shouldGenerateTitle = conversation.title === DEFAULT_CONVERSATION_TITLE;

    if (shouldGenerateTitle) {
      const titleAgent = createAgent({
        name: "title-generator",
        system: TITLE_GENERATOR_SYSTEM_PROMPT,
        
        model: geminiModel,
      });

      const result = await titleAgent.run(message, { step });

      const textOutput = result.output.find(
        (m: { type: string; role: string }) => m.type === "text" && m.role === "assistant"
      );

      if (textOutput && textOutput.type === "text") {
        const title = typeof textOutput.content === "string"
          ? textOutput.content.trim()
          : textOutput.content.map((c: { text: string }) => c.text).join("").trim();

        if (title) {
          await step.run("update-conversation-title", async () => {
            await convex.mutation(api.system.updateConversationTitle, {
              internalKey,
              conversationId,
              title,
            });
          });
        }
      }
    }

    // Create the coding agent
   const codingAgent = createAgent({
  name: "osiris",
  description: "An expert AI coding assistant",
  system: systemPrompt,
  
  model: geminiModel,
  tools: [
    createListFilesTool({ internalKey, projectId }),
    createReadFilesTool({ internalKey }),
    createUpdateFileTool({ internalKey }),
    createCreateFilesTool({ projectId, internalKey }),
    createCreateFolderTool({ projectId, internalKey }),
    createRenameFileTool({ internalKey }),
    createDeleteFilesTool({ internalKey }),
    createScrapeUrlsTool(),
  ],
});

    // Create network
    // Create network con router (como en el código de referencia)
const network = createNetwork({
  name: "osiris-network",
  agents: [codingAgent],
  maxIter: 20,
  router: ({ network }) => {
    const lastResult = network.state.results.at(-1);
    const hasTextResponse = lastResult?.output.some(
      (m: { type: string; role: string }) => m.type === "text" && m.role === "assistant"
    );
    const hasToolCalls = lastResult?.output.some(
      (m: { type: string }) => m.type === "tool_call"
    );

    // Solo parar si hay texto SIN llamadas a herramientas (respuesta final)
    if (hasTextResponse && !hasToolCalls) {
      return undefined;
    }
    return codingAgent;
  }
});

    // Run the agent
    const result = await network.run(message);

    // Extract response
    const lastResult = result.state.results.at(-1);
    const textOutput = lastResult?.output.find(
      (m: { type: string; role: string }) => m.type === "text" && m.role === "assistant"
    );

    let assistantResponse = "I processed your request. Let me know if you need anything else!";

    if (textOutput?.type === "text") {
      assistantResponse = typeof textOutput.content === "string"
        ? textOutput.content
        : textOutput.content.map((c: { text: string }) => c.text).join("");
    }

    // Update message
    await step.run("update-assistant-message", async () => {
      await convex.mutation(api.system.updateMessageContent, {
        internalKey,
        messageId,
        content: assistantResponse,
      });
    });

    return { success: true, messageId, conversationId };
  }
);