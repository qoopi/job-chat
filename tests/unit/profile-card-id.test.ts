import { describe, expect, it } from "vitest";
import { profileCardMessageId, uuidv5 } from "../../trigger/profile-card-id";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The canonical RFC-4122 v5 reference vector (Python's documented `uuid.uuid5(NAMESPACE_DNS,
// "python.org")`). An EXTERNAL oracle, so this pins RFC correctness rather than re-deriving the value
// the same way the code does.
const DNS_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

describe("uuidv5 (deterministic profile-card id)", () => {
  it("matches the canonical v5 reference vector (RFC correctness)", () => {
    expect(uuidv5("python.org", DNS_NAMESPACE)).toBe(
      "886313e1-3b8a-5372-9b90-0c9aee199e5d",
    );
  });

  it("profileCardMessageId is deterministic per conversation and a valid v5 uuid", () => {
    const conv = "11111111-2222-4333-8444-555555555555";
    const a = profileCardMessageId(conv);
    const b = profileCardMessageId(conv);
    expect(a).toBe(b); // same conversation -> same id (replace, never duplicate)
    expect(a).toMatch(UUID_RE);
    expect(a[14]).toBe("5"); // version nibble
    expect("89ab").toContain(a[19]); // variant nibble
  });

  it("different conversations get different card ids", () => {
    const x = profileCardMessageId("11111111-2222-4333-8444-555555555555");
    const y = profileCardMessageId("99999999-8888-4777-8666-555555555555");
    expect(x).not.toBe(y);
  });
});
