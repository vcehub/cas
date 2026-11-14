// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 VCE Hub. Part of the /cas calculator: https://github.com/vcehub/cas
import type { Key } from "../keys";
import type { TemplateId } from "../menus/types";
import { getSlot, replaceRowAt, rowAt, slotsOf, type Cursor, type Step } from "./cursor";
import { chars, rowToLinear, type Node, type Row } from "./tree";

/**
 * Entry-line editing as pure functions over (tree, cursor). Behaviour follows
 * the handheld: "^" opens an exponent box, brackets come in pairs with the
 * cursor between them, "/" stays a plain slash (the fraction template is a
 * separate key), the arrows walk into and out of template slots, and
 * backspace at the start of a slot removes an empty template or unwraps
 * brackets.
 */
export type EditState = {
  row: Row;
  cursor: Cursor;
  /**
   * Where a selection starts, in the cursor's row; it runs to the cursor.
   * Set by dragging, shift+arrows or Ctrl+A, and the next key acts on it.
   */
  anchor?: number;
};

export const emptyEdit = (): EditState => ({ row: [], cursor: { path: [], index: 0 } });

const at = (s: EditState) => rowAt(s.row, s.cursor.path);

function splice(s: EditState, nodes: Node[], enter?: { offset: number; slot: string }): EditState {
  const cur = at(s);
  const i = s.cursor.index;
  const next = [...cur.slice(0, i), ...nodes, ...cur.slice(i)];
  const row = replaceRowAt(s.row, s.cursor.path, next);
  if (enter) {
    return { row, cursor: { path: [...s.cursor.path, { node: i + enter.offset, slot: enter.slot }], index: 0 } };
  }
  return { row, cursor: { path: s.cursor.path, index: i + nodes.length } };
}

const group = (open: "(" | "{" | "[" | "|"): Node => ({ t: "group", open, arg: [] });

export function templateNode(id: TemplateId): Node {
  switch (id) {
    case "frac":
      return { t: "frac", num: [], den: [] };
    case "pow":
      return { t: "sup", exp: [] };
    case "sqrt":
      return { t: "sqrt", arg: [] };
    case "nroot":
      return { t: "root", idx: [], arg: [] };
    case "abs":
      return group("|");
    case "exp":
      return { t: "exp", exp: [] };
    case "logbase":
      return { t: "logbase", base: [], arg: [] };
    case "deriv":
      return { t: "deriv", v: [], body: [] };
    case "nderiv":
      return { t: "deriv", n: [], v: [], body: [] };
    case "integral":
      return { t: "integral", body: [], v: [] };
    case "defintegral":
      return { t: "integral", lo: [], hi: [], body: [], v: [] };
    case "limit":
      return { t: "limit", v: [], to: [], body: [] };
    case "sum":
      return { t: "bigop", op: "Σ", v: [], lo: [], hi: [], body: [] };
    case "product":
      return { t: "bigop", op: "Π", v: [], lo: [], hi: [], body: [] };
    case "piecewise2":
      return { t: "piecewise", rows: [[[], []], [[], []]] };
    case "system2":
      return { t: "system", rows: [[], []] };
    case "matrix":
      return { t: "matrix", cells: [[[], []], [[], []]] };
  }
}

export function insertTemplate(s: EditState, id: TemplateId): EditState {
  const node = templateNode(id);
  const first = slotsOf(node)[0];
  return first ? splice(s, [node], { offset: 0, slot: first }) : splice(s, [node]);
}

export function insertMatrix(s: EditState, rows: number, cols: number): EditState {
  const cells: Row[][] = Array.from({ length: rows }, () => Array.from({ length: cols }, () => []));
  return splice(s, [{ t: "matrix", cells }], { offset: 0, slot: "c.0.0" });
}

