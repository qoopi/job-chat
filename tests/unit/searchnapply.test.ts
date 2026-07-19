import { describe, expect, it, vi } from "vitest";
import { createSearchnapplyClient, type FetchLike } from "@shared/searchnapply";

const config = {
  authUrl: "http://auth.test",
  jobsUrl: "http://jobs.test",
  email: "svc@test.dev",
  password: "pw",
};

function res(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

const loginBody = {
  tokenType: "Bearer",
  accessToken: "tok-1",
  expiresIn: 3600,
  refreshToken: "ref-1",
};

const pageBody = {
  items: [
    {
      id: 1,
      title: "Engineer",
      company: "Google",
      source: "GoogleCareers",
      employmentType: "full-time",
      experienceLevel: "Senior",
      salary: null,
      locations: [{ city: "Tokyo", region: "Tokyo", country: "Japan", kind: 0 }],
      publishedAt: "2026-07-17T23:38:42Z",
    },
  ],
  page: 1,
  pageSize: 100,
  totalCount: 3483,
  totalPages: 35,
};

describe("createSearchnapplyClient", () => {
  it("logs in and returns the access token", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => res(200, loginBody));
    const client = createSearchnapplyClient(config, fetchImpl);

    const token = await client.login();

    expect(token).toBe("tok-1");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://auth.test/api/auth/login");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({ email: "svc@test.dev", password: "pw" });
  });

  it("fetches a postings page with a Bearer token and parses the envelope", async () => {
    const fetchImpl = vi.fn<FetchLike>(async (url) =>
      url.includes("/api/auth/login") ? res(200, loginBody) : res(200, pageBody),
    );
    const client = createSearchnapplyClient(config, fetchImpl);

    const page = await client.fetchPostingsPage(1, 100);

    expect(page.totalCount).toBe(3483);
    expect(page.items).toHaveLength(1);
    expect(page.items[0].company).toBe("Google");
    const postingsCall = fetchImpl.mock.calls.find(([u]) => u.includes("/api/jobs/postings"))!;
    expect(postingsCall[0]).toBe("http://jobs.test/api/jobs/postings?page=1&pageSize=100");
    expect((postingsCall[1]?.headers as Record<string, string>).authorization).toBe("Bearer tok-1");
  });

  it("re-logs in once and retries when the token is rejected with 401", async () => {
    let postingsCalls = 0;
    const fetchImpl = vi.fn<FetchLike>(async (url) => {
      if (url.includes("/api/auth/login")) return res(200, loginBody);
      postingsCalls += 1;
      return postingsCalls === 1 ? res(401, {}) : res(200, pageBody);
    });
    const client = createSearchnapplyClient(config, fetchImpl);

    const page = await client.fetchPostingsPage(2, 100);

    expect(page.page).toBe(1);
    const loginCalls = fetchImpl.mock.calls.filter(([u]) => u.includes("/api/auth/login"));
    expect(loginCalls.length).toBe(2); // initial + refresh after 401
    expect(postingsCalls).toBe(2);
  });

  it("throws when the postings envelope fails schema validation", async () => {
    const fetchImpl = vi.fn<FetchLike>(async (url) =>
      url.includes("/api/auth/login") ? res(200, loginBody) : res(200, { nonsense: true }),
    );
    const client = createSearchnapplyClient(config, fetchImpl);

    await expect(client.fetchPostingsPage(1, 100)).rejects.toThrow();
  });

  it("throws a clear error naming the status when login fails", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => res(500, { error: "internal" }));
    const client = createSearchnapplyClient(config, fetchImpl);

    await expect(client.login()).rejects.toThrow(/login failed: 500/);
  });

  it("throws a clear error naming the status when the postings fetch fails (non-401)", async () => {
    const fetchImpl = vi.fn<FetchLike>(async (url) =>
      url.includes("/api/auth/login") ? res(200, loginBody) : res(503, { error: "unavailable" }),
    );
    const client = createSearchnapplyClient(config, fetchImpl);

    await expect(client.fetchPostingsPage(1, 100)).rejects.toThrow(/postings failed: 503/);
  });
});
