// The chat agent's stable id, in its own tiny module so both homes import ONE literal: chat.agent({id})
// in trigger/chat.ts (the Bedrock/agent runtime) and chat.createStartSessionAction(id) in the
// "use server" actions. A drift between the two = a silent token/session mismatch. Kept out of
// chat.ts so the server-actions file can reference the id without pulling the agent runtime.
export const AGENT_ID = "job-chat-agent";
