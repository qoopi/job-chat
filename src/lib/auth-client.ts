import { createAuthClient } from "better-auth/react";

// The browser auth client; no baseURL = same-origin (targets our /api/auth/* handler).
export const authClient = createAuthClient();
