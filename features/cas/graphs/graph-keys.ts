// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 VCE Hub. Part of the /cas calculator: https://github.com/vcehub/cas
import type { Key } from "../keys";
import { parse } from "../math/ast";
import * as E from "../math/editor";
import { astToRow, chars, rowToLinear } from "../math/tree";
import type { GraphsPage } from "../state/document";
import type { AnalyzeKind } from "./model";

/**
 * The Graphs page's response to a key. Defining a function and finishing an
 * analysis need the engine, so those come back as effects.
 */
export type GraphEffect =
  | { define: { n: number; text: string } }
  | { relation: { n: number; text: string } }
  | { parametric: { n: number; texts: string[] } }
  | { de: { n: number; texts: string[] } }
  | { analyze: { type: AnalyzeKind; fn: number; a: number; b: number } }
  | null;

/**
 * The next function number: the lowest not used on this page or anywhere
 * else in the problem (`taken`: other Graphs pages and f1, f2 … defined in
 * the Calculator), as on the handheld, where f1, f2, f3 … run across a
 * problem's pages.
 */
export function nextFree(p: GraphsPage, taken: ReadonlySet<number> = new Set()): number {
  const used = new Set([...taken, ...p.functions.map((f) => f.n)]);
  let n = 1;
  while (used.has(n)) n++;
  return n;
}

/** Open the entry line on f(n), loaded with its current definition. */
export function openEntry(p: GraphsPage, n = nextFree(p)): GraphsPage {
  const f = p.functions.find((x) => x.n === n);
  let row = f?.row ?? [];
  if (f && !row.length) {
    try {
      row = astToRow(parse(f.text));
    } catch {
      row = chars(f.text);
    }
  }
  return { ...p, editing: n, entryKind: undefined, edit: E.setRow(row), tool: null };
}

const nextRel = (p: GraphsPage) => Math.max(0, ...(p.relations ?? []).map((r) => r.n)) + 1;

const nextPar = (p: GraphsPage) => Math.max(0, ...(p.parametrics ?? []).map((r) => r.n)) + 1;

/**
 * Open the parametric entry line on x(n)/y(n): five fields, x(t), y(t),
 * tmin, tmax and tstep, defaulting to 0 ≤ t ≤ 6.28 in steps of 0.13 (0 to
 * 360 in steps of 7.5 in degrees), as on the handheld.
 */
export function openParametric(p: GraphsPage, degrees = false, n = nextPar(p)): GraphsPage {
  const c = (p.parametrics ?? []).find((x) => x.n === n);
  const num = (v: number) => chars(String(Number(v.toPrecision(6))));
  const rows = c
    ? [c.xRow, c.yRow, num(c.tmin), num(c.tmax), num(c.tstep)]
    : [[], [], chars("0"), chars(degrees ? "360" : "6.28"), chars(degrees ? "7.5" : "0.13")];
  return { ...p, editing: n, entryKind: "par", parDraft: { field: 0, rows }, edit: E.setRow(rows[0]!), tool: null };
}

const nextDE = (p: GraphsPage) => Math.max(0, ...(p.des ?? []).map((d) => d.n)) + 1;

/** A Diff Eq's y: its own, or the lowest the page's parametric curves and other Diff Eqs leave free (y-names are shared). */
export function deY(p: GraphsPage, n: number): number {
  const own = (p.des ?? []).find((d) => d.n === n);
  if (own) return own.y;
  const used = new Set([...(p.parametrics ?? []).map((c) => c.n), ...(p.des ?? []).map((d) => d.y)]);
  let y = 1;
  while (used.has(y)) y++;
  return y;
}

/** Open the Diff Eq entry line on d(n): y′ = f, then the initial condition (x0, y0), both optional. */
export function openDE(p: GraphsPage, n = nextDE(p)): GraphsPage {
  const d = (p.des ?? []).find((x) => x.n === n);
  const num = (v: number | undefined) => (v === undefined ? [] : chars(String(Number(v.toPrecision(6)))));
  const rows = [d?.row ?? [], num(d?.x0), num(d?.y0)];
  return { ...p, editing: n, entryKind: "de", parDraft: { field: 0, rows }, edit: E.setRow(rows[0]!), tool: null };
}

