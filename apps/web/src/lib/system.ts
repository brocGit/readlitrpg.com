// The System's toasts (QUIZZES.md §5 voice): a short bracketed line in the corner when something
// happens that a game would celebrate, like a profile level-up or a saved taste. Built with DOM
// calls and classes only (the CSP forbids inline styles), announced politely to screen readers, and
// never in the way of a click (styles/feel.css).

import type { LevelUp } from "@rlr/core/readers";
import { play } from "./sound";

function region(): HTMLElement {
  const found = document.querySelector<HTMLElement>(".system-toasts");
  if (found) return found;
  const el = document.createElement("div");
  el.className = "system-toasts";
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");
  document.body.appendChild(el);
  return el;
}

export function announce(label: string, text: string, opts: { tone?: "level-up"; ms?: number } = {}): void {
  if (typeof document === "undefined") return;
  const box = region();
  const toast = document.createElement("div");
  toast.className = opts.tone ? `system-toast ${opts.tone}` : "system-toast";
  const head = document.createElement("span");
  head.className = "label";
  head.textContent = label;
  toast.appendChild(head);
  toast.appendChild(document.createTextNode(text));
  box.appendChild(toast);
  play(opts.tone === "level-up" ? "level" : "toast");
  // Three at most: the oldest makes room.
  while (box.children.length > 3) box.firstElementChild?.remove();
  window.setTimeout(() => {
    toast.classList.add("leaving");
    window.setTimeout(() => toast.remove(), 260);
  }, opts.ms ?? 4200);
}

/** The level-up moment (QUIZZES.md §4.2), when an API reports one. */
export function announceLevelUp(up: LevelUp | null | undefined): void {
  if (!up) return;
  announce(`[Level up! Profile level ${up.level}]`, `${up.title}. Your matches just got sharper.`, {
    tone: "level-up",
    ms: 6500,
  });
}