/** One typed key's worth of text. */
export function typeChar(s: EditState, c: string): EditState {
  if (c === "^") return insertTemplate(s, "pow");
  // >= and <= become ≥ and ≤ as they're typed, as on the handheld.
  if (c === "=") {
    const prev = at(s)[s.cursor.index - 1];
    const merged = prev?.t === "ch" ? { ">": "≥", "<": "≤" }[prev.c] : undefined;
    if (merged) return splice(backspace(s), chars(merged));
  }
  if (c === "(" || c === "{" || c === "[") return splice(s, [group(c)], { offset: 0, slot: "arg" });
  if (c === ")" || c === "}" || c === "]") {
    // Typing the closing bracket of the group we're in steps out of it.
    const parent = parentOf(s);
    const want = c === ")" ? "(" : c === "}" ? "{" : "[";
    if (parent && parent.node.t === "group" && parent.node.open === want && s.cursor.index === at(s).length) {
      return { row: s.row, cursor: { path: parent.path, index: parent.index + 1 } };
    }
  }
  return splice(s, chars(c));
}

/**
 * Text from a menu or the catalog: "solve(" becomes solve with an open
 * bracket pair and the cursor inside it.
 */
export function insertText(s: EditState, text: string): EditState {
  if (text.endsWith("(")) {
    const name = splice(s, chars(text.slice(0, -1)));
    return splice(name, [group("(")], { offset: 0, slot: "arg" });
  }
  return splice(s, chars(text));
}

type Parent = { node: Node; path: Step[]; index: number; slot: string };

function parentOf(s: EditState): Parent | null {
  const path = s.cursor.path;
  if (!path.length) return null;
  const step = path[path.length - 1]!;
  const outer = path.slice(0, -1);
  const node = rowAt(s.row, outer)[step.node];
  return node ? { node, path: outer, index: step.node, slot: step.slot } : null;
}

const isEmptyTemplate = (n: Node) => slotsOf(n).every((slot) => getSlot(n, slot).length === 0);

export function backspace(s: EditState): EditState {
  const cur = at(s);
  const i = s.cursor.index;
  if (i > 0) {
    const prev = cur[i - 1]!;
    if (prev.t !== "ch" && !isEmptyTemplate(prev)) {
      // Backspace onto a filled template goes inside it, at the end of its last slot.
      return moveLeft(s);
    }
    const row = replaceRowAt(s.row, s.cursor.path, [...cur.slice(0, i - 1), ...cur.slice(i)]);
    return { row, cursor: { path: s.cursor.path, index: i - 1 } };
  }
  const parent = parentOf(s);
  if (!parent) return s;
  const outer = rowAt(s.row, parent.path);
  const slots = slotsOf(parent.node);
  // Brackets and a sole-slot template unwrap, keeping what was inside.
  if (parent.node.t === "group" || parent.node.t === "sup" || slots.length === 1 || isEmptyTemplate(parent.node)) {
    const inside = slots.length === 1 ? getSlot(parent.node, slots[0]!) : [];
    const next = [...outer.slice(0, parent.index), ...inside, ...outer.slice(parent.index + 1)];
    return { row: replaceRowAt(s.row, parent.path, next), cursor: { path: parent.path, index: parent.index } };
  }
  return moveLeft(s);
}

export function deleteForward(s: EditState): EditState {
  const r = moveRight(s);
  if (r === s) return s;
  return backspace(r);
}

export function moveLeft(s: EditState): EditState {
  const cur = at(s);
  const i = s.cursor.index;
  if (i > 0) {
    const prev = cur[i - 1]!;
    const slots = slotsOf(prev);
    const last = slots[slots.length - 1];
    if (last) {
      const inner = getSlot(prev, last);
      return { row: s.row, cursor: { path: [...s.cursor.path, { node: i - 1, slot: last }], index: inner.length } };
    }
    return { row: s.row, cursor: { path: s.cursor.path, index: i - 1 } };
  }
  const parent = parentOf(s);
  if (!parent) return s;
  const slots = slotsOf(parent.node);
  const k = slots.indexOf(parent.slot);
  if (k > 0) {
    const prevSlot = slots[k - 1]!;
    const inner = getSlot(parent.node, prevSlot);
    return { row: s.row, cursor: { path: [...parent.path, { node: parent.index, slot: prevSlot }], index: inner.length } };
  }
  return { row: s.row, cursor: { path: parent.path, index: parent.index } };
}