/** Move the parametric entry to another field, keeping what was typed. */
function parField(p: GraphsPage, field: number): GraphsPage {
  const d = p.parDraft!;
  const rows = d.rows.map((r, i) => (i === d.field ? p.edit.row : r));
  const f = (field + rows.length) % rows.length;
  // The field's contents are selected on arrival, so typing replaces them.
  return { ...p, parDraft: { field: f, rows, fresh: true }, edit: E.setRow(rows[f]!) };
}

/** Open the entry line on rel(n), loaded with its current relation. */
export function openRelation(p: GraphsPage, n = nextRel(p)): GraphsPage {
  const r = (p.relations ?? []).find((x) => x.n === n);
  return { ...p, editing: n, entryKind: "rel", edit: E.setRow(r?.row ?? []), tool: null };
}

export function graphKey(
  p: GraphsPage,
  key: Key,
  taken: ReadonlySet<number> = new Set(),
): { page: GraphsPage; effect: GraphEffect } {
  const done = (q: Partial<GraphsPage>, effect: GraphEffect = null) => ({ page: { ...p, ...q }, effect });
  const visible = p.functions.filter((f) => !f.hidden).map((f) => f.n);
  const step = (p.window.xmax - p.window.xmin) / 100;

  if (key.k === "table") return done({ table: !p.table });

  if (p.tool) {
    const tool = p.tool;
    switch (key.k) {
      case "left":
      case "right": {
        const sign = key.k === "left" ? -1 : 1;
        if (tool.kind === "trace" && tool.curve) {
          const c = tool.curve;
          if (!Number.isFinite(c.at)) return done({});
          if (c.kind === "rel") return done({ tool: { ...tool, curve: { ...c, at: c.at + sign * relStep(p) } } });
          const par = (p.parametrics ?? []).find((q) => q.n === c.n);
          if (!par) return done({});
          // The trace moves in steps of its own, not tstep (0.092 on 0 ≤ t ≤ 6.28).
          const at = Math.max(par.tmin, Math.min(par.tmax, c.at + (sign * (par.tmax - par.tmin)) / 68));
          return done({ tool: { ...tool, curve: { ...c, at } } });
        }
        const x = tool.x + sign * step;
        // Moving the bound while choosing a graph takes the highlighted one.
        if (tool.kind === "bounds" && tool.stage === "graph") return done({ tool: { ...tool, stage: "lower", x } });
        return done({ tool: { ...tool, x } });
      }
      case "up":
      case "down": {
        // Graph Trace moves through every graph: functions, then relations, then parametric curves.
        if (tool.kind === "trace") {
          const all = traceTargets(p);
          if (!all.length) return done({});
          const i = all.findIndex((t) => (tool.curve ? t.kind === tool.curve.kind && t.n === tool.curve.n : t.kind === "fn" && t.n === tool.fn));
          const t = all[(i + (key.k === "up" ? all.length - 1 : 1)) % all.length]!;
          if (t.kind === "fn") return done({ tool: { kind: "trace", fn: t.n, x: tool.x } });
          const par = (p.parametrics ?? []).find((c) => c.n === t.n);
          const at = t.kind === "par" && par ? parStart(par) : NaN;
          return done({ tool: { ...tool, curve: { kind: t.kind, n: t.n, at } } });
        }
        if (!visible.length) return done({});
        const i = visible.indexOf(tool.fn);
        const fn = visible[(i + (key.k === "up" ? visible.length - 1 : 1)) % visible.length]!;
        return done({ tool: { ...tool, fn } });
      }
      case "enter":
        if (tool.kind === "bounds") {
          if (tool.stage === "graph") return done({ tool: { ...tool, stage: "lower" } });
          if (tool.stage === "lower") return done({ tool: { ...tool, stage: "upper", lower: tool.x } });
          const a = Math.min(tool.lower ?? tool.x, tool.x);
          const b = Math.max(tool.lower ?? tool.x, tool.x);
          return done({ tool: null }, { analyze: { type: tool.type, fn: tool.fn, a, b } });
        }
        return done({});
      case "esc":
        return done({ tool: null });
      default:
        return done({});
    }
  }

  if (p.editing !== null && (p.entryKind === "par" || p.entryKind === "de") && p.parDraft) {
    const field = p.parDraft.field;
    // ↑ from a Diff Eq's first field and ↓ from its last go to the one before or after, as ↑ and ↓ step through functions.
    if (p.entryKind === "de" && ((key.k === "up" && field === 0) || (key.k === "down" && field === p.parDraft.rows.length - 1))) {
      const ns = (p.des ?? []).map((d) => d.n).sort((a, b) => a - b);
      const all = ns.includes(p.editing) ? [...ns, nextDE(p)] : [...ns, p.editing];
      const i = all.indexOf(p.editing);
      const j = Math.max(0, Math.min(all.length - 1, i + (key.k === "up" ? -1 : 1)));
      return { page: j === i ? p : openDE(p, all[j]!), effect: null };
    }
    switch (key.k) {
      case "tab":
      case "down":
        return { page: parField(p, field + 1), effect: null };
      case "up":
        return { page: parField(p, field - 1), effect: null };
      case "enter": {
        const rows = p.parDraft.rows.map((r, i) => (i === field ? p.edit.row : r));
        const texts = rows.map(rowToLinear);
        if (p.entryKind === "de") {
          if (!texts[0]) return done({ editing: null, parDraft: undefined });
          return done({ editing: null, parDraft: undefined }, { de: { n: p.editing, texts } });
        }
        if (!texts[0] || !texts[1]) return done({ editing: null, parDraft: undefined });
        return done({ editing: null, parDraft: undefined }, { parametric: { n: p.editing, texts } });
      }
      case "esc":
        return done({ editing: null, parDraft: undefined });
      case "char":
      case "text":
      case "paste":
      case "template":
        // Typing into a field just arrived at replaces what was there.
        if (p.parDraft.fresh)
          return graphKey({ ...p, parDraft: { ...p.parDraft, fresh: false }, edit: E.emptyEdit() }, key, taken);
        break;
      default:
        if (p.parDraft.fresh) return graphKey({ ...p, parDraft: { ...p.parDraft, fresh: false } }, key, taken);
    }
  }

  if (p.editing !== null) {
    if (E.selection(p.edit)) {
      const r = E.keyOnSelection(p.edit, key);
      return r.done ? done({ edit: r.edit }) : graphKey({ ...p, edit: r.edit }, key, taken);
    }
    const edit = (fn: (s: E.EditState) => E.EditState) => done({ edit: fn(p.edit) });
    switch (key.k) {
      case "selectAll":
        return edit(E.selectAll);
      case "selectLeft":
        return edit((s) => E.extendSelection(s, "left"));
      case "selectRight":
        return edit((s) => E.extendSelection(s, "right"));
      case "enter": {
        const text = p.edit.row.length ? E.rowText(p.edit) : "";
        if (!text) return done({ editing: null });
        if (p.entryKind === "rel") return done({ editing: null }, { relation: { n: p.editing, text } });
        return done({ editing: null }, { define: { n: p.editing, text } });
      }
      case "esc":
        return done({ editing: null });
      case "up":
      case "down": {
        // Up and down step through the defined functions (or relations) in the entry line.
        const rel = p.entryKind === "rel";
        const ns = (rel ? (p.relations ?? []) : p.functions).map((f) => f.n).sort((a, b) => a - b);
        const all = [...ns, rel ? nextRel(p) : nextFree(p, taken)];
        const i = all.indexOf(p.editing);
        const j = Math.max(0, Math.min(all.length - 1, i + (key.k === "up" ? -1 : 1)));
        return { page: rel ? openRelation(p, all[j]!) : openEntry(p, all[j]!), effect: null };
      }
      case "char":
        return edit((s) => E.typeChar(s, key.c));
      case "text":
      case "paste":
        return edit((s) => E.insertText(s, key.text));
      case "template":
        return edit((s) => E.insertTemplate(s, key.id));
      case "backspace":
        return edit(E.backspace);
      case "delete":
        return edit(E.deleteForward);
      case "left":
        return edit(E.moveLeft);
      case "right":
        return edit(E.moveRight);
      case "home":
        return edit(E.moveHome);
      case "end":
        return edit(E.moveEnd);
      case "tab":
        return edit(E.nextSlot);
      default:
        return done({});
    }
  }

  switch (key.k) {
    case "tab":
    case "enter":
      return { page: openEntry(p, nextFree(p, taken)), effect: null };
    case "esc":
      return done({ tool: null });
    case "char":
      // Typing with the entry line hidden opens it, as on the handheld.
      return graphKey(openEntry(p, nextFree(p, taken)), key, taken);
    default:
      return done({});
  }
}

