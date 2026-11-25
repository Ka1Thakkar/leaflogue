import { useState } from "react";
import { Select, SelectItem } from "@leaflogue/ui";
import { href, navigate } from "../router";
import { useContextWorkspace } from "./ContextPanel";
import { BookForm } from "./BookForms";
import { ArticleForm } from "./ArticleForm";
import styles from "./knowledge.module.css";

/** One entry point; each source keeps its existing capture/import behavior. */
export function AddToLibrary({ onClose }: { readonly onClose: () => void }) {
  const context = useContextWorkspace();
  const [kind, setKind] = useState("book");
  const [visited, setVisited] = useState<readonly string[]>(["book"]);
  const [busy, setBusy] = useState(false);
  const formats = [
    { id: "book", label: "Book", Form: BookForm },
    ...(window.leaflogue.articles ? [{ id: "article", label: "Web article", Form: ArticleForm }] : []),
  ];
  return <div className={styles.form}>
    {formats.length > 1 && <label className="ll-label">What are you adding?
      <Select aria-label="What are you adding?" value={kind} disabled={busy} onValueChange={(next) => {
        if (!formats.some(({ id }) => id === next)) return;
        setKind(next); setVisited((current) => current.includes(next) ? current : [...current, next]);
      }}>{formats.map(({ id, label }) => <SelectItem key={id} value={id}>{label}</SelectItem>)}</Select>
    </label>}
    {formats.filter(({ id }) => visited.includes(id)).map(({ id, label, Form }) => <div key={id} hidden={kind !== id} role="region" aria-label={`Add ${label.toLowerCase()}`}>
      <Form onClose={onClose} onBusyChange={setBusy} onSaved={(book) => {
        navigate(href.book(book.id));
        if (id === "article") context?.showReader(book.id, book.title);
      }} />
    </div>)}
  </div>;
}
