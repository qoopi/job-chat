// The crypto-free pieces of an RFC 4122 v5 UUID (build the SHA-1 input, stamp + format the digest), shared by
// the client and task twins so only the digest call differs between them (Web Crypto async vs node:crypto sync).
// Client-safe: TextEncoder + typed arrays only, no node:crypto.

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

/** The SHA-1 input for a v5 UUID: the namespace UUID's 16 bytes followed by the UTF-8 name. */
export function uuidV5Input(name: string, namespace: string): Uint8Array<ArrayBuffer> {
  const ns = uuidToBytes(namespace);
  const nameBytes = new TextEncoder().encode(name);
  const input = new Uint8Array(ns.length + nameBytes.length);
  input.set(ns, 0);
  input.set(nameBytes, ns.length);
  return input;
}

/** Stamp a SHA-1 digest into a v5 UUID string: first 16 bytes, version 5 + RFC 4122 variant, hyphenated. */
export function stampV5(digest: Uint8Array): string {
  const out = new Uint8Array(16);
  out.set(digest.subarray(0, 16));
  out[6] = (out[6] & 0x0f) | 0x50; // version 5
  out[8] = (out[8] & 0x3f) | 0x80; // RFC 4122 variant
  return bytesToUuid(out);
}
