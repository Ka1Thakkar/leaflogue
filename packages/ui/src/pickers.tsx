"use client";

import { useEffect, useId, useMemo, useRef, useState, type ComponentPropsWithoutRef } from "react";
import * as Popover from "@radix-ui/react-popover";
import { useCombobox } from "downshift";
import { DayPicker } from "react-day-picker";
import { Icon } from "./icons";
import { controlPortalRoot } from "./controls";

type TextProps = Omit<ComponentPropsWithoutRef<"input">, "value" | "defaultValue" | "onChange" | "type" | "list">;

/** An editable model/search picker; custom values remain valid. */
export function ComboBox({ value, onValueChange, options, label, className = "", id: suppliedId, ...props }: TextProps & {
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly options: readonly string[];
  readonly label: string;
}) {
  const generatedId = useId();
  const id = suppliedId ?? generatedId;
  const [input, setInput] = useState<HTMLInputElement | null>(null);
  const items = useMemo(() => options.filter(option => option.toLocaleLowerCase().includes(value.toLocaleLowerCase())), [options, value]);
  const { isOpen, highlightedIndex, getLabelProps, getMenuProps, getInputProps, getItemProps, getToggleButtonProps, openMenu, closeMenu } = useCombobox({
    items,
    id: generatedId,
    inputId: id,
    inputValue: value,
    selectedItem: options.find(option => option === value) ?? null,
    stateReducer: (state, { type, changes }) => type === useCombobox.stateChangeTypes.InputKeyDownEscape
      ? { ...changes, inputValue: state.inputValue, selectedItem: state.selectedItem }
      : changes,
    onInputValueChange: ({ inputValue }) => onValueChange(inputValue ?? ""),
    onSelectedItemChange: ({ selectedItem }) => {
      if (selectedItem !== null && selectedItem !== undefined) { onValueChange(selectedItem); input?.focus(); }
    },
  });
  return <Popover.Root open={isOpen} onOpenChange={open => open ? openMenu() : closeMenu()}>
    <label {...getLabelProps()} className="ui-visually-hidden">{label}</label>
    <Popover.Anchor asChild>
      <div className="ui-combo-field">
        <input {...getInputProps({ ...props, ref: setInput, className: `ui-combo-input ${className}`, onFocus: () => { if (!props.disabled) openMenu(); } })} />
        <button {...getToggleButtonProps({ disabled: props.disabled, "aria-label": `Show ${label.toLocaleLowerCase()} suggestions` })} type="button" className="ui-combo-toggle"><Icon name="chevron-down" size={14} /></button>
      </div>
    </Popover.Anchor>
    <Popover.Portal container={controlPortalRoot(input)}>
      <Popover.Content className="ui-popup ui-combo-popup" sideOffset={5} collisionPadding={12} onOpenAutoFocus={event => event.preventDefault()} onCloseAutoFocus={event => event.preventDefault()}>
        <ul {...getMenuProps({}, { suppressRefError: !isOpen })} className="ui-picker-list">
          {items.map((item, index) => <li {...getItemProps({ item, index })} key={item} className="ui-popup-item" data-highlighted={highlightedIndex === index ? "" : undefined}>{item}{value === item && <span className="ui-popup-check" aria-hidden="true">✓</span>}</li>)}
          {items.length === 0 && <li className="ui-picker-empty">No suggestions. You can use your own value.</li>}
        </ul>
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>;
}

