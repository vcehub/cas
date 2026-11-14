// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 VCE Hub. Part of the /cas calculator: https://github.com/vcehub/cas
import { useLayoutEffect, useRef } from "react";
import { cn } from "@/shared/lib/utils";
import type { Key } from "../keys";
import { isEnabled, menuIndexForKey, menuKey, type Menu, type MenuAction, type MenuItem } from "./types";

/**
 * The menu overlay: a numbered list over the top-left of the app, each
 * submenu opening to the right of its parent, the selected row in blue.
 * Keys: arrows to move, right or Enter into a submenu, left or Esc out, and
 * an item's number or letter to pick it directly, as on the handheld.
 */
/** `cols`: a key's panel (trig, π▸ …), laid out as a grid that many cells across. */
export type MenuState = { path: number[]; cols?: number };

export const openMenu = (cols?: number): MenuState => (cols ? { path: [0], cols } : { path: [0] });

function listAt(menu: Menu, path: number[], depth: number): MenuItem[] {
  let items: MenuItem[] = menu;
  for (let d = 0; d < depth; d++) items = items[path[d]!]?.items ?? [];
  return items;
}

/**
 * A key while the menu is open: the next state (null when it closes) and the
 * chosen action, if one was picked.
 */
export function menuKeyPress(menu: Menu, state: MenuState, key: Key): { state: MenuState | null; action?: MenuAction } {
  if (state.cols) return gridKeyPress(menu, state, state.cols, key);
  const depth = state.path.length - 1;
  const items = listAt(menu, state.path, depth);
  const sel = state.path[depth] ?? 0;
  const setSel = (i: number) => ({ state: { path: [...state.path.slice(0, depth), i] } });
  const choose = (i: number): { state: MenuState | null; action?: MenuAction } => {
    const item = items[i];
    if (!item || !isEnabled(item)) return setSel(i);
    if (item.items) return { state: { path: [...state.path.slice(0, depth), i, 0] } };
    return { state: null, action: item.action };
  };
  switch (key.k) {
    case "up":
      return setSel((sel - 1 + items.length) % items.length);
    case "down":
      return setSel((sel + 1) % items.length);
    case "right":
    case "enter":
      return choose(sel);
    case "left":
      return depth > 0 ? { state: { path: state.path.slice(0, -1) } } : { state };
    case "esc":
      return depth > 0 ? { state: { path: state.path.slice(0, -1) } } : { state: null };
    case "menu":
      return { state: null };
    case "char": {
      const i = menuIndexForKey(key.c);
      return i >= 0 && i < items.length ? choose(i) : { state };
    }
    default:
      return { state };
  }
}

/** A panel's grid: the arrows move across and down, Enter picks, Esc closes. */
function gridKeyPress(menu: Menu, state: MenuState, cols: number, key: Key): { state: MenuState | null; action?: MenuAction } {
  const sel = state.path[0] ?? 0;
  const n = menu.length;
  const to = (i: number) => ({ state: { ...state, path: [((i % n) + n) % n] } });
  switch (key.k) {
    case "left":
      return to(sel - 1);
    case "right":
      return to(sel + 1);
    case "up":
      return sel - cols >= 0 ? to(sel - cols) : { state };
    case "down":
      return sel + cols < n ? to(sel + cols) : { state };
    case "enter": {
      const item = menu[sel];
      return item && isEnabled(item) ? { state: null, action: item.action } : { state };
    }
    case "esc":
    case "menu":
      return { state: null };
    default:
      return { state };
  }
}

