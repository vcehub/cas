// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 VCE Hub. Part of the /cas calculator: https://github.com/vcehub/cas
import { COMMAND_WORDS, type Ast } from "./ast";
import { precOf } from "./print";

/**
 * The 2D expression tree: what the entry line edits and what history rows
 * display. Text is one node per character so the editor's cursor can sit
 * between any two; everything with a layout (a fraction, a power, a root,
 * growing brackets, a template) is a node with child rows.
 *
 * Characters are kept plain ("*", "-"); the renderer picks the glyph from
 * context (a centred dot, a raised negation sign or a minus).
 */
export type Row = Node[];

export type Node =
  | { t: "ch"; c: string }
  | { t: "frac"; num: Row; den: Row }
  | { t: "sup"; exp: Row }
  | { t: "sqrt"; arg: Row }
  | { t: "root"; idx: Row; arg: Row }
  | { t: "group"; open: "(" | "{" | "[" | "|"; arg: Row }
  | { t: "matrix"; cells: Row[][] }
  | { t: "piecewise"; rows: [Row, Row][] }
  | { t: "system"; rows: Row[] }
  | { t: "integral"; body: Row; v: Row; lo?: Row; hi?: Row }
  | { t: "deriv"; body: Row; v: Row; n?: Row }
  | { t: "bigop"; op: "Σ" | "Π"; body: Row; v: Row; lo: Row; hi: Row }
  | { t: "limit"; body: Row; v: Row; to: Row; dir?: Row }
  | { t: "logbase"; base: Row; arg: Row }
  | { t: "exp"; exp: Row };

export const chars = (s: string): Row => Array.from(s).map((c) => ({ t: "ch", c }));
const group = (open: "(" | "{" | "[" | "|", arg: Row): Node => ({ t: "group", open, arg });

/** Comma-joined rows, as inside a call's brackets. */
function joined(rows: Row[], sep = ","): Row {
  const out: Row = [];
  rows.forEach((r, i) => {
    if (i) out.push(...chars(sep));
    out.push(...r);
  });
  return out;
}

// ---------------------------------------------------------------- AST → tree

/** Lay out an AST for display, the way the handheld pretty-prints history. */
export function astToRow(a: Ast): Row {
  const r = astToRow;
  const wrapped = (x: Ast, need: boolean): Row => (need ? [group("(", r(x))] : r(x));
  switch (a.k) {
    case "num":
      return chars(a.v);
    case "sym":
      return chars(a.name);
    case "str":
      return chars(`"${a.v}"`);
    case "list":
      return [group("{", joined(a.items.map(r)))];
    case "mat":
      return [{ t: "matrix", cells: a.rows.map((row) => row.map(r)) }];
    case "neg":
      // −(a·b) and −a/b need no brackets; −(a+b) does.
      return [...chars("-"), ...wrapped(a.a, precOf(a.a) < 8 || a.a.k === "neg")];
    case "not":
      return [...chars("not "), ...wrapped(a.a, precOf(a.a) < 5)];
    case "post":
      return [...wrapped(a.a, precOf(a.a) < 11), ...chars(a.op)];
    case "define":
      return [...chars("Define "), ...r(a.lhs), ...chars("="), ...r(a.rhs)];
    case "call":
      return callToRow(a.f, a.args);
    case "bin": {
      if (a.op === "/") return [{ t: "frac", num: r(a.a), den: r(a.b) }];
      // Polar form is always written in brackets: (4∠π/3).
      if (a.op === "∠") return [group("(", [...r(a.a), ...chars("∠"), ...r(a.b)])];
      if (a.op === "^") {
        if (a.a.k === "sym" && a.a.name === "ℯ") return [{ t: "exp", exp: r(a.b) }];
        // A root as a base is bracketed too, as the handheld shows (√2)².
        const baseNeedsGroup =
          precOf(a.a) <= 10 || a.a.k === "bin" || (a.a.k === "call" && (a.a.f === "√" || a.a.f === "root"));
        return [...wrapped(a.a, baseNeedsGroup), { t: "sup", exp: r(a.b) }];
      }
      const prec = precOf(a);
      const rightTight = a.op === "-" || prec === 6;
      // In 2D a fraction groups itself, so a·(b/c) needs no brackets.
      const lp = a.a.k === "bin" && a.a.op === "/" ? 12 : precOf(a.a);
      const rp = a.b.k === "bin" && a.b.op === "/" ? 12 : precOf(a.b);
      const left = wrapped(a.a, lp < prec);
      const right = wrapped(a.b, rp < prec || (rightTight && rp === prec));
      const op = a.op === "and" || a.op === "or" || a.op === "xor" ? ` ${a.op} ` : a.op;
      return [...left, ...chars(op), ...right];
    }
  }
}

