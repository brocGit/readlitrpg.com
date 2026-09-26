import { useState } from "preact/hooks";
import { authClient } from "../lib/auth-client";

export default function AddPasskey() {
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">("idle");

  if (typeof window !== "undefined" && !window.PublicKeyCredential) {
    return <p class="muted">This browser doesn't support passkeys.</p>;
  }

  async function add() {
    setState("busy");
    const result = await authClient.passkey.addPasskey({ name: deviceName() });
    if (result?.error) {
      setState("error");
      return;
    }
    setState("done");
    window.location.reload();
  }

  return (
    <div>
      <button class="button secondary" type="button" onClick={add} disabled={state === "busy"}>
        {state === "busy" ? "Follow your device's prompt…" : "Add a passkey"}
      </button>
      {state === "error" && (
        <p class="notice error" role="alert">
          The passkey wasn't saved. Nothing changed; you can try again.
        </p>
      )}
    </div>
  );
}

function deviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone|iPad/.test(ua)) return "iPhone or iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Mac/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows";
  return "Passkey";
}