/** How far one arrow press moves the trace along a relation's curve (0.076 on the standard window). */
const relStep = (p: GraphsPage) => (p.window.xmax - p.window.xmin) / 264;

/** Every graph Graph Trace can be on, in the order ↑ and ↓ move through them. */
function traceTargets(p: GraphsPage): { kind: "fn" | "rel" | "par"; n: number }[] {
  return [
    ...p.functions.filter((f) => !f.hidden && f.text.trim()).map((f) => ({ kind: "fn" as const, n: f.n })),
    ...(p.relations ?? []).filter((r) => !r.hidden).map((r) => ({ kind: "rel" as const, n: r.n })),
    ...(p.parametrics ?? []).filter((c) => !c.hidden).map((c) => ({ kind: "par" as const, n: c.n })),
  ];
}

/** Where Graph Trace starts on a parametric curve (t = 0.608 on 0 ≤ t ≤ 6.28, as on the handheld). */
const parStart = (c: { tmin: number; tmax: number }) => c.tmin + (c.tmax - c.tmin) * 0.0968;

/**
 * Start an Analyze Graph tool, or Graph Trace, on the first visible function
 * (Graph Trace: or curve). An Analyze Graph tool with two or more graphs
 * starts by asking which one.
 */
export function startTool(p: GraphsPage, id: string): GraphsPage {
  const fn = p.functions.find((f) => !f.hidden)?.n;
  const mid = (p.window.xmin + p.window.xmax) / 2;
  const x = p.window.xmin < 0 && p.window.xmax > 0 ? 0 : mid;
  if (id === "graphTrace" && fn === undefined) {
    const t = traceTargets(p)[0];
    if (!t || t.kind === "fn") return p;
    const par = (p.parametrics ?? []).find((c) => c.n === t.n);
    const at = t.kind === "par" && par ? parStart(par) : NaN;
    return { ...p, editing: null, tool: { kind: "trace", fn: 1, x, curve: { kind: t.kind, n: t.n, at } } };
  }
  if (fn === undefined) return p;
  const kinds: Record<string, AnalyzeKind> = {
    analyzeZero: "zero",
    analyzeMinimum: "min",
    analyzeMaximum: "max",
    analyzeInflection: "inflection",
    analyzeIntegral: "integral",
    analyzeIntersection: "intersection",
  };
  if (id === "graphTrace") return { ...p, editing: null, tool: { kind: "trace", fn, x } };
  if (id === "analyzeDydx") return { ...p, editing: null, tool: { kind: "dydx", fn, x } };
  const type = kinds[id];
  if (!type) return p;
  const left = p.window.xmin + (p.window.xmax - p.window.xmin) * 0.25;
  // With more than one graph, ask which one first.
  const stage = p.functions.filter((f) => !f.hidden).length > 1 ? "graph" : "lower";
  return { ...p, editing: null, tool: { kind: "bounds", type, fn, stage, x: left } };
}
