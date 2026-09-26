// Browser-side Better Auth client for islands. Same-origin; only the passkey flows use it.
import { passkeyClient } from "@better-auth/passkey/client";
import { createAuthClient } from "better-auth/client";

export const authClient = createAuthClient({
  basePath: "/api/auth",
  plugins: [passkeyClient()],
});
