import { describe, expect, it } from "vitest";
import { profileCardMessageId as clientId } from "@/lib/profile-card-id";
import { profileCardMessageId as serverId } from "../../trigger/profile-card-id";

// The client (Web Crypto) card-id MUST equal the server (node:crypto) one, so the card injected into the
// live thread after a save replaces the extraction task's persisted card under the identical id. Pinned
// to the SAME fixed vector the server test uses (computed independently, not by calling the code).
const CONV = "11111111-2222-4333-8444-555555555555";
const FIXED = "a9c2bdff-1c47-5062-abbb-bb121637052d";

describe("profileCardMessageId (client, Web Crypto)", () => {
  it("matches the independently-computed fixed vector", async () => {
    expect(await clientId(CONV)).toBe(FIXED);
  });

  it("equals the server (node:crypto) implementation for the same conversation", async () => {
    expect(await clientId(CONV)).toBe(serverId(CONV));
  });

  it("differs by conversation", async () => {
    const a = await clientId("11111111-2222-4333-8444-555555555555");
    const b = await clientId("99999999-8888-4777-8666-555555555555");
    expect(a).not.toBe(b);
  });
});
