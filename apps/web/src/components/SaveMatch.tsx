// Under match and find results: keep these tastes (signed in), save the query for alerts, or ask
// for new matches by email (signed out). DESIGN §9.6, §9.7 option B.

import { useEffect, useState } from "preact/hooks";
import { postJson, whoAmI } from "../lib/client";
import SubscribeForm from "./SubscribeForm";

export default function SaveMatch({
  kind,
  params,
  inputs = null,
  siteKey,
  defaultName,
}: {
  kind: "match" | "find";
  /** The query string that reproduces the results (a share link's p=… for matches). */
  params: string;
  /** Encoded match inputs, for "Save as my tastes". */
  inputs?: string | null;
  siteKey: string | null;
  defaultName: string;
}) {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void whoAmI().then((me) => setSignedIn(me.signedIn));
  }, []);

  async function saveQuery() {
    const res = await postJson<{ id?: string; error?: string }>("/api/me/saved", {
      kind,
      name: defaultName,
      params,
      alert: "digest",
    });
    if (res.ok) setSaved("Saved. New books that fit show up in your weekly email.");
    else setError(res.data?.error ?? "That didn't save. Try again in a moment.");
  }

  async function saveTastes() {
    const res = await postJson<{ level?: number; error?: string }>("/api/me/profile", { inputs });
    if (res.ok) setSaved("Saved as your tastes. Your weekly matches now start from these.");
    else setError(res.data?.error ?? "That didn't save. Try again in a moment.");
  }

  if (signedIn === null) return null;
  if (!signedIn)
    return (
      <section class="save-match">
        <h2>Get new matches like these by email</h2>
        <SubscribeForm
          source={kind === "match" ? "match" : "newsletter"}
          siteKey={siteKey}
          inputs={inputs}
          cta="Email me new matches"
        />
      </section>
    );
  return (
    <section class="save-match">
      {saved ? (
        <p class="notice" role="status">
          {saved}
        </p>
      ) : (
        <p>
          {inputs && (
            <button type="button" class="button" onClick={saveTastes}>
              Save as my tastes
            </button>
          )}{" "}
          <button type="button" class="button secondary" onClick={saveQuery}>
            {kind === "match" ? "Alert me to new matches" : "Alert me to new books in this search"}
          </button>
        </p>
      )}
      {error && (
        <p class="notice error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
