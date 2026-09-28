// The System's sounds (DESIGN §9.10): tiny synthesized blips for a pick, a result reveal, a toast
// and a level-up. Off unless the reader turns them on in the footer; the choice stays in this
// browser. Nothing is downloaded: WebAudio makes each tone, so there is no file to cache or block.

export type Cue = "pick" | "reveal" | "toast" | "level";

const KEY = "rlr.sound";
// [frequency Hz, start s, length s] per note. Short, quiet, square-ish: an old handheld, not a slot machine.
const CUES: Record<Cue, [number, number, number][]> = {
  pick: [[660, 0, 0.05]],
  toast: [
    [880, 0, 0.06],
    [1320, 0.06, 0.08],
  ],
  reveal: [
    [523, 0, 0.08],
    [659, 0.08, 0.08],
    [784, 0.16, 0.08],
    [1047, 0.24, 0.18],
  ],
  level: [
    [784, 0, 0.07],
    [988, 0.07, 0.07],
    [1175, 0.14, 0.07],
    [1568, 0.21, 0.24],
  ],
};

let ctx: AudioContext | null = null;

export function soundOn(): boolean {
  try {
    return localStorage.getItem(KEY) === "on";
  } catch {
    return false;
  }
}

export function setSound(on: boolean): void {
  try {
    if (on) localStorage.setItem(KEY, "on");
    else localStorage.removeItem(KEY);
  } catch {
    // Storage may be off; the toggle just won't stick.
  }
}

export function play(cue: Cue): void {
  if (typeof window === "undefined" || !soundOn()) return;
  try {
    ctx ??= new AudioContext();
    // A context made before any click starts suspended; the reader's click resumes it.
    if (ctx.state === "suspended") void ctx.resume();
    const t0 = ctx.currentTime + 0.01;
    for (const [freq, at, len] of CUES[cue]) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "square";
      osc.frequency.value = freq;
      // Quiet, with a quick fade so notes click in and out cleanly.
      gain.gain.setValueAtTime(0.0001, t0 + at);
      gain.gain.exponentialRampToValueAtTime(0.035, t0 + at + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + len);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0 + at);
      osc.stop(t0 + at + len + 0.02);
    }
  } catch {
    // No WebAudio (or it refused): stay silent.
  }
}
