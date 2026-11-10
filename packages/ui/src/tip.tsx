import { useCallback, useState, type MouseEvent, type ReactNode } from "react";

interface TipState {
  readonly title: string;
  readonly value: string;
  readonly x: number;
  readonly y: number;
}

/**
 * A hover card for charts. Any descendant with `data-tip-title` and
 * `data-tip-value` shows them above itself as the pointer moves over it. The
 * card is fixed to the viewport, so a panel's clipping never cuts it off, and
 * it is kept on screen at the edges. The same figures are in each chart's
 * hidden table for screen readers.
 */
export function useChartTip(): {
  readonly handlers: { readonly onMouseOver: (event: MouseEvent) => void; readonly onMouseLeave: () => void };
  readonly tip: ReactNode;
} {
  const [state, setState] = useState<TipState>();
  const onMouseOver = useCallback((event: MouseEvent) => {
    const target = (event.target as Element).closest<HTMLElement>("[data-tip-title]");
    if (!target) {
      setState(undefined);
      return;
    }
    // A bar column anchors at the bar itself, not the top of the plot.
    const rect = (target.querySelector("b") ?? target.querySelector("i") ?? target).getBoundingClientRect();
    const margin = 90;
    setState({
      title: target.dataset.tipTitle ?? "",
      value: target.dataset.tipValue ?? "",
      x: Math.min(Math.max(rect.left + rect.width / 2, margin), window.innerWidth - margin),
      y: rect.top < 64 ? rect.bottom : rect.top,
    });
  }, []);
  const onMouseLeave = useCallback(() => setState(undefined), []);
  const tip = state ? (
    <span className="ui-tip" role="tooltip" style={{ left: state.x, top: state.y }} data-below={state.y < 64 ? "" : undefined}>
      <strong>{state.title}</strong>
      <span>{state.value}</span>
    </span>
  ) : null;
  return { handlers: { onMouseOver, onMouseLeave }, tip };
}
