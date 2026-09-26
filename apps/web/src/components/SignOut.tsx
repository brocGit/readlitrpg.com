import { useState } from "preact/hooks";
import { authClient } from "../lib/auth-client";

export default function SignOut() {
  const [busy, setBusy] = useState(false);
  async function signOut() {
    setBusy(true);
    await authClient.signOut();
    window.location.assign("/");
  }
  return (
    <button class="button secondary" type="button" onClick={signOut} disabled={busy}>
      {busy ? "Signing out…" : "Sign out"}
    </button>
  );
}
