// A range input that plays like a game slider (DESIGN §9.10): a gem handle and a filled track that
// follows the drag. The fill is a CSS variable set through the CSSOM after hydration, never a style
// attribute (the CSP refuses those in rendered HTML). onCommit fires on release, like onChange did.

import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";

export default function GameSlider({
  id,
  value,
  onCommit,
  min = 0,
  max = 10,
  step = 1,
}: {
  /** Pair it with a <label for={id}>. */
  id: string;
  value: number;
  onCommit: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [live, setLive] = useState(value);
  useEffect(() => setLive(value), [value]);
  useLayoutEffect(() => {
    ref.current?.style.setProperty("--fill", `${((live - min) / (max - min || 1)) * 100}%`);
  }, [live, min, max]);
  return (
    <input
      ref={ref}
      id={id}
      type="range"
      class="game-range"
      min={min}
      max={max}
      step={step}
      value={live}
      onInput={(e) => setLive(Number((e.target as HTMLInputElement).value))}
      onChange={(e) => onCommit(Number((e.target as HTMLInputElement).value))}
    />
  );
}
