import { schemaTask } from "@trigger.dev/sdk";
import { z } from "zod";
import { generateObject } from "ai";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { ProfileSchema } from "@shared/profile";
import { fetchGithubProfile } from "./github-profile";
import { markProfileExtractionFailed, runProfileExtraction, type GenerateProfile } from "./profile-extraction";
import { MODEL_ID } from "./model-id";
import { withStore } from "./store-session";

// The background extraction task (durable, not a Vercel action, to survive the latency + 4MB PDF); the pure pipeline is profile-extraction.ts.

// F5b: default = the SAME shipped eu Sonnet 4.5 profile chat + evals already use (import, so no drift/second
// literal). Haiku 4.5 failed the n=1 extraction quality bar; Sonnet is the cheapest model that clears it.
// Enablement is proven by chat's live use. EXTRACTION_MODEL_ID still overrides.
const DEFAULT_EXTRACTION_MODEL_ID = MODEL_ID;

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
