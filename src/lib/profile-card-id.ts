// The client-safe twin of `trigger/profile-card-id.ts`: it MUST derive the IDENTICAL v5 UUID so the
// card injected into the live thread after a save replaces (never duplicates) the one the extraction
// task persisted under the same deterministic id (reconcileMessagesById folds them by id). The trigger
// copy uses node:crypto (server); this one uses Web Crypto (`crypto.subtle`, async) so it runs in the
// browser bundle. Both compute `SHA1(conversationIdBytes + "profile-card")` stamped v5 - proven equal by
// a shared fixed vector in the tests.

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

/** The one card per conversation: RFC-4122 v5 over `SHA1(conversationIdBytes + "profile-card")`. */
export async function profileCardMessageId(conversationId: string): Promise<string> {
  const ns = uuidToBytes(conversationId);
  const name = new TextEncoder().encode("profile-card");
  const input = new Uint8Array(ns.length + name.length);
  input.set(ns, 0);
  input.set(name, ns.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", input));
  const out = digest.slice(0, 16);
  out[6] = (out[6] & 0x0f) | 0x50; // version 5
  out[8] = (out[8] & 0x3f) | 0x80; // RFC 4122 variant
  return bytesToUuid(out);
}
