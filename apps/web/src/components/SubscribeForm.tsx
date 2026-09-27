// Email capture (QUIZZES §3.3): one field plus Turnstile, double opt-in, and a "Just the list"
// choice. Used on quiz results, Match Quiz results and /subscribe.

import { useEffect, useRef, useState } from "preact/hooks";
import { loadTurnstile, postJson } from "../lib/client";

const MESSAGES: Record<string, string> = {
  invalid_email: "That doesn't look like an email address. Check it and try again.",
  bot_check: "We couldn't confirm you're human. Try again in a moment.",
  slow_down: "Too many attempts from here. Wait a few minutes, then try again.",
  read_only: "Signups are paused for maintenance. Please try again soon.",
};

export default function SubscribeForm({
  source,
  siteKey,
  className = null,
  inputs = null,
  collapsed = false,
  cta = "Email me my full reading list",
}: {
  source: string;
  /** Null in local development, where the bot check is skipped. */
  siteKey: string | null;
  className?: string | null;
  inputs?: string | null;
  collapsed?: boolean;
  cta?: string;
}) {
  const [open, setOpen] = useState(!collapsed);
  const [plan, setPlan] = useState<"weekly" | "list">("weekly");
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");
  const [state, setState] = useState<"idle" | "busy" | "sent" | "subscribed">("idle");
  const [error, setError] = useState<string | null>(null);
  const widget = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);

  useEffect(() => {
    if (!open || !siteKey || !widget.current || widgetId.current) return;
    loadTurnstile()
      .then((t) => {
        if (widget.current && !widgetId.current)
          widgetId.current = t.render(widget.current, {
            sitekey: siteKey,
            action: "subscribe",
            callback: setToken,
          });
      })
      .catch(() => setError("The bot check didn't load. Refresh the page and try again."));
  }, [open, siteKey]);

  async function submit(e: Event) {
    e.preventDefault();
    setState("busy");
    setError(null);
    const res = await postJson<{ ok: boolean; code?: string; subscribed?: boolean }>("/api/subscribe", {
      email,
      plan,
      source,
      inputs,
      "cf-turnstile-response": token,
    });
    if (res.data?.ok) {
      setState(res.data.subscribed ? "subscribed" : "sent");
      return;
    }
    setState("idle");
    setError(
      MESSAGES[res.data?.code ?? ""] ?? "Something went wrong on our side. Please try again in a minute.",
    );
    if (widgetId.current) void loadTurnstile().then((t) => t.reset(widgetId.current ?? undefined));
  }

  if (state === "sent")
    return (
      <div class="status-screen subscribe-done" role="status">
        <p class="label">[Quest accepted]</p>
        <p>
          <strong>Check your inbox.</strong> Click the link in the email to confirm; nothing more arrives
          until you do.
        </p>
        <p>
          While you wait: <a href="/match/quiz">rate 3 books you've read</a> and your list gets better.
        </p>
      </div>
    );
  if (state === "subscribed")
    return (
      <div class="status-screen subscribe-done" role="status">
        <p class="label">[Party joined]</p>
        <p>You're subscribed. Your reading list is on its way.</p>
      </div>
    );
  if (!open)
    return (
      <button type="button" class="button" onClick={() => setOpen(true)}>
        {cta}
      </button>
    );

  // "your The Party Main reading list" reads badly: drop the article.
  const who = className ? `your ${className.replace(/^the\s+/i, "")} reading list` : "your reading list";
  return (
    <form class="subscribe-form" onSubmit={submit}>
      <div class="field">
        <label for={`sub-${source}`}>Email address</label>
        <input
          id={`sub-${source}`}
          type="email"
          autocomplete="email"
          required
          maxLength={320}
          value={email}
          onInput={(e) => setEmail((e.target as HTMLInputElement).value)}
        />
      </div>
      {siteKey && <div ref={widget} class="turnstile-slot" />}
      <button class="button" type="submit" disabled={state === "busy" || (Boolean(siteKey) && !token)}>
        {state === "busy" ? "Sending…" : plan === "list" ? "Email me the list" : cta}
      </button>
      <p class="muted small">
        {source === "newsletter"
          ? "Patch Notes arrives on Fridays: new matches for your taste and what's out from what you follow. One click to unsubscribe. We never share your email."
          : plan === "weekly"
            ? `We'll send ${who} and a weekly email of new matches. One click to unsubscribe. We never share your email.`
            : `We'll send ${who} once. No weekly email. We never share your email.`}
      </p>
      {source !== "newsletter" && (
        <button
          type="button"
          class="link-button small"
          onClick={() => setPlan(plan === "weekly" ? "list" : "weekly")}
        >
          {plan === "weekly" ? "Just the list, no weekly email" : "Send the weekly email too"}
        </button>
      )}
      {error && (
        <p class="notice error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