function callToRow(f: string, args: Ast[]): Row {
  const r = astToRow;
  const [a0, a1, a2, a3] = args;
  // DelVar a, OneVar {1,2,3},1: commands are written without brackets.
  if (COMMAND_WORDS.has(f)) {
    const out: Row = chars(args.length ? `${f} ` : f);
    args.forEach((x, i) => out.push(...(i ? chars(",") : []), ...r(x)));
    return out;
  }
  if (f === "√" && a0) return [{ t: "sqrt", arg: r(a0) }];
  if (f === "root" && a0 && a1) return [{ t: "root", idx: r(a1), arg: r(a0) }];
  if (f === "abs" && args.length === 1 && a0) return [group("|", r(a0))];
  if (f === "exp" && args.length === 1 && a0) return [{ t: "exp", exp: r(a0) }];
  if (f === "log" && args.length === 2 && a0 && a1) return [{ t: "logbase", base: r(a1), arg: r(a0) }];
  if (f === "d" && a0 && a1) return [{ t: "deriv", body: r(a0), v: r(a1), ...(a2 ? { n: r(a2) } : {}) }];
  if (f === "∫" && a0 && a1 && (args.length === 2 || args.length === 4))
    return [{ t: "integral", body: r(a0), v: r(a1), ...(a2 && a3 ? { lo: r(a2), hi: r(a3) } : {}) }];
  if ((f === "Σ" || f === "Π") && a0 && a1 && a2 && a3)
    return [{ t: "bigop", op: f, body: r(a0), v: r(a1), lo: r(a2), hi: r(a3) }];
  if (f === "limit" && a0 && a1 && a2)
    return [{ t: "limit", body: r(a0), v: r(a1), to: r(a2), ...(args[3] ? { dir: r(args[3]) } : {}) }];
  if (f === "piecewise" && args.length >= 2) {
    const rows: [Row, Row][] = [];
    for (let i = 0; i < args.length; i += 2) rows.push([r(args[i]!), args[i + 1] ? r(args[i + 1]!) : []]);
    return [{ t: "piecewise", rows }];
  }
  if (f === "index" && a0) return [...r(a0), group("[", joined(args.slice(1).map(r)))];
  return [...chars(f), group("(", joined(args.map(r)))];
}

// ---------------------------------------------------------------- tree → text

/** Linear text for an edited row, ready for the parser. */
export function rowToLinear(row: Row): string {
  let out = "";
  for (const n of row) out += nodeToLinear(n);
  return out;
}

const lin = rowToLinear;
const paren = (row: Row) => `(${lin(row)})`;

function nodeToLinear(n: Node): string {
  switch (n.t) {
    case "ch":
      return n.c;
    case "frac":
      return `${paren(n.num)}/${paren(n.den)}`;
    case "sup":
      return `^${paren(n.exp)}`;
    case "sqrt":
      return `√${paren(n.arg)}`;
    case "root":
      return `root(${lin(n.arg)},${lin(n.idx)})`;
    case "group":
      if (n.open === "|") return `abs(${lin(n.arg)})`;
      return n.open === "(" ? paren(n.arg) : n.open === "{" ? `{${lin(n.arg)}}` : `[${lin(n.arg)}]`;
    case "matrix":
      if (n.cells.length === 1) return `[${n.cells[0]!.map(lin).join(",")}]`;
      return `[${n.cells.map((row) => `[${row.map(lin).join(",")}]`).join("")}]`;
    case "piecewise":
      return `piecewise(${n.rows.map(([e, c]) => (c.length ? `${lin(e)},${lin(c)}` : lin(e))).join(",")})`;
    case "system":
      return `{${n.rows.map(lin).join(",")}}`;
    case "integral":
      // Bounds left empty make it an indefinite integral, as on the handheld.
      return n.lo?.length && n.hi?.length
        ? `∫(${lin(n.body)},${lin(n.v)},${lin(n.lo)},${lin(n.hi)})`
        : `∫(${lin(n.body)},${lin(n.v)})`;
    case "deriv":
      return n.n ? `d(${lin(n.body)},${lin(n.v)},${lin(n.n)})` : `d(${lin(n.body)},${lin(n.v)})`;
    case "bigop":
      return `${n.op}(${lin(n.body)},${lin(n.v)},${lin(n.lo)},${lin(n.hi)})`;
    case "limit":
      return n.dir && n.dir.length
        ? `limit(${lin(n.body)},${lin(n.v)},${lin(n.to)},${lin(n.dir)})`
        : `limit(${lin(n.body)},${lin(n.v)},${lin(n.to)})`;
    case "logbase":
      // A base left empty is base 10, as on the handheld.
      return n.base.length ? `log(${lin(n.arg)},${lin(n.base)})` : `log(${lin(n.arg)})`;
    case "exp":
      return `ℯ^${paren(n.exp)}`;
  }
}
