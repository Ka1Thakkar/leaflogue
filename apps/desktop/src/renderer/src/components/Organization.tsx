import { useCallback, useEffect, useState } from "react";
import { Pencil, Trash2 } from "../components/icons";
import type { Collection, Tag } from "@leaflogue/contracts";
import { useConfirm } from "./Confirm";
import { countOf, InlineError, Loading } from "./shared";
import styles from "./knowledge.module.css";
import { useAction } from "./useAction";

function OrganizationManager({ kind, onClose, onChanged }: { readonly kind: "collection" | "tag"; readonly onClose: () => void; readonly onChanged: () => void }) {
  const [items, setItems] = useState<readonly (Collection | Tag)[]>();
  const { pending, error, setError, run } = useAction();
  const load = useCallback(async () => {
    try {
      setItems(kind === "collection" ? await window.leaflogue.organization.listCollections() : await window.leaflogue.organization.listTags());
    } catch {
      setItems((current) => current ?? []);
      setError(`Leaflogue could not load your ${kind}s.`);
    }
  }, [kind, setError]);
  useEffect(() => { void load(); }, [load]);
  const changed = async () => { await load(); onChanged(); };
  return (
    <div className={styles.collectionManager}>
      <form onSubmit={async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const name = String(new FormData(form).get("name") ?? "");
        await run(async () => {
          if (kind === "collection") await window.leaflogue.organization.createCollection({ name });
          else await window.leaflogue.organization.createTag({ name });
          form.reset();
          await changed();
        }, `That ${kind} could not be created. ${kind === "collection" ? "Collection" : "Tag"} names must be unique.`);
      }}>
        <label className="ll-label">
          New {kind}
          <input className="ll-field" name="name" required maxLength={kind === "collection" ? 120 : 80} placeholder={kind === "collection" ? "For example, Philosophy" : "For example, Existentialism"} />
        </label>
        <button className="ll-button" disabled={pending}>Create {kind}</button>
      </form>
      {items === undefined ? <Loading>Loading {kind}s…</Loading> : items.length === 0 ? <p className="ll-muted">No {kind}s yet.</p> : (
        <ul className={styles.collectionList}>
          {items.map((item) => <OrganizationRow key={item.id} kind={kind} item={item} onChanged={changed} />)}
        </ul>
      )}
      <InlineError>{error}</InlineError>
      <button className="ll-button-secondary" onClick={onClose}>Done</button>
    </div>
  );
}

function OrganizationRow({ kind, item, onChanged }: { readonly kind: "collection" | "tag"; readonly item: Collection | Tag; readonly onChanged: () => Promise<void> }) {
  const [confirm, confirmDialog] = useConfirm();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(item.name);
  const { pending, setPending, error, setError, run } = useAction();
  const inputId = `${kind}-${item.id}`;
  if (editing) {
    return (
      <li className={styles.collectionEditRow}>
        <form onSubmit={async (event) => {
          event.preventDefault();
          await run(async () => {
            if (kind === "collection") {
              const collection = item as Collection;
              await window.leaflogue.organization.updateCollection({ id: collection.id, name, description: collection.description, expectedRevision: collection.revision });
            } else {
              const tag = item as Tag;
              await window.leaflogue.organization.updateTag({ id: tag.id, name, color: tag.color, expectedRevision: tag.revision });
            }
            setEditing(false);
            await onChanged();
          }, `That ${kind} could not be renamed. Names must be unique and up to date.`);
        }}>
          <label className="sr-only" htmlFor={inputId}>{kind === "collection" ? "Collection" : "Tag"} name</label>
          <input id={inputId} className="ll-field" value={name} required maxLength={kind === "collection" ? 120 : 80} autoFocus onChange={(event) => setName(event.target.value)} />
          <button className="ll-button" disabled={pending}>{pending ? "Saving…" : "Save"}</button>
          <button type="button" className="ll-button-secondary" disabled={pending} onClick={() => { setName(item.name); setError(""); setEditing(false); }}>Cancel</button>
        </form>
        <InlineError>{error}</InlineError>
      </li>
    );
  }
  return (
    <li>
      {kind === "collection"
        ? <span><strong>{item.name}</strong><small>{countOf(item.bookCount, "book")}</small></span>
        : <strong>{item.name}</strong>}
      <div className={styles.collectionActions}>
        <button className="ll-icon-button" aria-label={`Rename ${item.name}`} title={`Rename ${item.name}`} onClick={() => setEditing(true)}><Pencil size={16} aria-hidden="true" /></button>
        <button className="ll-icon-button ll-danger" aria-label={`Delete ${item.name}`} title={`Delete ${item.name}`} disabled={pending} onClick={async () => {
          if (!await confirm({
            title: kind === "collection" ? "Delete collection?" : "Delete tag?",
            message: kind === "collection"
              ? `“${item.name}” will be deleted. Books will stay in your library.`
              : `“${item.name}” will be deleted. Tagged books and highlights will remain.`,
            confirmLabel: kind === "collection" ? "Delete collection" : "Delete tag",
            destructive: true,
          })) return;
          setPending(true);
          setError("");
          try {
            if (kind === "collection") await window.leaflogue.organization.deleteCollection({ id: (item as Collection).id, expectedRevision: item.revision });
            else await window.leaflogue.organization.deleteTag({ id: (item as Tag).id, expectedRevision: item.revision });
            await onChanged();
          } catch {
            setError(`That ${kind} changed before it could be deleted. Review it and try again.`);
            setPending(false);
          }
        }}><Trash2 size={16} aria-hidden="true" /></button>
      </div>
      <InlineError>{error}</InlineError>
      {confirmDialog}
    </li>
  );
}

export function CollectionManager(props: { readonly onClose: () => void; readonly onChanged: () => void }) {
  return <OrganizationManager kind="collection" {...props} />;
}

export function TagManager(props: { readonly onClose: () => void; readonly onChanged: () => void }) {
  return <OrganizationManager kind="tag" {...props} />;
}
