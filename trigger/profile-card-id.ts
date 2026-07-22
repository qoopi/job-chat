import { createHash } from "node:crypto";

// The profile card's message id is DETERMINISTIC per conversation - a name-based (v5) UUID over the
// conversation id. That is what makes the out-of-band card append safe: a re-save UPDATES the one card
// (appendProfileCard's ON CONFLICT DO UPDATE keys on this id) and a double-save cannot duplicate it.
// v5 (SHA-1, RFC 4122) rather than a random id so the value is reproducible from the conversation id
// alone, and it lands in the canonical 8-4-4-4-12 shape the messages.id UUID column requires.

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

/** RFC 4122 v5 UUID: `SHA1(namespaceBytes + nameBytes)`, first 16 bytes stamped with the version (5)
 *  and variant bits. `namespace` must be a UUID string. */
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

/** The one card per conversation: `uuidv5("profile-card", conversationId)`. */
export function profileCardMessageId(conversationId: string): string {
  return uuidv5("profile-card", conversationId);
}
