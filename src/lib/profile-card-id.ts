import { stampV5, uuidV5Input } from "@shared/uuid-v5";

// Client-safe twin of `trigger/profile-card-id.ts`: it MUST derive the IDENTICAL v5 UUID, so the card
// injected into the live thread after a save REPLACES (never duplicates) the one the task persisted. Only
// the digest differs from the task twin - Web Crypto (async) here vs node:crypto (sync) there.
export async function profileCardMessageId(conversationId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", uuidV5Input("profile-card", conversationId));
  return stampV5(new Uint8Array(digest));
}
