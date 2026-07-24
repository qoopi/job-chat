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

  // Role autocomplete (GET /api/jobs/roles). The wire shape is RoleResponse{id,label,matched,jobCount};
  // the client keeps ONLY label + jobCount. The id is a 64-bit integer JSON.parse silently rounds past
  // JS's safe-integer limit - the body below carries such an id and the client must never surface it.
  const rolesBody = [
    { id: 9007199254740993, label: "Test Engineer", matched: true, jobCount: 13 },
    { id: 9007199254740995, label: "SDET", matched: false, jobCount: 7 },
    { id: 9007199254740997, label: "Obscure Role", matched: false, jobCount: 0 },
  ];

  it("resolves a phrase to canonical labels via /api/jobs/roles (Bearer, limit 8, LABEL-only)", async () => {
    const fetchImpl = vi.fn<FetchLike>(async (url) =>
      url.includes("/api/auth/login") ? res(200, loginBody) : res(200, rolesBody),
    );
    const client = createSearchnapplyClient(config, fetchImpl);

    const roles = await client.resolveRoles("test engineer");

    // Only label + jobCount survive; the 64-bit id and `matched` are stripped (never used in logic).
    expect(roles).toEqual([
      { label: "Test Engineer", jobCount: 13 },
      { label: "SDET", jobCount: 7 },
      { label: "Obscure Role", jobCount: 0 },
    ]);
    const call = fetchImpl.mock.calls.find(([u]) => u.includes("/api/jobs/roles"))!;
    expect(call[0]).toBe("http://jobs.test/api/jobs/roles?q=test%20engineer&limit=8");
    expect((call[1]?.headers as Record<string, string>).authorization).toBe("Bearer tok-1");
  });

  it("re-logs in once and retries resolveRoles when the token is rejected with 401", async () => {
    let roleCalls = 0;
    const fetchImpl = vi.fn<FetchLike>(async (url) => {
      if (url.includes("/api/auth/login")) return res(200, loginBody);
      roleCalls += 1;
      return roleCalls === 1 ? res(401, {}) : res(200, [{ id: 1, label: "QA Engineer", matched: true, jobCount: 14 }]);
    });
    const client = createSearchnapplyClient(config, fetchImpl);

    const roles = await client.resolveRoles("qa");

    expect(roles).toEqual([{ label: "QA Engineer", jobCount: 14 }]);
    const loginCalls = fetchImpl.mock.calls.filter(([u]) => u.includes("/api/auth/login"));
    expect(loginCalls.length).toBe(2); // initial + refresh after 401
  });

  it("throws a clear error naming the status when the roles fetch fails (non-401)", async () => {
    const fetchImpl = vi.fn<FetchLike>(async (url) =>
      url.includes("/api/auth/login") ? res(200, loginBody) : res(503, {}),
    );
    const client = createSearchnapplyClient(config, fetchImpl);

    await expect(client.resolveRoles("qa")).rejects.toThrow(/roles failed: 503/);
  });
});
