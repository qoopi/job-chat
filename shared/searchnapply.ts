import { z } from "zod";
import { PostingSchema } from "./postings";

// searchnapply is two services: auth (login -> Bearer, ~1h) and jobs (postings), with separate base URLs.
export interface SearchnapplyConfig {
  authUrl: string;
  jobsUrl: string;
  email: string;
  password: string;
}

export type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const LoginSchema = z.object({ accessToken: z.string().min(1) });

export const PostingsPageSchema = z.object({
  items: z.array(PostingSchema),
  page: z.number(),
  pageSize: z.number(),
  totalCount: z.number(),
  totalPages: z.number(),
});

export type PostingsPage = z.infer<typeof PostingsPageSchema>;

// Role autocomplete (GET /api/jobs/roles). The wire shape is RoleResponse{id,label,matched,jobCount}; we
// keep label + jobCount + matched. The id is a 64-bit integer JSON.parse silently rounds past JS's
// safe-integer limit (it already bit an earlier task) - z.object strips it so a corrupted id can never
// leak into logic. The label is the canonical role string (it matches the postings' role_names); jobCount
// lets the caller keep only labels the corpus actually has. `matched` is the DIRECT-HIT discriminator:
// null (or absent) means the query hit this canonical role directly; a string is the fuzzy ALIAS that
// matched (e.g. query "Senior Software Engineer in Test" -> "Software Engineering Manager" via alias
// "Senior Software Engineering Manager"). Enrichment keeps ONLY the direct hits (see resolveCanonicalRoles).
export const RoleResponseSchema = z.object({
  label: z.string(),
  jobCount: z.number(),
  matched: z.string().nullable().optional(),
});
export type RoleResponse = z.infer<typeof RoleResponseSchema>;

export interface SearchnapplyClient {
  login(): Promise<string>;
  fetchPostingsPage(page: number, pageSize: number): Promise<PostingsPage>;
  /** Resolve a role/title phrase to canonical role labels (autocomplete caps at 8). Enrichment-only -
   *  called at profile extraction, NEVER on the chat read path (that stays ClickHouse-only). */
  resolveRoles(phrase: string): Promise<RoleResponse[]>;
}

// Validated as its own slice, so ingestion stays decoupled from AWS/Bedrock creds (ISP).
export const SearchnapplyEnvSchema = z.object({
  SEARCHNAPPLY_AUTH_URL: z.string().min(1),
  SEARCHNAPPLY_API_URL: z.string().min(1),
  SEARCHNAPPLY_EMAIL: z.string().min(1),
  SEARCHNAPPLY_PASSWORD: z.string().min(1),
});

export function searchnapplyConfigFromEnv(
  source: Record<string, string | undefined> = process.env,
): SearchnapplyConfig {
  const env = SearchnapplyEnvSchema.parse(source);
  return {
    authUrl: env.SEARCHNAPPLY_AUTH_URL,
    jobsUrl: env.SEARCHNAPPLY_API_URL,
    email: env.SEARCHNAPPLY_EMAIL,
    password: env.SEARCHNAPPLY_PASSWORD,
  };
}

export function createSearchnapplyClient(
  config: SearchnapplyConfig,
  fetchImpl: FetchLike = fetch,
): SearchnapplyClient {
  let token: string | null = null;

  async function login(): Promise<string> {
    const res = await fetchImpl(`${config.authUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: config.email, password: config.password }),
    });
    if (!res.ok) throw new Error(`searchnapply login failed: ${res.status}`);
    token = LoginSchema.parse(await res.json()).accessToken;
    return token;
  }

  async function getPage(page: number, pageSize: number) {
    return fetchImpl(
      `${config.jobsUrl}/api/jobs/postings?page=${page}&pageSize=${pageSize}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
  }

  async function fetchPostingsPage(page: number, pageSize: number): Promise<PostingsPage> {
    if (!token) await login();
    let res = await getPage(page, pageSize);
    if (res.status === 401) {
      await login(); // token expired mid-run; refresh once and retry
      res = await getPage(page, pageSize);
    }
    if (!res.ok) throw new Error(`searchnapply postings failed: ${res.status}`);
    return PostingsPageSchema.parse(await res.json());
  }

  async function getRoles(phrase: string) {
    return fetchImpl(
      `${config.jobsUrl}/api/jobs/roles?q=${encodeURIComponent(phrase)}&limit=8`,
      { headers: { authorization: `Bearer ${token}` } },
    );
  }

  async function resolveRoles(phrase: string): Promise<RoleResponse[]> {
    if (!token) await login();
    let res = await getRoles(phrase);
    if (res.status === 401) {
      await login(); // token expired mid-run; refresh once and retry
      res = await getRoles(phrase);
    }
    if (!res.ok) throw new Error(`searchnapply roles failed: ${res.status}`);
    // z.array(RoleResponseSchema) keeps label + jobCount + matched - the 64-bit id never enters our data.
    return z.array(RoleResponseSchema).parse(await res.json());
  }

  return { login, fetchPostingsPage, resolveRoles };
}
