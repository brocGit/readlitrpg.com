// Keyboard shortcuts for the Owner Inbox (DESIGN §8.1): j/k move between cards, a approves,
// r rejects, e opens the thing to edit, s snoozes for a day. Keys are ignored while typing.

import { useEffect, useState } from "preact/hooks";

const ACTIONS: Record<string, string> = { a: "a", r: "r", e: "e", s: "s" };

export default function InboxKeys() {
  const [on, setOn] = useState(false);

  useEffect(() => {
    const rows = () => [...document.querySelectorAll<HTMLElement>("[data-inbox-item]")];
    const current = () => document.activeElement?.closest<HTMLElement>("[data-inbox-item]") ?? null;

    function onKey(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable]")) return;
      const list = rows();
      if (!list.length) return;
      const here = current();
      if (event.key === "j" || event.key === "k") {
        event.preventDefault();
        const i = here ? list.indexOf(here) : -1;
        const next = list[Math.max(0, Math.min(list.length - 1, i + (event.key === "j" ? 1 : -1)))];
        next?.focus();
        next?.scrollIntoView({ block: "nearest" });
        return;
      }
      const key = ACTIONS[event.key];
      if (!key || !here) return;
      const control = here.querySelector<HTMLElement>(`[data-key="${key}"]`);
      if (!control) return;
      event.preventDefault();
      control.click();
    }

    document.addEventListener("keydown", onKey);
    setOn(true);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <p class="muted keys-hint">
      {on
        ? "Keys: j / k move · a approve · r reject · e open · s snooze"
        : "Keyboard shortcuts load with the page."}
    </p>
  );
}
