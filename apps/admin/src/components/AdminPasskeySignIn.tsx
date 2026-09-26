import { passkeyClient } from "@better-auth/passkey/client";
import { createAuthClient } from "better-auth/client";
import { useState } from "preact/hooks";

const authClient = createAuthClient({ basePath: "/api/auth", plugins: [passkeyClient()] });

export default function AdminPasskeySignIn({ next }: { next: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn() {
    setBusy(true);
    setError(null);
    const result = await authClient.signIn.passkey();
    if (result?.error) {
      setError("Passkey sign-in failed. Make sure you're using the owner's passkey.");
      setBusy(false);
      return;
    }
    window.location.assign(next);
  }

  return (
    <div>
      <button class="button" type="button" onClick={signIn} disabled={busy}>
        {busy ? "Waiting for your passkey…" : "Sign in with passkey"}
      </button>
      {error && (
        <p class="notice error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
