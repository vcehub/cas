// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 VCE Hub. Part of the /cas calculator: https://github.com/vcehub/cas
import type { Node, Row } from "./tree";

/**
 * Where the caret sits in a tree: a path of (node index, slot) steps from the
 * top row down into a template's child row, then an index within that row
 * (0 = before the first node). Slots are named per node type; a matrix cell
 * is "c.<row>.<col>", a piecewise piece "p.<i>.<0|1>", a system line "s.<i>".
 */
export type Slot = string;
export type Step = { node: number; slot: Slot };
export type Cursor = { path: Step[]; index: number };

/** A node's slots in the order tab and the arrow keys visit them. */
export function slotsOf(n: Node): Slot[] {
  switch (n.t) {
    case "ch":
      return [];
    case "frac":
      return ["num", "den"];
    case "sup":
    case "exp":
      return ["exp"];
    case "sqrt":
    case "group":
      return ["arg"];
    case "root":
      return ["idx", "arg"];
    case "logbase":
      return ["base", "arg"];
    case "deriv":
      return n.n ? ["n", "v", "body"] : ["v", "body"];
    case "integral":
      return n.lo ? ["lo", "hi", "body", "v"] : ["body", "v"];
    case "bigop":
      return ["v", "lo", "hi", "body"];
    case "limit":
      return ["v", "to", "body"];
    case "matrix":
      return n.cells.flatMap((row, r) => row.map((_, c) => `c.${r}.${c}`));
    case "piecewise":
      return n.rows.flatMap((_, i) => [`p.${i}.0`, `p.${i}.1`]);
    case "system":
      return n.rows.map((_, i) => `s.${i}`);
  }
}

export function getSlot(n: Node, s: Slot): Row {
  const parts = s.split(".");
  if (n.t === "matrix" && parts[0] === "c") return n.cells[Number(parts[1])]?.[Number(parts[2])] ?? [];
  if (n.t === "piecewise" && parts[0] === "p") return n.rows[Number(parts[1])]?.[Number(parts[2]) as 0 | 1] ?? [];
  if (n.t === "system" && parts[0] === "s") return n.rows[Number(parts[1])] ?? [];
  const v = (n as Record<string, unknown>)[s];
  return Array.isArray(v) ? (v as Row) : [];
}

export function withSlot(n: Node, s: Slot, row: Row): Node {
  const parts = s.split(".");
  if (n.t === "matrix" && parts[0] === "c") {
    const r = Number(parts[1]);
    const c = Number(parts[2]);
    return { ...n, cells: n.cells.map((cr, i) => (i === r ? cr.map((cell, j) => (j === c ? row : cell)) : cr)) };
  }
  if (n.t === "piecewise" && parts[0] === "p") {
    const i = Number(parts[1]);
    const side = Number(parts[2]);
    return {
      ...n,
      rows: n.rows.map((pr, k) => (k === i ? ((side === 0 ? [row, pr[1]] : [pr[0], row]) as [Row, Row]) : pr)),
    };
  }
  if (n.t === "system" && parts[0] === "s") {
    const i = Number(parts[1]);
    return { ...n, rows: n.rows.map((sr, k) => (k === i ? row : sr)) };
  }
  return { ...n, [s]: row } as Node;
}

/** The row the cursor's path leads to. */
export function rowAt(root: Row, path: Step[]): Row {
  let row = root;
  for (const step of path) {
    const n = row[step.node];
    if (!n) return [];
    row = getSlot(n, step.slot);
  }
  return row;
}

/** Replace the row at `path`, rebuilding every parent on the way up. */
export function replaceRowAt(root: Row, path: Step[], next: Row): Row {
  if (!path.length) return next;
  const [step, ...rest] = path;
  const n = root[step!.node];
  if (!n) return root;
  const inner = replaceRowAt(getSlot(n, step!.slot), rest, next);
  return root.map((x, i) => (i === step!.node ? withSlot(n, step!.slot, inner) : x));
}
