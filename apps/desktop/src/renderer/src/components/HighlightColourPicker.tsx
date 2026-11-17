import { useId, useState } from "react";
import type { Highlight } from "@leaflogue/contracts";
import { currentHighlightPalette, HIGHLIGHT_COLOURS, highlightColour, updateHighlightColour, useHighlightColours } from "./highlight-colours";
import styles from "./highlight-colours.module.css";
export function HighlightColourPicker({ highlight, onSaved }: { readonly highlight: Highlight; readonly onSaved?: () => void | Promise<void> }) {
  const colours = useHighlightColours();
  const [choice, setChoice] = useState<{ revision: number; colour: typeof HIGHLIGHT_COLOURS[number] }>();
  const selected = choice?.revision === highlight.revision ? choice.colour : highlightColour(highlight, colours);
  const palette = currentHighlightPalette(); const name = useId(); const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  async function save(colour: typeof HIGHLIGHT_COLOURS[number]) {
    setPending(true); setError(""); setChoice({ revision: highlight.revision, colour });
    try { await updateHighlightColour(highlight, colour); await onSaved?.(); }
    catch { setChoice(undefined); setError("The colour could not be saved. Refresh and try again."); }
    finally { setPending(false); }
  }
  return <div role="radiogroup" aria-label="Highlight colour" className={styles.palette} aria-busy={pending}>
    {HIGHLIGHT_COLOURS.map((colour) => <label key={colour}><input type="radio" aria-label={colour} name={name} value={colour} disabled={pending} checked={colour === selected} style={{ background: palette[colour].fill, color: palette[colour].ink }} onChange={() => { void save(colour); }} /></label>)}
    {error && <p role="alert">{error}</p>}
  </div>;
}
