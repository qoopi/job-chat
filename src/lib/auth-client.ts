import { createAuthClient } from "better-auth/react";

// The browser auth client (stub for 012 - 013 builds the AuthDialog + sidebar on top). No baseURL =
// same-origin, so it targets our own /api/auth/* handler. Exposes signIn/signUp/signOut/useSession.
export const authClient = createAuthClient();
