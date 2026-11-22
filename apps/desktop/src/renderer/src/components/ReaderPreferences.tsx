import { useEffect, useState } from "react";
import { DEFAULT_READER_PREFERENCES as defaults, type ReaderPreferences } from "./reader-preferences";
import styles from "./epub-reader.module.css";
export const READER_TABS = ["Book", "Text", "Layout", "Appearance", "Presets"] as const;
export type ReaderTab = typeof READER_TABS[number];
export function ReaderPreferenceControls({ tab, pdf, preferences: p, onChange, override, onOverride, presets, onSavePreset, onRemovePreset }: {
  tab: ReaderTab; pdf: boolean; preferences: ReaderPreferences; onChange: (p: ReaderPreferences) => void;
  override: boolean; onOverride: (value: boolean) => void;
  presets: { name: string; preferences: ReaderPreferences }[]; onSavePreset: (name: string) => void; onRemovePreset: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const change = (key: keyof ReaderPreferences, value: number | string | boolean) => onChange({ ...p, [key]: value });
  const slider = (key: keyof ReaderPreferences, title: string, min: number, max: number, step: number, unit = "", hint?: string) => <div className={styles.preferenceRow} key={key}>
    <div className={styles.preferenceHeading}><label htmlFor={`reader-${key}`}>{title}</label><button className={styles.resetSetting} aria-label={`Reset ${title.toLowerCase()}`} onClick={() => change(key, defaults[key])}>Reset</button></div>
    <div className={styles.sliderRow}><button className="ll-icon-button" aria-label={`Decrease ${title.toLowerCase()}`} disabled={Number(p[key]) <= min} onClick={() => change(key, Math.max(min, Number((Number(p[key]) - step).toFixed(3))))}>−</button>
      <input id={`reader-${key}`} type="range" aria-label={title} min={min} max={max} step={step} value={Number(p[key])} onChange={(e) => change(key, Number(e.target.value))} />
      <button className="ll-icon-button" aria-label={`Increase ${title.toLowerCase()}`} disabled={Number(p[key]) >= max} onClick={() => change(key, Math.min(max, Number((Number(p[key]) + step).toFixed(3))))}>+</button>
      <PreferenceNumber label={`${title} value`} min={min} max={max} step={step} value={Number(p[key])} onChange={(value) => change(key, value)} /><span>{unit}</span></div>
    {hint && <small className="ll-muted">{hint}</small>}
  </div>;
  const publisherSlider = (key: "line" | "paragraph" | "indent", title: string, min: number, max: number, initial: number, unit: string) => <div className={styles.preferenceRow}>
    <label className={styles.preferenceToggle}><span>Use publisher {title.toLowerCase()}</span><input type="checkbox" checked={p[key] === defaults[key]} onChange={(e) => change(key, e.target.checked ? defaults[key] : initial)} /></label>
    {p[key] !== defaults[key] && slider(key, title, min, max, 0.1, unit)}
  </div>;
  const choice = (key: keyof ReaderPreferences, title: string, values: [string, string][]) => <fieldset className={styles.preferenceRow}><legend>{title}</legend><div className={styles.choices}>{values.map(([value, label]) => <button key={value} className="ll-button-secondary" aria-pressed={p[key] === value} onClick={() => change(key, value)}>{label}</button>)}</div></fieldset>;
  const toggle = (key: keyof ReaderPreferences, label: string) => <label className={styles.preferenceToggle}><span>{label}</span><input type="checkbox" role="switch" aria-label={label} checked={Boolean(p[key])} onChange={(e) => change(key, e.target.checked)} /></label>;
  return <>
    {tab === "Text" && (pdf ? <p className="ll-muted">PDF text has a fixed layout. Use zoom in the Book tab; typography controls apply to EPUB and KEPUB.</p> : <>
      {slider("size", "Text size", 12, 48, 1, "px")}
      {slider("weight", "Text weight", 0, 400, 100, "", "0 keeps publisher weight. Heavier levels preserve bold emphasis where the font supports it.")}
      {choice("alignment", "Alignment", [["publisher", "Publisher"], ["left", "Left"], ["justify", "Justified"]])}
      {publisherSlider("line", "Line spacing", 1, 2.6, 1.6, "×")}
      {publisherSlider("paragraph", "Paragraph spacing", 0, 2, 0.5, "em")}
      {publisherSlider("indent", "Paragraph indentation", 0, 3, 1, "em")}
      <details className={styles.readerTools}><summary>Advanced spacing</summary>{slider("letter", "Letter spacing", -0.03, 0.15, 0.01, "em")}{slider("word", "Word spacing", -0.05, 0.5, 0.05, "em")}{choice("hyphenation", "Hyphenation", [["publisher", "Publisher"], ["auto", "On"], ["none", "Off"]])}<p className="ll-muted">Automatic hyphenation depends on the book language and available dictionaries.</p></details>
    </>)}
    {tab === "Layout" && <>
      {!pdf && <>{slider("horizontal", "Side margins", 8, 96, 4, "px")}{slider("vertical", "Top and bottom margins", 8, 96, 4, "px")}{slider("width", "Reading width", 30, 120, 2, "ch")}{choice("columns", "Columns", [["auto", "Automatic"], ["one", "One"], ["two", "Two"]])}<p className="ll-muted">Two columns use a spread when the reading area is wide enough; narrow sidebars stay single-column.</p></>}
      <fieldset className={styles.preferenceRow}><legend>Show while reading</legend>{toggle("progress", "Reading progress")}{toggle("chapter", "Chapter information")}{toggle("clock", "Clock")}</fieldset>
      <p className="ll-muted">These appear discreetly below the page with the options closed.</p>
    </>}
    {tab === "Appearance" && <>
      {toggle("dark", "Dark mode")}{toggle("theme", "Use theme colours")}
      {choice("palette", "Page colour", [["default", "Standard"], ["sepia", "Sepia"]])}
      <p className="ll-muted">Theme colours take precedence over sepia. Dark sepia uses a warm dark page.</p>
      {choice("surround", "Surround colour", [["page", "Match page"], ["app", "Match app"]])}
      {pdf && <p className="ll-muted">Complex PDF artwork may retain its original colours to preserve images.</p>}
    </>}
    {tab === "Presets" && <>
      {toggleOverride(override, onOverride)}
      <p className="ll-muted">Preferences stay on this device. Without a book override, changes apply to other books too.</p>
      <label className="ll-label">Preset name<input className="ll-input" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} /></label>
      <button className="ll-button" disabled={!name.trim()} onClick={() => { onSavePreset(name); setName(""); }}>Save current preset</button>
      {presets.map((preset) => <div className={styles.presetRow} key={preset.name}><button className="ll-button-secondary" onClick={() => onChange(preset.preferences)}>Apply {preset.name}</button><button className="ll-button-secondary" aria-label={`Delete preset ${preset.name}`} onClick={() => onRemovePreset(preset.name)}>Delete</button></div>)}
      <button className="ll-button-secondary" onClick={() => onChange({ ...defaults })}>Reset all reading preferences</button>
      <button className="ll-button-secondary" onClick={() => onChange({ ...p, size: 18, weight: 0, alignment: "publisher", line: 0, paragraph: -1, indent: -1, letter: 0, word: 0, hyphenation: "publisher" })}>Restore publisher typography</button>
    </>}
  </>;
}
function toggleOverride(checked: boolean, onChange: (value: boolean) => void) {
  return <label className={styles.preferenceToggle}><span>Use separate preferences for this book</span><input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} /></label>;
}

function PreferenceNumber({ label, min, max, step, value, onChange }: { label: string; min: number; max: number; step: number; value: number; onChange: (value: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  return <input className="ll-input" type="number" aria-label={label} min={min} max={max} step={step} value={draft} onChange={(event) => {
    setDraft(event.target.value);
    const next = event.target.valueAsNumber;
    if (Number.isFinite(next) && next >= min && next <= max) onChange(next);
  }} onBlur={() => {
    const next = draft.trim() ? Number(draft) : value;
    const normalized = Number.isFinite(next) ? Math.max(min, Math.min(max, next)) : value;
    setDraft(String(normalized)); onChange(normalized);
  }} />;
}