function parseDate(value: string): Date | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return undefined;
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.valueOf()) || formatDate(date) !== value ? undefined : date;
}
function formatDate(value: Date): string {
  return `${String(value.getFullYear()).padStart(4, "0")}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

/** A typed ISO date and themed calendar, with no operating-system popup. */
export function DatePicker({ value, defaultValue = "", onValueChange, className = "", min, max, ...props }: TextProps & {
  readonly value?: string;
  readonly defaultValue?: string;
  readonly onValueChange: (value: string) => void;
  readonly min?: string;
  readonly max?: string;
}) {
  const [localValue, setLocalValue] = useState(defaultValue);
  const chosen = value ?? localValue;
  const [draft, setDraft] = useState(chosen);
  const [open, setOpen] = useState(false);
  const outside = useRef(false);
  const [input, setInput] = useState<HTMLInputElement | null>(null);
  useEffect(() => setDraft(chosen), [chosen]);
  const invalid = draft !== "" && !parseDate(draft);
  const commit = (next: string) => {
    input?.setCustomValidity("");
    setDraft(next);
    setLocalValue(next);
    onValueChange(next);
  };
  return <Popover.Root open={open} onOpenChange={next => { if (next) outside.current = false; setOpen(next); }}>
    <Popover.Anchor asChild>
      <div className="ui-combo-field">
        <input {...props} ref={setInput} className={`ui-date-input ${className}`} type="text" inputMode="numeric" placeholder="YYYY-MM-DD" maxLength={10} value={draft} aria-invalid={invalid ? true : props["aria-invalid"]} onChange={event => {
          const next = event.target.value;
          setDraft(next);
          if (next === "" || parseDate(next)) commit(next);
        }} onBlur={event => {
          event.currentTarget.setCustomValidity(invalid ? "Enter a valid date as YYYY-MM-DD." : "");
          props.onBlur?.(event);
        }} />
        <Popover.Trigger asChild><button type="button" className="ui-combo-toggle" disabled={props.disabled} aria-label={`Choose ${props["aria-label"]?.toLocaleLowerCase() ?? "date"}`}><Icon name="calendar" size={14} /></button></Popover.Trigger>
      </div>
    </Popover.Anchor>
    <Popover.Portal container={controlPortalRoot(input)}>
      <Popover.Content className="ui-popup ui-date-popup" sideOffset={5} collisionPadding={12} aria-label="Choose a date" onInteractOutside={() => { outside.current = true; }} onCloseAutoFocus={event => { event.preventDefault(); if (!outside.current) input?.focus(); }}>
        <DayPicker className="ui-calendar" mode="single" selected={parseDate(chosen)} defaultMonth={parseDate(chosen)} autoFocus showOutsideDays onSelect={date => {
          commit(date ? formatDate(date) : "");
          setOpen(false);
        }} disabled={[...(min && parseDate(min) ? [{ before: parseDate(min)! }] : []), ...(max && parseDate(max) ? [{ after: parseDate(max)! }] : [])]} />
        <button type="button" className="ui-picker-clear" onClick={() => { commit(""); setOpen(false); }}>Clear date</button>
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>;
}

export function PickerPopover({ trigger, children, label }: { readonly trigger: import("react").ReactNode; readonly children: import("react").ReactNode; readonly label: string }) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  return <Popover.Root>
    <Popover.Trigger asChild ref={setAnchor}>{trigger}</Popover.Trigger>
    <Popover.Portal container={controlPortalRoot(anchor)}>
      <Popover.Content className="ui-popup ui-picker-popup" sideOffset={5} collisionPadding={12} aria-label={label}>{children}</Popover.Content>
    </Popover.Portal>
  </Popover.Root>;
}

export interface MultiSelectProps<T extends string> {
  readonly label: string;
  readonly options: readonly { readonly id: T; readonly label: string }[];
  readonly selected: readonly T[];
  readonly disabled?: boolean;
  readonly emptyText?: string;
  readonly inline?: boolean;
  readonly onChange: (ids: T[]) => Promise<unknown>;
  readonly formatError?: (error: unknown) => string;
}

export function MultiSelect<T extends string>({ label, options, selected, disabled = false, emptyText = "No options yet.", inline = false, onChange, formatError }: MultiSelectProps<T>) {
  const [draft, setDraft] = useState([...selected]);
  const [search, setSearch] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const selectedKey = selected.join("\u0000");
  useEffect(() => setDraft([...selected]), [selectedKey]);
  const chosen = new Set(draft);
  const visible = options.filter(option => option.label.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const summary = draft.length === 0 ? `Choose ${label.toLocaleLowerCase()}` : draft.length <= 2 ? options.filter(option => chosen.has(option.id)).map(option => option.label).join(", ") : `${draft.length} selected`;
  const commit = async (next: T[]) => {
    const previous = draft;
    setDraft(next);
    setPending(true);
    setError("");
    try { await onChange(next); }
    catch (cause) { setDraft(previous); setError(formatError?.(cause) ?? "The selection could not be saved. Try again."); }
    finally { setPending(false); }
  };
  const panel = <div className="ui-multi-panel">
    <label className="ui-multi-search"><span className="ui-visually-hidden">Search {label.toLocaleLowerCase()}</span><input type="search" className="ui-picker-search" value={search} placeholder={`Search ${label.toLocaleLowerCase()}…`} onChange={event => setSearch(event.target.value)} /></label>
    {options.length === 0 ? <p className="ui-picker-empty">{emptyText}</p> : visible.length === 0 ? <p className="ui-picker-empty">No matches.</p> : <ul className="ui-picker-list">{visible.map(option => <li key={option.id}><label className="ui-multi-option"><input type="checkbox" checked={chosen.has(option.id)} disabled={disabled} aria-disabled={pending || disabled} onChange={() => { if (!pending) void commit(chosen.has(option.id) ? draft.filter(id => id !== option.id) : [...draft, option.id]); }} /><span>{option.label}</span></label></li>)}</ul>}
    {draft.length > 0 && <button type="button" className="ui-picker-clear" disabled={pending || disabled} onClick={() => void commit([])}>Clear selection</button>}
  </div>;
  return <div className="ui-multi-select">
    {inline ? panel : <PickerPopover label={`${label} choices`} trigger={<button type="button" className="ui-select" aria-label={label} disabled={disabled || pending}><span>{summary}</span><Icon name="chevron-down" size={14} /></button>}>{panel}</PickerPopover>}
    {error && <p role="alert" className="ui-picker-error">{error}</p>}
  </div>;
}
