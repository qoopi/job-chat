// The GitHub deep fetch: public-data enrichment for the profile extraction, run INSIDE the extract
// task (never the browser - the PAT stays server-side). With the operator's read-only PAT it gathers the
// deep signals (languages, topics, top READMEs, the merged-PR "problems solved" count, recent activity)
// in a BOUNDED handful of calls; without a PAT it degrades to a capped public fetch (repos + languages +
// topics only) and NEVER fails the save (AC-12). `fetch` is injected so the whole thing is unit-testable
// against mocked REST with no network.

const API = "https://api.github.com";
const README_EXCERPT_CHARS = 2000;
const TOP_REPOS_FOR_README = 3;
const MAX_REPO_SUMMARIES = 20;

export type FetchFn = typeof fetch;

/** The public-data signals the extraction call reads. `capped` marks the degraded (no-PAT) fetch, where
 *  the deep signals (readmes / mergedPrCount / recentEventTypes) are empty by design, not by failure. */
export interface GithubSignals {
  username: string;
  name: string | null;
  bio: string | null;
  location: string | null;
  publicRepos: number;
  languages: string[];
  topics: string[];
  repos: { name: string; description: string | null; language: string | null; topics: string[]; stars: number }[];
  readmes: { repo: string; excerpt: string }[];
  mergedPrCount: number;
  recentEventTypes: string[];
  capped: boolean;
}

interface GhRepo {
  name: string;
  fork?: boolean;
  language?: string | null;
  description?: string | null;
  topics?: string[];
  stargazers_count?: number;
}

function distinct(values: (string | null | undefined)[]): string[] {
  return [...new Set(values.filter((v): v is string => typeof v === "string" && v.length > 0))];
}

async function ghGet<T>(
  fetchFn: FetchFn,
  url: string,
  token: string | undefined,
  opts: { tolerate?: boolean } = {},
): Promise<T | null> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "job-chat",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetchFn(url, { headers });
  if (!res.ok) {
    // A tolerated sub-call (readme / PR search / events) degrades that ONE signal; the core user/repos
    // calls are not tolerated, so a bad username or a down API surfaces and the pipeline goes resume-only.
    if (opts.tolerate) return null;
    throw new Error(`GitHub ${url} -> ${res.status}`);
  }
  return (await res.json()) as T;
}

/**
 * Fetch the public GitHub signals for `username`. With a `token` (the PAT) it runs the DEEP path (user +
 * non-fork repos + top-3 READMEs + one merged-PR search + recent events); without one it runs the CAPPED
 * path (user + repos -> languages/topics only). Throws only on a hard core failure (unknown user / API
 * down) - the caller catches and saves a resume-only profile. `fetch` is injected (defaults to global).
 */
export async function fetchGithubProfile(
  username: string,
  token: string | undefined,
  fetchFn: FetchFn = fetch,
): Promise<GithubSignals> {
  const u = encodeURIComponent(username);
  const user = await ghGet<{ name?: string | null; bio?: string | null; location?: string | null; public_repos?: number }>(
    fetchFn,
    `${API}/users/${u}`,
    token,
  );
  const repos =
    (await ghGet<GhRepo[]>(fetchFn, `${API}/users/${u}/repos?per_page=100&sort=pushed&type=owner`, token)) ?? [];
  const nonFork = repos.filter((r) => !r.fork);

  const base: GithubSignals = {
    username,
    name: user?.name ?? null,
    bio: user?.bio ?? null,
    location: user?.location ?? null,
    publicRepos: user?.public_repos ?? nonFork.length,
    languages: distinct(nonFork.map((r) => r.language)),
    topics: distinct(nonFork.flatMap((r) => r.topics ?? [])),
    repos: nonFork.slice(0, MAX_REPO_SUMMARIES).map((r) => ({
      name: r.name,
      description: r.description ?? null,
      language: r.language ?? null,
      topics: r.topics ?? [],
      stars: r.stargazers_count ?? 0,
    })),
    readmes: [],
    mergedPrCount: 0,
    recentEventTypes: [],
    capped: token === undefined,
  };

  // No PAT: stop at the capped signals (never a failure - the profile still saves, AC-12).
  if (token === undefined) return base;

  // Deep signals: top-3 repos' READMEs (already sorted by pushed_at), the merged-PR problems-solved
  // count, and recent public activity. Each is tolerated so one 404 degrades only that signal.
  const readmes: GithubSignals["readmes"] = [];
  for (const repo of nonFork.slice(0, TOP_REPOS_FOR_README)) {
    const readme = await ghGet<{ content?: string; encoding?: string }>(
      fetchFn,
      `${API}/repos/${u}/${encodeURIComponent(repo.name)}/readme`,
      token,
      { tolerate: true },
    );
    if (readme?.content) {
      const text = Buffer.from(readme.content, readme.encoding === "base64" ? "base64" : "utf8").toString("utf8");
      readmes.push({ repo: repo.name, excerpt: text.slice(0, README_EXCERPT_CHARS) });
    }
  }

  const prSearch = await ghGet<{ total_count?: number }>(
    fetchFn,
    `${API}/search/issues?q=${encodeURIComponent(`is:pr is:merged author:${username}`)}&per_page=1`,
    token,
    { tolerate: true },
  );

  const events =
    (await ghGet<{ type?: string }[]>(fetchFn, `${API}/users/${u}/events/public?per_page=30`, token, {
      tolerate: true,
    })) ?? [];

  return {
    ...base,
    readmes,
    mergedPrCount: prSearch?.total_count ?? 0,
    recentEventTypes: distinct(events.map((e) => e.type)).slice(0, 10),
  };
}
