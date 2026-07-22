import { schemaTask } from "@trigger.dev/sdk";
import { z } from "zod";
import { generateObject } from "ai";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import postgres from "postgres";
import { ProfileSchema } from "@shared/profile";
import { createStore, type Store } from "@shared/store";
import { fetchGithubProfile } from "./github-profile";
import { markProfileExtractionFailed, runProfileExtraction, type GenerateProfile } from "./profile-extraction";

// The background extraction task (durable, not a Vercel action, to survive the latency + 4MB PDF); the pure pipeline is profile-extraction.ts.

// Default eu Haiku 4.5 profile; the env var lets the operator swap it.
const DEFAULT_EXTRACTION_MODEL_ID = "eu.anthropic.claude-haiku-4-5-20251001-v1:0";

const bedrock = createAmazonBedrock({
  region: process.env.AWS_REGION ?? "eu-central-1",
  credentialProvider: fromNodeProviderChain(),
});

// The model seam: ONE generateObject over ProfileSchema; the bedrock provider turns the PDF file part into a document block.
const generate: GenerateProfile = async ({ system, messages }) => {
  const modelId = process.env.EXTRACTION_MODEL_ID ?? DEFAULT_EXTRACTION_MODEL_ID;
  const { object } = await generateObject({
    model: bedrock(modelId),
    schema: ProfileSchema,
    system,
    messages,
    // Hand transport/throttle retries to the task's retry policy, not per-attempt - keeps the model-call fan-out bounded.
    maxRetries: 0,
  });
  return object;
};

async function withStore<T>(fn: (store: Store) => Promise<T>): Promise<T> {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    return await fn(createStore(sql));
  } finally {
    await sql.end();
  }
}

export const extractProfileTask = schemaTask({
  id: "extract-profile",
  schema: z.object({ userId: z.string(), conversationId: z.string() }),
  retry: { maxAttempts: 3, factor: 2, minTimeoutInMs: 1_000, maxTimeoutInMs: 30_000 },
  run: async (payload) =>
    withStore((store) =>
      runProfileExtraction(
        { store, fetchGithub: fetchGithubProfile, generate, githubToken: process.env.GITHUB_TOKEN },
        payload,
      ),
    ),
  // onFailure fires only after all retries are exhausted - the terminal point to clear the transient resume
  // PDF (never long-term PII) and stamp the failure marker the poll surfaces (so the panel stops polling).
  onFailure: async ({ payload }) => {
    await withStore((store) => markProfileExtractionFailed(store, payload.userId));
  },
});