export function MenuOverlay({
  menu,
  state,
  onPick,
  onHover,
}: {
  menu: Menu;
  state: MenuState;
  onPick: (path: number[]) => void;
  /** The pointer moved onto a row: select it, and open its submenu if it has one. */
  onHover: (path: number[]) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const lists = useRef<(HTMLDivElement | null)[]>([]);

  // Place each submenu beside its parent row, as the handheld does: just
  // overlapping the parent's right edge, level with the row, moved up to fit
  // the screen and moved left when there's no room on the right. Also keep
  // the selected row of each list in view.
  useLayoutEffect(() => {
    const b = box.current;
    if (!b) return;
    const W = b.clientWidth;
    const H = b.clientHeight;
    state.path.forEach((sel, depth) => {
      const el = lists.current[depth];
      if (!el) return;
      const row = el.children[sel] as HTMLElement | undefined;
      if (row) {
        if (row.offsetTop < el.scrollTop) el.scrollTop = row.offsetTop;
        else if (row.offsetTop + row.offsetHeight > el.scrollTop + el.clientHeight)
          el.scrollTop = row.offsetTop + row.offsetHeight - el.clientHeight;
      }
      if (depth === 0) return;
      const parent = lists.current[depth - 1];
      const prow = parent?.children[state.path[depth - 1]!] as HTMLElement | undefined;
      if (!parent || !prow) return;
      let left = parent.offsetLeft + parent.offsetWidth - 0.025 * W;
      if (left + el.offsetWidth > W) left = Math.max(0, W - el.offsetWidth);
      let top = parent.offsetTop + prow.offsetTop - parent.scrollTop;
      if (top + el.offsetHeight > H) top = Math.max(0, H - el.offsetHeight);
      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
    });
  }, [menu, state]);

  if (state.cols) return <PanelGrid menu={menu} cols={state.cols} sel={state.path[0] ?? 0} onPick={onPick} onHover={onHover} />;
  const deepest = state.path.length - 1;
  return (
    <div ref={box} className="absolute inset-0 font-casui text-[3.9cqw]">
      {state.path.map((sel, depth) => {
        const items = listAt(menu, state.path, depth);
        return (
          <div
            key={depth}
            ref={(el) => {
              lists.current[depth] = el;
            }}
            role="menu"
            className="absolute left-0 top-0 max-h-full w-max min-w-[28cqw] max-w-[75cqw] overflow-y-auto border border-casRule bg-casScreen [scrollbar-width:none]"
          >
            {items.map((item, i) => (
              <MenuRow
                key={`${depth}-${i}`}
                item={item}
                index={i}
                state={i !== sel ? "idle" : depth === deepest ? "selected" : "parent"}
                onClick={() => onPick([...state.path.slice(0, depth), i])}
                onHover={() => {
                  const here = [...state.path.slice(0, depth), i];
                  if (item.items && isEnabled(item)) onHover([...here, 0]);
                  else onHover(here);
                }}
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}

/**
 * A key's panel as the handheld shows it: a grid of equal cells floating
 * just under the entry line, the selected one in blue, a short last row
 * filled out with blanks.
 */
function PanelGrid({
  menu,
  cols,
  sel,
  onPick,
  onHover,
}: {
  menu: Menu;
  cols: number;
  sel: number;
  onPick: (path: number[]) => void;
  onHover: (path: number[]) => void;
}) {
  const blanks = (cols - (menu.length % cols)) % cols;
  return (
    <div className="absolute inset-0 font-casui text-[3.9cqw]">
      <div className="absolute left-[3cqw] top-[40%]">
        <div aria-hidden className="absolute inset-0 translate-x-[0.4cqw] translate-y-[0.4cqw] bg-casRule" />
        <div
          role="menu"
          className="relative grid gap-px border border-casRule bg-casRule"
          style={{ gridTemplateColumns: `repeat(${cols}, minmax(8.4cqw, 1fr))` }}
        >
          {menu.map((item, i) => {
            const enabled = isEnabled(item);
            return (
              <button
                key={i}
                type="button"
                tabIndex={-1}
                role="menuitem"
                aria-disabled={!enabled || undefined}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onPick([i])}
                onMouseEnter={() => onHover([i])}
                className={cn(
                  "flex h-[6.2cqw] items-center justify-center whitespace-nowrap px-[1.6cqw]",
                  i === sel ? "bg-casSelect text-casScreen" : enabled ? "bg-casScreen text-casInk" : "bg-casScreen text-casDim",
                )}
              >
                {item.label}
              </button>
            );
          })}
          {Array.from({ length: blanks }, (_, i) => (
            <span key={`blank-${i}`} className="bg-casScreen" />
          ))}
        </div>
      </div>
    </div>
  );
}

function MenuRow({
  item,
  index,
  state,
  onClick,
  onHover,
}: {
  item: MenuItem;
  index: number;
  state: "idle" | "selected" | "parent";
  onClick: () => void;
  onHover: () => void;
}) {
  const enabled = isEnabled(item);
  return (
    <button
      type="button"
      tabIndex={-1}
      role="menuitem"
      aria-disabled={!enabled || undefined}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      onMouseEnter={state === "idle" ? onHover : undefined}
      className={cn(
        "flex h-[6.2cqw] w-full items-center whitespace-nowrap pl-[2cqw] pr-[1.4cqw] text-left",
        item.rule && "border-t border-casRule",
        state === "selected" && "bg-casSelect text-casScreen",
        state === "parent" && "bg-casSelectParent text-casInk",
        state === "idle" && (enabled ? "text-casInk" : "text-casDim"),
      )}
    >
      <span className="mr-[1.6cqw] shrink-0">{menuKey(index)}</span>
      <span className="flex-1">{item.label}</span>
      {item.hint && <span className="ml-[3cqw] text-[3.3cqw]">({item.hint})</span>}
      {item.items && (
        <svg aria-hidden viewBox="0 0 6 10" className="ml-[3cqw] h-[2.2cqw] w-[1.3cqw] shrink-0">
          <path d="M0.5 0.5 L5.5 5 L0.5 9.5 Z" fill="currentColor" />
        </svg>
      )}
    </button>
  );
}
