// Once a reader is signed in, attach this browser's quiz takes to their profile (QUIZZES §4.3).

import { useEffect } from "preact/hooks";
import { forgetTakes, postJson, storedTakes } from "../lib/client";

export default function AttachTakes() {
  useEffect(() => {
    const takes = storedTakes();
    if (takes.length)
      void postJson("/api/me/takes", { attach: takes }).then((r) => {
        if (r.ok) forgetTakes();
      });
  }, []);
  return null;
}
