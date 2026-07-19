import { describe, expect, it } from "vitest";
import { deriveTitle } from "@shared/store";

// AC-14: a conversation title is derived from the first user question, trimmed to 60 chars on a
// word boundary, and is never null/empty.
describe("deriveTitle (AC-14)", () => {
  it("returns a short question unchanged", () => {
    expect(deriveTitle("Median salary for engineers in SF?")).toBe(
      "Median salary for engineers in SF?",
    );
  });

  it("trims to 60 chars on a word boundary, never mid-word", () => {
    const q =
      "What is the median salary for senior backend engineers working in San Francisco right now";
    const title = deriveTitle(q);
    expect(title.length).toBeLessThanOrEqual(60);
    expect(q.startsWith(title)).toBe(true); // a clean prefix, not mangled
    expect(title.endsWith(" ")).toBe(false);
    // Cut fell on a space in the source => the next source char is whitespace, so no word was split.
    expect(q[title.length]).toBe(" ");
  });

  it("hard-cuts a single very long token at 60 (no space to break on)", () => {
    expect(deriveTitle("a".repeat(80))).toBe("a".repeat(60));
  });

  it("never returns empty; falls back to 'New chat' for blank input", () => {
    expect(deriveTitle("")).toBe("New chat");
    expect(deriveTitle("   \n\t ")).toBe("New chat");
  });

  it("collapses internal whitespace and newlines to single spaces", () => {
    expect(deriveTitle("Hello\n\n  world")).toBe("Hello world");
  });
});
