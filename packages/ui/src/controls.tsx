"use client";

import { Children, Fragment, createContext, isValidElement, useContext, useState, type ComponentPropsWithoutRef, type ReactNode } from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import * as MenuPrimitive from "@radix-ui/react-dropdown-menu";
import { Icon } from "./icons";

/** Keep a popup in its native dialog/popover top layer. */
export function controlPortalRoot(anchor: HTMLElement | null): HTMLElement | undefined {
  return anchor?.closest<HTMLElement>("dialog, [popover]") ?? undefined;
}

// Encode every value so the empty-string "All…" option remains a real option.
const encode = (value: string | number) => `choice:${value}`;
const decode = (value: string) => value.slice("choice:".length);

function choiceLabel(children: ReactNode, value: string): ReactNode {
  for (const child of Children.toArray(children)) {
    if (!isValidElement<{ value?: string | number; children?: ReactNode }>(child)) continue;
    if (child.type === SelectItem && String(child.props.value) === value) return child.props.children;
    if (child.type === Fragment) {
      const label = choiceLabel(child.props.children, value);
      if (label !== undefined) return label;
    }
  }
  return undefined;
}

export interface SelectProps extends Omit<ComponentPropsWithoutRef<"button">, "value" | "defaultValue" | "onChange" | "children" | "type"> {
  readonly value?: string | number;
  readonly defaultValue?: string | number;
  readonly onValueChange?: (value: string) => void;
  readonly children: ReactNode;
  readonly placeholder?: string;
  readonly required?: boolean;
}

/** One themed, keyboard-accessible picker for every app. Form values stay raw. */
export function Select({ value, defaultValue = "", onValueChange, children, placeholder = "Choose…", name, disabled, required, className = "", ...props }: SelectProps) {
  const [localValue, setLocalValue] = useState(String(defaultValue));
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null);
  const chosen = value === undefined ? localValue : String(value);
  return (
    <SelectPrimitive.Root value={required && chosen === "" ? "" : encode(chosen)} disabled={disabled} required={required} onValueChange={(next) => {
      const raw = decode(next);
      setLocalValue(raw);
      onValueChange?.(raw);
    }}>
      {name && <input type="hidden" name={name} value={chosen} disabled={disabled} />}
      <SelectPrimitive.Trigger {...props} value={chosen} ref={setTrigger} className={`ui-select ${className}`}>
        <SelectPrimitive.Value>{choiceLabel(children, chosen) ?? placeholder}</SelectPrimitive.Value>
        <SelectPrimitive.Icon className="ui-control-chevron"><Icon name="chevron-down" size={14} /></SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal container={controlPortalRoot(trigger)}>
        <SelectPrimitive.Content className="ui-popup ui-select-popup" position="popper" sideOffset={5} collisionPadding={12}>
          <SelectPrimitive.ScrollUpButton className="ui-select-scroll">↑</SelectPrimitive.ScrollUpButton>
          <SelectPrimitive.Viewport className="ui-popup-items">{children}</SelectPrimitive.Viewport>
          <SelectPrimitive.ScrollDownButton className="ui-select-scroll">↓</SelectPrimitive.ScrollDownButton>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

export function SelectItem({ value, children, ...props }: Omit<ComponentPropsWithoutRef<typeof SelectPrimitive.Item>, "value"> & { readonly value: string | number }) {
  return <SelectPrimitive.Item {...props} data-value={String(value)} value={encode(value)} className="ui-popup-item">
    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    <SelectPrimitive.ItemIndicator className="ui-popup-check">✓</SelectPrimitive.ItemIndicator>
  </SelectPrimitive.Item>;
}

const MenuAnchor = createContext<HTMLButtonElement | null>(null);

export function Menu({ trigger, children, label }: { readonly trigger: ReactNode; readonly children: ReactNode; readonly label?: string }) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  return <MenuAnchor.Provider value={anchor}><MenuPrimitive.Root modal={false}>
    <MenuPrimitive.Trigger asChild ref={setAnchor}>{trigger}</MenuPrimitive.Trigger>
    <MenuPrimitive.Portal container={controlPortalRoot(anchor)}>
      <MenuPrimitive.Content className="ui-popup ui-menu-popup" aria-label={label} sideOffset={5} collisionPadding={12} align="end">{children}</MenuPrimitive.Content>
    </MenuPrimitive.Portal>
  </MenuPrimitive.Root></MenuAnchor.Provider>;
}

export function MenuItem({ className = "", onSelect, ...props }: ComponentPropsWithoutRef<typeof MenuPrimitive.Item>) {
  const anchor = useContext(MenuAnchor);
  return <MenuPrimitive.Item {...props} className={`ui-popup-item ${className}`} onSelect={event => { anchor?.focus(); onSelect?.(event); }} />;
}
export function MenuSeparator() { return <MenuPrimitive.Separator className="ui-popup-separator" />; }
