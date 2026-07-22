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

export interface SearchnapplyClient {
  login(): Promise<string>;
  fetchPostingsPage(page: number, pageSize: number): Promise<PostingsPage>;
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

  return { login, fetchPostingsPage };
}
