// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 VCE Hub. Part of the /cas calculator: https://github.com/vcehub/cas
import { CATALOG } from "../catalog/commands";
import { calculatorMenu } from "../menus/calculator-menu";
import { ADD_PAGE, DOC_MENU } from "../menus/doc-menus";
import { graphsMenu } from "../menus/graphs-menu";
import { isEnabled, menuKey, type Menu, type MenuAction, type MenuItem } from "../menus/types";
import type { HowTo, MenuName, Way } from "./types";

/** The Graphs menu as it first opens: axes on, the entry line showing. */
const GRAPHS = graphsMenu({ axes: true, entryLine: true, grid: "none", table: false });

export const MENUS: Record<MenuName, Menu> = {
  calculator: calculatorMenu,
  graphs: GRAPHS,
  doc: DOC_MENU,
  addPage: ADD_PAGE,
};

/** The key that opens each menu on the keypad, and on a computer keyboard. */
const OPEN: Record<MenuName, { caps: string[]; kbd: string }> = {
  calculator: { caps: ["menu"], kbd: "Ctrl M" },
  graphs: { caps: ["menu"], kbd: "Ctrl M" },
  doc: { caps: ["doc"], kbd: "Ctrl K" },
  addPage: { caps: ["ctrl", "doc"], kbd: "Ctrl I" },
};

export type Resolved = {
  /** Item positions, level by level. */
  indices: number[];
  /** The items passed through, level by level, last one included. */
  items: MenuItem[];
  action: MenuAction;
};

/** A label path to positions in the live menu, or null when an item is missing, moved or not built. */
export function resolve(menu: MenuName, path: string[]): Resolved | null {
  let level: MenuItem[] = MENUS[menu];
  const indices: number[] = [];
  const items: MenuItem[] = [];
  for (const label of path) {
    const i = level.findIndex((it) => it.label === label);
    const item = level[i];
    if (!item || !isEnabled(item)) return null;
    indices.push(i);
    items.push(item);
    level = item.items ?? [];
  }
  const action = items[items.length - 1]?.action;
  return action ? { indices, items, action } : null;
}

/** A way written out for reading: keys to press, and what they reach. */
export type WayLine = { caps: string[]; kbd: string | null; say: string };

export function wayLine(way: Way): WayLine | null {
  if (way.kind === "keys") return { caps: way.caps, kbd: way.kbd, say: way.say };
  // A command typed by name is in the catalog on the handheld; other typing needs no key line.
  if (way.kind === "type") return /^[A-Za-z]\w*\($/.test(way.text) ? { caps: ["Catalog"], kbd: null, say: way.text } : null;
  const r = resolve(way.menu, way.path);
  if (!r) return null;
  const open = OPEN[way.menu];
  return {
    caps: [...open.caps, ...r.indices.map((i) => menuKey(i).toLowerCase())],
    kbd: open.kbd,
    say: r.items.map((it) => it.label.replace(/\.\.\.$/, "")).join(" › "),
  };
}

/** What the first way puts on the entry line, if it's a command a student could also type. */
export function typedName(entry: HowTo): string | null {
  const way = entry.ways[0];
  if (way?.kind === "type") return way.text;
  if (way?.kind !== "menu") return null;
  const action = resolve(way.menu, way.path)?.action;
  if (action?.kind === "insert" && /^[A-Za-z][\w⁻¹]*\($/.test(action.text)) return action.text;
  if (action?.kind === "wizard") return action.build.match(/^([A-Za-z]\w*)\(/)?.[0] ?? null;
  return null;
}

/** How the command is written: the entry's own, or the catalog's line for the command it reaches. */
export function syntaxOf(entry: HowTo): string | null {
  if (entry.syntax) return entry.syntax;
  const name = typedName(entry);
  if (!name) return null;
  return CATALOG.find((c) => c.name.toLowerCase() === name.toLowerCase())?.syntax ?? null;
}

/**
 * The syntax of what Show me puts on the line. An entry done in two steps
 * (solve, then integrate) lands its first command, so the hint is that
 * command's, not the whole recipe's.
 */
export function landedSyntax(entry: HowTo): string | null {
  const menus = entry.ways.filter((w) => w.kind === "menu");
  if (menus.length < 2 || entry.ways[0]?.kind !== "menu") return syntaxOf(entry);
  const name = typedName(entry);
  return (name && CATALOG.find((c) => c.name.toLowerCase() === name.toLowerCase())?.syntax) ?? null;
}
