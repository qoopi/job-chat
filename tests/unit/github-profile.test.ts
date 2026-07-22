import { describe, expect, it, vi } from "vitest";
import { fetchGithubProfile, type FetchFn } from "../../trigger/github-profile";

// The GitHub deep fetch against mocked REST (no network, no PAT in CI). Proves the DEEP path (with a
// token) gathers readmes + merged-PR count + events and sends the Authorization header, and the CAPPED
// path (no token) degrades to repos/languages/topics only, unauthenticated, and never fails.

const README_B64 = Buffer.from("# acme\nA fast Go CLI for payments.").toString("base64");

/** A router over the mocked GitHub REST surface. Records every requested URL + whether it was authed. */
function mockGithub(): { fetchFn: FetchFn; calls: { url: string; authed: boolean }[] } {
  const calls: { url: string; authed: boolean }[] = [];
  const json = (body: unknown, ok = true, status = 200) =>
    ({ ok, status, json: async () => body }) as Response;

  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const authed = Boolean((init?.headers as Record<string, string>)?.Authorization);
    calls.push({ url, authed });
    if (url.endsWith("/users/octocat")) {
      return json({ name: "The Octocat", bio: "builds things", location: "Berlin", public_repos: 2 });
    }
    if (url.includes("/users/octocat/repos")) {
      return json([
        { name: "acme", fork: false, language: "Go", description: "payments CLI", topics: ["fintech", "cli"], stargazers_count: 2000 },
        { name: "forked", fork: true, language: "JS", topics: ["x"], stargazers_count: 0 },
        { name: "lib", fork: false, language: "Rust", description: null, topics: ["parsing"], stargazers_count: 30 },
      ]);
    }
    if (url.includes("/readme")) return json({ content: README_B64, encoding: "base64" });
    if (url.includes("/search/issues")) return json({ total_count: 42 });
    if (url.includes("/events/public")) return json([{ type: "PushEvent" }, { type: "PullRequestEvent" }, { type: "PushEvent" }]);
    return json({}, false, 404);
  }) as unknown as FetchFn;

  return { fetchFn, calls };
}

describe("fetchGithubProfile", () => {
  it("Should_EnrichDeep_When_PatConfigured: deep signals + Authorization header (AC-5)", async () => {
    const { fetchFn, calls } = mockGithub();
    const signals = await fetchGithubProfile("octocat", "ghp_secret", fetchFn);

    expect(signals.capped).toBe(false);
    expect(signals.name).toBe("The Octocat");
    expect(signals.location).toBe("Berlin");
    expect(signals.languages).toEqual(["Go", "Rust"]); // forked repo's JS excluded
    expect(signals.topics).toEqual(["fintech", "cli", "parsing"]);
    expect(signals.repos.map((r) => r.name)).toEqual(["acme", "lib"]); // non-fork only
    expect(signals.mergedPrCount).toBe(42); // the problems-solved signal
    expect(signals.recentEventTypes).toEqual(["PushEvent", "PullRequestEvent"]); // distinct
    expect(signals.readmes[0].repo).toBe("acme");
    expect(signals.readmes[0].excerpt).toContain("fast Go CLI"); // base64 README decoded
    // The deep endpoints were hit AND every call carried the PAT.
    expect(calls.some((c) => c.url.includes("/readme"))).toBe(true);
    expect(calls.some((c) => c.url.includes("/search/issues"))).toBe(true);
    expect(calls.every((c) => c.authed)).toBe(true);
  });

  it("Should_DegradeToCappedFetch_When_NoPat: repos/languages/topics only, unauthenticated, never fails (AC-12)", async () => {
    const { fetchFn, calls } = mockGithub();
    const signals = await fetchGithubProfile("octocat", undefined, fetchFn);

    expect(signals.capped).toBe(true);
    expect(signals.languages).toEqual(["Go", "Rust"]); // capped path still reads repo languages/topics
    expect(signals.topics).toEqual(["fintech", "cli", "parsing"]);
    // The DEEP signals are empty by design (not by failure).
    expect(signals.readmes).toEqual([]);
    expect(signals.mergedPrCount).toBe(0);
    expect(signals.recentEventTypes).toEqual([]);
    // Only the two bounded public calls (user + repos), and NONE carried an Authorization header.
    expect(calls).toHaveLength(2);
    expect(calls.some((c) => c.url.includes("/readme") || c.url.includes("/search/issues"))).toBe(false);
    expect(calls.every((c) => !c.authed)).toBe(true);
  });

  it("throws on a hard core failure (unknown user), so the pipeline can go resume-only", async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }) as Response) as unknown as FetchFn;
    await expect(fetchGithubProfile("ghost", "ghp_secret", fetchFn)).rejects.toThrow(/404/);
  });
});
