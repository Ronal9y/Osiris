import { generateText } from "ai";
import { inngest } from "./client";
import { google } from "@ai-sdk/google";
import { firecrawl } from "@/lib/firecrawl";

interface InngestStep {
  run: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
}

const URL_REGEX = /https?:\/\/[^\s]+/g;

export const demoGenerate = inngest.createFunction(
  {
    id: "demo-generate",
    triggers: [{ event: "demo/generate" }],
  },
  async ({ step, event }: { step: InngestStep; event: { data: { prompt: string } } }) => {
    const { prompt } = event.data;

    const urls = (await step.run("extract-urls", async () => {
      return prompt.match(URL_REGEX) ?? [];
    })) as string[];

    const scrapedContent = await step.run("scrape-urls", async () => {
      const results = await Promise.all(
        urls.map(async (url) => {
          const result = await firecrawl.scrape(url, { formats: ["markdown"] });
          return result.markdown ?? null;
        })
      );
      return results.filter(Boolean).join("\n\n");
    });

    const finalPrompt = scrapedContent
      ? `Context:\n${scrapedContent}\n\nQuestion: ${prompt}`
      : prompt;

    await step.run("generate-text", async () => {
      return await generateText({
        model: google("gemini-2.5-flash"),
        prompt: finalPrompt,
        experimental_telemetry: {
          isEnabled: true,
          recordInputs: true,
          recordOutputs: true,
        },
      });
    });
  }
);

export const demoError = inngest.createFunction(
  {
    id: "demo-error",
    triggers: [{ event: "demo/error" }], // <-- triggers va dentro del primer objeto
  },
  async ({ step }: { step: InngestStep }) => { // <-- tipo añadido
    await step.run("fail", async () => {
      throw new Error("Inngest error: Background job failed!");
    });
  }
);