export function moveRight(s: EditState): EditState {
  const cur = at(s);
  const i = s.cursor.index;
  if (i < cur.length) {
    const next = cur[i]!;
    const first = slotsOf(next)[0];
    if (first) return { row: s.row, cursor: { path: [...s.cursor.path, { node: i, slot: first }], index: 0 } };
    return { row: s.row, cursor: { path: s.cursor.path, index: i + 1 } };
  }
  const parent = parentOf(s);
  if (!parent) return s;
  const slots = slotsOf(parent.node);
  const k = slots.indexOf(parent.slot);
  if (k >= 0 && k < slots.length - 1) {
    return { row: s.row, cursor: { path: [...parent.path, { node: parent.index, slot: slots[k + 1]! }], index: 0 } };
  }
  return { row: s.row, cursor: { path: parent.path, index: parent.index + 1 } };
}

/** Tab: to the next empty-or-not slot of the template we're in, else right. */
export function nextSlot(s: EditState): EditState {
  const parent = parentOf(s);
  if (!parent) return moveRight(s);
  const slots = slotsOf(parent.node);
  const k = slots.indexOf(parent.slot);
  if (k < slots.length - 1) {
    return { row: s.row, cursor: { path: [...parent.path, { node: parent.index, slot: slots[k + 1]! }], index: 0 } };
  }
  return { row: s.row, cursor: { path: parent.path, index: parent.index + 1 } };
}

/** Up and down move between a fraction's numerator and denominator. */
export function moveVertical(s: EditState, dir: "up" | "down"): EditState | null {
  const path = s.cursor.path;
  for (let d = path.length - 1; d >= 0; d--) {
    const step = path[d]!;
    const node = rowAt(s.row, path.slice(0, d))[step.node];
    if (node?.t !== "frac") continue;
    const target = dir === "up" ? "num" : "den";
    if (step.slot === target) return null;
    const inner = getSlot(node, target);
    return {
      row: s.row,
      cursor: { path: [...path.slice(0, d), { node: step.node, slot: target }], index: Math.min(s.cursor.index, inner.length) },
    };
  }
  return null;
}

export const moveHome = (s: EditState): EditState => ({ row: s.row, cursor: { path: [], index: 0 } });
export const moveEnd = (s: EditState): EditState => ({ row: s.row, cursor: { path: [], index: s.row.length } });

/** Insert nodes at the cursor, optionally stepping into one's slot. */
export const insertNodes = (s: EditState, nodes: Node[], enter?: { offset: number; slot: string }): EditState =>
  splice(s, nodes, enter);

/** Paste a laid-out expression at the cursor. */
export const insertRow = (s: EditState, row: Row): EditState => splice(s, row);

/** Replace everything with a row, cursor at the end. */
export const setRow = (row: Row): EditState => ({ row, cursor: { path: [], index: row.length } });

/** The edited expression as linear text. */
export const rowText = (s: EditState): string => rowToLinear(s.row);

/** Ctrl+A: select the whole line, if there's anything on it. */
export const selectAll = (s: EditState): EditState =>
  s.row.length ? { row: s.row, cursor: { path: [], index: s.row.length }, anchor: 0 } : s;

/** The selected stretch of the cursor's row, or null when nothing is selected. */
export function selection(s: EditState): { path: Step[]; from: number; to: number } | null {
  if (s.anchor === undefined || s.anchor === s.cursor.index) return null;
  return { path: s.cursor.path, from: Math.min(s.anchor, s.cursor.index), to: Math.max(s.anchor, s.cursor.index) };
}

