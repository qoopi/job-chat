import { schemaTask } from "@trigger.dev/sdk";
import { z } from "zod";
import { generateObject } from "ai";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import postgres from "postgres";
import { ProfileSchema } from "@shared/profile";
import { createStore, type Store } from "@shared/store";
import { fetchGithubProfile } from "./github-profile";
import { runProfileExtraction, type GenerateProfile } from "./profile-extraction";

// The background extraction task: the save action triggers it (payload: userId + conversationId), it
// reads the pending profiles row, enriches from GitHub, makes ONE haiku-class Bedrock call with the
// resume as a document block, then upserts the structured profile and appends the profile card. Running
// as a durable task (not a Vercel action) survives the multi-second latency and the 4MB PDF. The
// pipeline itself is trigger/profile-extraction.ts (pure); this file only wires the real seams.

// Default to the eu Haiku 4.5 inference profile (verified ACTIVE + document-block capable). The env var
// lets the operator swap it (e.g. to the sonnet profile) without a code change.
const DEFAULT_EXTRACTION_MODEL_ID = "eu.anthropic.claude-haiku-4-5-20251001-v1:0";

// Bedrock via the AWS default credential chain (env in the deployed task, local profile in dev).
// Building the provider does no I/O; creds resolve per request.
const bedrock = createAmazonBedrock({
  region: process.env.AWS_REGION ?? "eu-central-1",
  credentialProvider: fromNodeProviderChain(),
});

// The real model seam: ONE generateObject over ProfileSchema. The amazon-bedrock provider turns the
// application/pdf file part into a Converse document block, so the model parses the PDF itself.
const generate: GenerateProfile = async ({ system, messages }) => {
  const modelId = process.env.EXTRACTION_MODEL_ID ?? DEFAULT_EXTRACTION_MODEL_ID;
  const { object } = await generateObject({
    model: bedrock(modelId),
    schema: ProfileSchema,
    system,
    messages,
  });
  return object;
};

// A short-lived single-connection store for one task run (open, use, close - the Trigger task pattern,
// no module-level pool).
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
});
