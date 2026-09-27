// A hidden form field with this browser's quiz take ids, so a confirmation or sign-in can attach
// them to the reader's profile (QUIZZES §4.3). Without JavaScript the form still works; the takes
// just stay anonymous.

import { useEffect, useState } from "preact/hooks";
import { storedTakes } from "../lib/client";

export default function TakesField() {
  const [value, setValue] = useState("");
  useEffect(() => setValue(storedTakes().join(",")), []);
  return <input type="hidden" name="takes" value={value} />;
}
