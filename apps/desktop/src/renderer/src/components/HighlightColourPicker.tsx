import { useId, useState } from "react";
import { currentHighlightPalette, HIGHLIGHT_COLOURS, saveHighlightColour, useHighlightColours } from "./highlight-colours";
import styles from "./highlight-colours.module.css";
export function HighlightColourPicker({ highlightId }: { readonly highlightId: string }) {
  const colours = useHighlightColours(); const selected = colours[highlightId] ?? "yellow";
  const palette = currentHighlightPalette(); const name = useId(); const [error, setError] = useState("");
  return <div role="radiogroup" aria-label="Highlight colour" className={styles.palette}>
    {HIGHLIGHT_COLOURS.map((colour) => <label key={colour}><input type="radio" aria-label={colour} name={name} value={colour} checked={colour === selected} style={{ background: palette[colour].fill, color: palette[colour].ink }} onChange={() => { try { saveHighlightColour(highlightId, colour); setError(""); } catch { setError("The colour could not be saved. Try again."); } }} /></label>)}
    {error && <p role="alert">{error}</p>}
  </div>;
}
