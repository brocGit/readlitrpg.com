import { useState } from "preact/hooks";
import { authClient } from "../lib/auth-client";

export default function PasskeySignIn({ next }: { next: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (typeof window !== "undefined" && !window.PublicKeyCredential) return null;

  async function signIn() {
    setBusy(true);
    setError(null);
    const result = await authClient.signIn.passkey();
    if (result?.error) {
      setError("That passkey didn't work. Try again, or use an email link below.");
      setBusy(false);
      return;
    }
    // `next` was sanitized on the server to a same-site path.
    window.location.assign(next);
  }

  return (
    <div class="passkey">
      <button class="button" type="button" onClick={signIn} disabled={busy}>
        {busy ? "Waiting for your passkey…" : "Sign in with a passkey"}
      </button>
      {error && (
        <p class="notice error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