/** The selection as linear text, for Ctrl+C. */
export function selectionText(s: EditState): string {
  const r = selection(s);
  return r ? rowToLinear(at(s).slice(r.from, r.to)) : "";
}

/** The selected nodes themselves, to paste somewhere else as they are. */
export function selectedNodes(s: EditState): Node[] {
  const r = selection(s);
  return r ? at(s).slice(r.from, r.to) : [];
}

function deleteSelection(s: EditState): EditState {
  const r = selection(s);
  if (!r) return { row: s.row, cursor: s.cursor };
  const cur = at(s);
  const row = replaceRowAt(s.row, r.path, [...cur.slice(0, r.from), ...cur.slice(r.to)]);
  return { row, cursor: { path: r.path, index: r.from } };
}

/**
 * A drag from `a` to `b`. Both ends are taken to the deepest row they share;
 * an end inside a template there takes the whole template, as in the
 * handheld's software. The cursor goes to the `b` end.
 */
export function selectBetween(s: EditState, a: Cursor, b: Cursor): EditState {
  let d = 0;
  while (d < a.path.length && d < b.path.length && a.path[d]!.node === b.path[d]!.node && a.path[d]!.slot === b.path[d]!.slot) d++;
  const path = a.path.slice(0, d);
  // An end below the shared row sits inside one of its nodes: halfway across it.
  const pos = (c: Cursor) => (c.path.length > d ? c.path[d]!.node + 0.5 : c.index);
  const pa = pos(a);
  const pb = pos(b);
  if (pa === pb) {
    // Two slots of one template (a fraction's top and bottom) select all of it.
    return pa % 1 ? { row: s.row, cursor: { path, index: pa + 0.5 }, anchor: pa - 0.5 } : { row: s.row, cursor: b };
  }
  const forward = pb > pa;
  return {
    row: s.row,
    cursor: { path, index: forward ? Math.ceil(pb) : Math.floor(pb) },
    anchor: forward ? Math.floor(pa) : Math.ceil(pa),
  };
}

/** Shift+← and shift+→: grow or shrink the selection by one; at a slot's edge, take its whole template. */
export function extendSelection(s: EditState, dir: "left" | "right"): EditState {
  const i = s.cursor.index + (dir === "left" ? -1 : 1);
  if (i >= 0 && i <= at(s).length) return { row: s.row, cursor: { path: s.cursor.path, index: i }, anchor: s.anchor ?? s.cursor.index };
  const parent = parentOf(s);
  if (!parent) return s;
  const left = dir === "left";
  return {
    row: s.row,
    cursor: { path: parent.path, index: left ? parent.index : parent.index + 1 },
    anchor: left ? parent.index + 1 : parent.index,
  };
}

/**
 * A key while something is selected. Typing replaces the selection,
 * backspace or delete removes it, and left or right goes to that end of it;
 * those come back `done` or with the selection gone. Anything else drops the
 * selection, and the caller then applies the key to the returned state as
 * usual.
 */
export function keyOnSelection(s: EditState, key: Key): { edit: EditState; done: boolean } {
  const r = selection(s)!;
  const plain = { row: s.row, cursor: s.cursor };
  switch (key.k) {
    case "char":
    case "text":
    case "paste":
    case "template":
      return { edit: deleteSelection(s), done: false };
    case "backspace":
    case "delete":
      return { edit: deleteSelection(s), done: true };
    case "left":
      return { edit: { row: s.row, cursor: { path: r.path, index: r.from } }, done: true };
    case "right":
      return { edit: { row: s.row, cursor: { path: r.path, index: r.to } }, done: true };
    case "selectLeft":
      return { edit: extendSelection(s, "left"), done: true };
    case "selectRight":
      return { edit: extendSelection(s, "right"), done: true };
    case "selectAll":
      return { edit: selectAll(s), done: true };
    case "esc":
      return { edit: plain, done: true };
    default:
      return { edit: plain, done: false };
  }
}
