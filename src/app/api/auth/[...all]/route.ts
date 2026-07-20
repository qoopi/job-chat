import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/auth";

// Better Auth's catch-all HTTP handler: every /api/auth/* request (sign-in, sign-up, OAuth callback,
// session) routes through here. 013 drives it from the UI; this task just mounts it.
export const { POST, GET } = toNextJsHandler(auth);
