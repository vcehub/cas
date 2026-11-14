// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 VCE Hub. Part of the /cas calculator: https://github.com/vcehub/cas
import type { Ast } from "./ast";

/**
 * AST → linear entry text, with the fewest brackets that keep the meaning.
 * `implicit` keeps typed juxtaposition ("2x") for inputs; results always
 * print "*", which the display shows as the handheld's centred dot.
 */
export type PrintOptions = { implicit?: boolean; inMatrix?: boolean };

const PREC: Record<string, number> = {
  ":": 0.5,
  "→": 1.5,
  ":=": 1.5,
  "|": 2,
  or: 3,
  xor: 3,
  and: 4,
  "=": 6,
  "≠": 6,
  "<": 6,
  ">": 6,
  "≤": 6,
  "≥": 6,
  "∠": 6.5,
  "+": 7,
  "-": 7,
  "*": 8,
  "/": 8,
  "^": 10,
};

export function precOf(a: Ast): number {
  switch (a.k) {
    case "bin":
      return PREC[a.op] ?? 0;
    case "neg":
      return 9;
    case "not":
      return 5;
    case "define":
      return 0;
    case "post":
      return 11;
    case "num":
      // A negative literal behaves like a negation.
      return a.v.startsWith("-") ? 9 : 12;
    default:
      return 12;
  }
}

const SPACED = new Set(["and", "or", "xor"]);

export function print(a: Ast, opts: PrintOptions = {}): string {
  const p = (x: Ast) => print(x, opts);
  // A polar number outside a vector brings its own brackets: (2∠60)+1, not ((2∠60))+1.
  const bracketed = (x: Ast) => x.k === "bin" && x.op === "∠" && !opts.inMatrix;
  const wrap = (x: Ast, need: boolean) => (need && !bracketed(x) ? `(${p(x)})` : p(x));
  switch (a.k) {
    case "num":
      return a.v;
    case "sym":
      return a.name;
    case "str":
      return `"${a.v}"`;
    case "call":
      if (a.f === "index") return `${p(a.args[0]!)}[${a.args.slice(1).map(p).join(",")}]`;
      return `${a.f}(${a.args.map(p).join(",")})`;
    case "list":
      return `{${a.items.map(p).join(",")}}`;
    case "mat": {
      const q = (x: Ast) => print(x, { ...opts, inMatrix: true });
      if (a.rows.length === 1) return `[${a.rows[0]!.map(q).join(",")}]`;
      return `[${a.rows.map((r) => `[${r.map(q).join(",")}]`).join("")}]`;
    }
    case "neg": {
      // −(a·b) = (−a)·b, so only sums and looser need brackets; and a
      // fraction or product that itself starts with a minus: −(−a/5), never −−a/5.
      const t = wrap(a.a, precOf(a.a) < 8 || (a.a.k === "num" && a.a.v.startsWith("-")) || a.a.k === "neg");
      return t.startsWith("-") ? `-(${t})` : `-${t}`;
    }
    case "not":
      return `not ${wrap(a.a, precOf(a.a) < 5)}`;
    case "post":
      return `${wrap(a.a, precOf(a.a) < 11)}${a.op}`;
    case "define":
      return `Define ${p(a.lhs)}=${p(a.rhs)}`;
    case "bin": {
      const prec = PREC[a.op] ?? 0;
      const lp = precOf(a.a);
      const rp = precOf(a.b);
      if (a.op === "^") {
        // Base: anything but an atom gets brackets (−2)^2, (x+1)^2.
        // Exponent: brackets unless a lone atom, so x^(−1), x^(n+1).
        // A function's value is bracketed too, as the handheld writes (sin(x))^2 and (cos(3))^4.
        const l = wrap(a.a, lp <= 10 || (a.a.k === "call" && a.a.f !== "index"));
        const r = wrap(a.b, rp < 12);
        return `${l}^${r}`;
      }
      // Left-associative: the right side needs brackets at equal precedence
      // for − and / (a−(b−c), a/(b*c)); relations never chain.
      const rightTight = a.op === "-" || a.op === "/" || prec === 6;
      const l = wrap(a.a, lp < prec);
      // A right side that starts with a minus is bracketed: 8−(−2·π²), never 8--2·π².
      const startsMinus = (x: Ast): boolean => x.k === "neg" || (x.k === "num" && x.v.startsWith("-")) || (x.k === "bin" && x.op !== "^" && startsMinus(x.a));
      // The handheld's linear text also brackets a denominator that is π or a function's
      // value: 2/(π), ln(5)/(ln(3)), -x/(√(1-x^2)); but 1/x and 9/π^2 stay bare.
      const lone = a.op === "/" && ((a.b.k === "sym" && a.b.name === "π") || (a.b.k === "call" && a.b.f !== "index"));
      const r = wrap(a.b, lone || rp < prec || (rightTight && rp === prec) || (["+", "-", "*", "/"].includes(a.op) && startsMinus(a.b)));
      if (a.op === "*") {
        if (opts.implicit && a.implicit) return `${l}${r}`;
        return `${l}*${r}`;
      }
      if (SPACED.has(a.op)) return `${l} ${a.op} ${r}`;
      // A polar complex number is bracketed, (2∠150), as the handheld shows it (and
      // must be typed in Degree mode); a vector's entries aren't: [3.16228∠1.24905].
      if (bracketed(a)) return `(${l}∠${r})`;
      return `${l}${a.op}${r}`;
    }
  }
}
