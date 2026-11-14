// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 VCE Hub. Part of the /cas calculator: https://github.com/vcehub/cas
import { emptyEdit, type EditState } from "../math/editor";
import type { Row } from "../math/tree";
import { STANDARD, type GraphWindow, type Mark, type Tool } from "../graphs/model";

/**
 * One document of problems, each with any number of pages (1.1, 1.2, 2.1 …).
 * Variables live in the engine, so every page in a problem sees the same
 * ones; each problem has its own, as on the handheld (the engine is swapped
 * over when the active page moves to another problem).
 */
export type AppKind = "calculator" | "graphs";

export type HistoryEntry = {
  id: number;
  input: Row;
  /** The linear text that was evaluated (what Enter on a history row pastes). */
  inputText: string;
  output: Row;
  outputText: string;
  /**
   * The answer at the precision it was worked out to, when the output shows
   * it rounded to Display Digits: what ans carries on with after a reload.
   */
  ansText?: string;
  /** An error replaces the output, shown as the handheld's message. */
  error?: string;
  /** The handheld's ⚠ message for the answer, a line per string ("" between paragraphs). */
  warning?: string[];
};

/** A selected history item: up-arrow from the entry line walks these. */
/**
 * A selected history item; `scroll` is how many steps a too-wide one has been
 * scrolled with →. A click puts a caret in it instead (`caret`): the arrows
 * move it and shift+arrows select part of the line, which stays read-only.
 */
export type HistorySelection = { entry: number; part: "input" | "output"; scroll?: number; caret?: EditState };

export type CalculatorPage = {
  kind: "calculator";
  id: number;
  /** The problem it belongs to, 1 … (missing on documents saved before problems: 1). */
  problem?: number;
  history: HistoryEntry[];
  edit: EditState;
  sel: HistorySelection | null;
};

export type GraphFunction = {
  /** 1 for f1 … */
  n: number;
  text: string;
  row: Row;
  hidden?: boolean;
};

/** A relation in x and y: x²+y²=4 draws a curve, y<x+1 shades a region. */
export type RelationOp = "=" | "<" | ">" | "≤" | "≥" | "≠";
export type GraphRelation = { n: number; text: string; row: Row; op: RelationOp; hidden?: boolean };

/** A parametric curve: x(t) and y(t) for t from tmin to tmax in steps of tstep. */
export type GraphParametric = {
  n: number;
  x: string;
  y: string;
  xRow: Row;
  yRow: Row;
  tmin: number;
  tmax: number;
  tstep: number;
  hidden?: boolean;
};

/**
 * A differential equation y′ = f(x, y) (Graph Entry → Diff Eq): d1 with its
 * own y (y1, or the next one the page's parametric curves leave free), a
 * slope field, and the solution through (x0, y0) when that's given.
 */
export type GraphDE = { n: number; y: number; rhs: string; row: Row; x0?: number; y0?: number; hidden?: boolean };

/** The Differential Equation dialog's settings, one set per page; defaults as on the handheld. */
export type DESettings = {
  method: "Euler" | "Runge-Kutta";
  iterations: number;
  field: "Slope" | "None";
  start: number;
  end: number;
  step: number;
  resolution: number;
};
export const DE_DEFAULTS: DESettings = { method: "Euler", iterations: 1, field: "Slope", start: -10, end: 10, step: 0.1, resolution: 14 };

/**
 * A slider on a Graphs page: it sets a variable (shared with the rest of the
 * problem) between min and max. step "auto" is a tenth of the range (see
 * sliderStep).
 */
export type Slider = {
  name: string;
  value: number;
  min: number;
  max: number;
  step: number | "auto";
  vertical?: boolean;
  minimized?: boolean;
  animating?: boolean;
  /** Display Digits, as the settings list names it ("Float 3", the default). */
  digits?: string;
  /** Show Variable and Show Scale turned off (both are on by default). */
  hideName?: boolean;
  hideScale?: boolean;
  /** Where Move put it, as fractions of the graph's width and height; unset, it takes the next place down the left. */
  at?: { x: number; y: number };
};

export type GraphsPage = {
  kind: "graphs";
  id: number;
  problem?: number;
  functions: GraphFunction[];
  /** Missing on documents saved before relations existed. */
  relations?: GraphRelation[];
  parametrics?: GraphParametric[];
  des?: GraphDE[];
  deSettings?: DESettings;
  sliders?: Slider[];
  /** The parametric entry line's five fields (x, y, tmin, tmax, tstep), or a Diff Eq's three (f, x0, y0), while it's open; `field` is the one being edited. */
  parDraft?: { field: number; rows: Row[]; fresh?: boolean };
  window: GraphWindow;
  /** The entry line: which f (or rel) it's editing, or null when hidden. */
  editing: number | null;
  /** "rel", "par" or "de" while the entry line edits a relation, a parametric or a Diff Eq, else a function. */
  entryKind?: "rel" | "par" | "de";
  edit: EditState;
  tool: Tool | null;
  marks: Mark[];
  table: boolean;
  grid: "none" | "dot" | "line";
  axes: boolean;
};

export type Page = CalculatorPage | GraphsPage;

export type CasDocument = {
  title: string;
  pages: Page[];
  active: number;
  /** The engine definitions of each problem other than the active one, by problem number. */
  problems?: Record<string, string[]>;
};

let nextId = 1;
export const newId = () => nextId++;

/** After restoring a saved document, keep new ids clear of the old ones. */
export function bumpIds(doc: CasDocument): void {
  for (const p of doc.pages) {
    nextId = Math.max(nextId, p.id + 1);
    if (p.kind === "calculator") for (const h of p.history) nextId = Math.max(nextId, h.id + 1);
  }
}

export function newPage(kind: AppKind, problem = 1): Page {
  if (kind === "calculator") return { kind, id: newId(), problem, history: [], edit: emptyEdit(), sel: null };
  return {
    kind,
    id: newId(),
    problem,
    functions: [],
    window: STANDARD,
    editing: 1,
    edit: emptyEdit(),
    tool: null,
    marks: [],
    table: false,
    grid: "none",
    axes: true,
  };
}

export function newDocument(): CasDocument {
  return { title: "*Doc", pages: [newPage("calculator")], active: 0 };
}

export const problemOf = (p: Page | undefined): number => p?.problem ?? 1;

/** A page's label, problem.page: 2.1 is the first page of problem 2. */
export function pageLabel(doc: CasDocument, i: number): string {
  const p = doc.pages[i];
  const n = problemOf(p);
  const within = doc.pages.slice(0, i + 1).filter((q) => problemOf(q) === n).length;
  return `${n}.${within}`;
}

/** A new problem after the active one's last page: one Calculator page, active. */
export function insertProblem(doc: CasDocument): CasDocument {
  const current = problemOf(doc.pages[doc.active]);
  const next = Math.max(...doc.pages.map(problemOf)) + 1;
  let at = doc.active;
  while (at + 1 < doc.pages.length && problemOf(doc.pages[at + 1]) === current) at++;
  const pages = doc.pages.slice();
  pages.splice(at + 1, 0, newPage("calculator", next));
  return { ...doc, pages, active: at + 1 };
}
