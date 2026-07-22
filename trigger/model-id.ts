// The shipped Bedrock model id in its own module (registers no task, like agent-id.ts) so both homes - the
// chat agent and the eval runner - import ONE literal; a drift = the eval gate silently scoring a different model than prod.
export const MODEL_ID = "eu.anthropic.claude-sonnet-4-5-20250929-v1:0";
