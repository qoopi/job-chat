import { createHash } from "node:crypto";
import { stampV5, uuidV5Input } from "@shared/uuid-v5";

// The profile card's message id is DETERMINISTIC per conversation (a v5 UUID over the conversation id): that
// makes the out-of-band append safe - a re-save UPDATES the one card, a double-save can't duplicate it.

/** RFC 4122 v5 UUID: SHA1(namespace + name), stamped with version 5 + variant; namespace must be a UUID. */
export function uuidv5(name: string, namespace: string): string {
  return stampV5(createHash("sha1").update(uuidV5Input(name, namespace)).digest());
}

export function profileCardMessageId(conversationId: string): string {
  return uuidv5("profile-card", conversationId);
}
