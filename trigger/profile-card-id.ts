import { createHash } from "node:crypto";

// The profile card's message id is DETERMINISTIC per conversation (a v5 UUID over the conversation id): that makes the out-of-band append safe - a re-save UPDATES the one card, a double-save can't duplicate it.

function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, "");
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function bytesToUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** RFC 4122 v5 UUID: SHA1(namespace + name), stamped with version 5 + variant; namespace must be a UUID. */
export function uuidv5(name: string, namespace: string): string {
  const ns = uuidToBytes(namespace);
  const nameBytes = new TextEncoder().encode(name);
  const input = new Uint8Array(ns.length + nameBytes.length);
  input.set(ns, 0);
  input.set(nameBytes, ns.length);
  const hash = createHash("sha1").update(input).digest();
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = hash[i];
  out[6] = (out[6] & 0x0f) | 0x50; // version 5
  out[8] = (out[8] & 0x3f) | 0x80; // RFC 4122 variant
  return bytesToUuid(out);
}

export function profileCardMessageId(conversationId: string): string {
  return uuidv5("profile-card", conversationId);
}
