import { describe, expect, it } from "vitest";
import { extractAssistantPersistence } from "../../trigger/persistence";
import type { Profile } from "@shared/profile";

// The persistence whitelist accepts the profile-card kind: a `data-profile-card` part is collected like
// the other card parts, and its payload survives `isPersistablePayload` (validated via the profile-card
// schema). A malformed payload is still dropped - the whitelist never widens to junk.

const profile: Profile = {
  titles: ["Senior Backend Engineer"],
  seniority: "senior",
  skills: [{ name: "Go", source: "both" }],
  locations: ["Berlin"],
  remotePref: true,
  salaryMin: 90000,
  yearsExp: 8,
  domains: ["fintech"],
  ossHighlights: ["OSS CLI maintainer"],
  experience: [],
};

describe("extractAssistantPersistence accepts the profile-card kind", () => {
  it("collects a data-profile-card part and keeps its payload as the persisted surface", () => {
    const message = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      parts: [
        { type: "text", text: "Here is your profile." },
        { type: "data-profile-card", id: "pc", data: { kind: "profile-card", profile } },
      ],
    };
    const { content, parts } = extractAssistantPersistence(message);
    expect(content).toBe("Here is your profile.");
    expect(parts).toEqual({ kind: "profile-card", profile });
  });

  it("drops a malformed profile-card payload (whitelist does not widen to junk)", () => {
    const message = {
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      parts: [{ type: "data-profile-card", id: "pc", data: { kind: "profile-card" } }], // no profile
    };
    const { parts } = extractAssistantPersistence(message);
    expect(parts).toBeNull();
  });
});
