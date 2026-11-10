import { useEffect, useState, useSyncExternalStore } from "react";
import { Select, SelectItem } from "@leaflogue/ui";

type Theme = "auto" | "light" | "dark";
let memoryTheme: Theme = "auto";
const eventName = "leaflogue-docs-theme";
const read = (): Theme => {
  try {
    const value = localStorage.getItem("starlight-theme");
    return value === "light" || value === "dark" ? value : memoryTheme;
  } catch { return memoryTheme; }
};
const subscribe = (notify: () => void) => {
  window.addEventListener("storage", notify);
  window.addEventListener(eventName, notify);
  return () => {
    window.removeEventListener("storage", notify);
    window.removeEventListener(eventName, notify);
  };
};
const serverTheme = (): Theme => "auto";

export default function ThemePicker({ compact = false }: { readonly compact?: boolean }) {
  const [systemDark, setSystemDark] = useState(false);
  const theme = useSyncExternalStore(subscribe, read, serverTheme);
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => { document.documentElement.dataset.theme = theme === "auto" ? media.matches ? "dark" : "light" : theme; };
    setSystemDark(media.matches);
    const updateSystem = () => setSystemDark(media.matches);
    media.addEventListener("change", updateSystem);
    apply();
    media.addEventListener("change", apply);
    return () => { media.removeEventListener("change", apply); media.removeEventListener("change", updateSystem); };
  }, [theme]);
  const changeTheme = (value: Theme) => {
    memoryTheme = value;
    try { localStorage.setItem("starlight-theme", value === "auto" ? "" : value); } catch { /* Apply to this page when storage is unavailable. */ }
    document.documentElement.dataset.theme = value === "auto" ? matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light" : value;
    window.dispatchEvent(new Event(eventName));
  };
  const dark = theme === "dark" || (theme === "auto" && systemDark);
  if (compact) return <button type="button" className="salon-theme-toggle" aria-label={dark ? "Switch to light mode" : "Switch to dark mode"} title={dark ? "Switch to light mode" : "Switch to dark mode"} onClick={() => changeTheme(dark ? "light" : "dark")}>
    {dark ? <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/></svg> : <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M20 15.5A8.5 8.5 0 0 1 8.5 4 8.5 8.5 0 1 0 20 15.5Z"/></svg>}
  </button>;
  return <Select aria-label="Theme" className="docs-theme-picker" value={theme} onValueChange={value => {
    if (value !== "auto" && value !== "light" && value !== "dark") return;
    memoryTheme = value;
    try { localStorage.setItem("starlight-theme", value === "auto" ? "" : value); } catch { /* The current page still changes when storage is unavailable. */ }
    document.documentElement.dataset.theme = value === "auto" ? matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light" : value;
    window.dispatchEvent(new Event(eventName));
  }}>
    <SelectItem value="dark">Dark</SelectItem>
    <SelectItem value="light">Light</SelectItem>
    <SelectItem value="auto">Auto</SelectItem>
  </Select>;
}
