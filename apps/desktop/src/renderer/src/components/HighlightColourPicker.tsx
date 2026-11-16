import { useId, useState } from "react";
import { currentHighlightPalette, HIGHLIGHT_COLOURS, saveHighlightColour, useHighlightColours } from "./highlight-colours";
import styles from "./highlight-colours.module.css";
export function HighlightColourPicker({ highlightId }: { readonly highlightId: string }) {
  const colours = useHighlightColours(); const selected = colours[highlightId] ?? "yellow";
  const palette = currentHighlightPalette(); const name = useId(); const [error, setError] = useState("");
  return <details className={styles.picker}>
    <summary aria-label={`Highlight colour: ${selected}`} title="Change highlight colour"><span aria-hidden="true" style={{ background: palette[selected].fill, borderColor: palette[selected].ink }} /></summary>
    <fieldset className={styles.palette}><legend>Highlight colour</legend>{HIGHLIGHT_COLOURS.map((colour) => <label key={colour} title={colour}><input type="radio" name={name} value={colour} checked={colour === selected} onChange={() => { try { saveHighlightColour(highlightId, colour); setError(""); } catch { setError("The colour could not be saved. Try again."); } }} /><span aria-hidden="true" style={{ background: palette[colour].fill, borderColor: palette[colour].ink }} />{colour}</label>)}{error && <p role="alert">{error}</p>}</fieldset>
  </details>;
}
