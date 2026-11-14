// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 VCE Hub. Part of the /cas calculator: https://github.com/vcehub/cas
import { mapAst, parse, sym, type Ast } from "../math/ast";
import { canonical } from "./canonical";
import { RENAME_OUT, userName, type Hint } from "./translate";

/**
 * Giac output → the AST of what the handheld would show.
 *
 * Giac's text is close to the calculator's syntax but not the same: lists are
 * "list[…]", constants are pi/e/inf, roots are sqrt(…), arbitrary integers
 * are n_0, n_1 … and decimals print to 12 digits. This file rewrites all of
 * that, then dresses answers by command: solve gives "x=… or x=…", deSolve
 * gives "y=…" with c1, c2, fMin gives "x=…".
 */
export type FormatOptions = {
  hint: Hint;
  vars?: string[];
  digits: number;
  listify?: boolean;
  decimal?: boolean | boolean[];
  /** Real mode: an answer with i is an error unless complex was expected. */
  realOnly?: boolean;
  /** The angle unit, for ▶Polar's form. */
  angle?: "rad" | "deg";
  /**
   * The problem's running counts of arbitrary constants: deSolve's c1, c2 …
   * and solve's n1 … keep counting up across entries, as on the handheld.
   * Read and advanced here.
   */
  counters?: { c: number; n: number };
  /** solve, zeros, polyRoots: real answers only, whatever the Complex Format (cSolve is for the others). */
  realSolutions?: boolean;
  /** tCollect: terms over one denominator in one fraction, (cos(2x)+1)/2. */
  combine?: boolean;
};

export class EngineError extends Error {}

export function format(raw: string, opts: FormatOptions): Ast {
  const text = raw.trim();
  if (opts.hint === "define" || opts.hint === "delvar") return sym("Done");
  // GIAC_ERROR: too, which a failed subst gives.
  if (/^"?(Error|.*error:)/i.test(text) || text === "") throw new EngineError(errorMessage(text));
  let ast: Ast;
  try {
    ast = parse(preclean(text), { giac: true });
  } catch {
    throw new EngineError("Error: Unable to display the result");
  }
  // A relation's sides are kept: 2=−2 is an answer (false), not 2 with its decimal.
  if (opts.hint !== "bool") ast = stripApprox(ast);
  ast = rename(ast, opts.counters);
  ast = piecewiseBack(ast);
  if (opts.hint === "polar") return polar(ast, opts);
  // Giac's logic answers 0 and 1; the handheld says false and true.
  if (opts.hint === "bool" && ast.k === "num" && (ast.v === "0" || ast.v === "1")) return sym(ast.v === "1" ? "true" : "false");
  if (opts.listify) ast = listify(ast);
  if (opts.realSolutions) ast = realOnlyAnswers(ast);
  ast = dress(ast, opts);
  ast = canonical(ast, { ascending: opts.hint === "series" });
  // A system's values over one denominator, minus outside: x=−(c1−7)/2.
  if (opts.hint === "solve" && (opts.vars?.length ?? 0) > 1) ast = mapAst(ast, (x) => (x.k === "bin" && x.op === "=" ? { ...x, b: overOne(x.b) } : x));
  if (opts.combine) ast = overOne(ast, false);
  ast = complexParts(ast);
  if (opts.realOnly && containsI(ast)) throw new EngineError("Error: The result isn't a real number");
  const dec = opts.decimal;
  // With a decimal in the input, constant parts are worked out at full precision before
  // rounding: n>−ln(20.)/ln(5./6.) is n>16.4306.
  if (dec === true) ast = foldDecimals(ast, 15);
  if (Array.isArray(dec) && ast.k === "list" && ast.items.length === dec.length) {
    ast = { ...ast, items: ast.items.map((x, i) => floats(x, opts.digits, dec[i]!)) };
  } else ast = floats(ast, opts.digits, dec === true);
  // And after: an exact answer (ln(20)/ln(5/6)) only becomes decimals here.
  if (dec === true) ast = foldDecimals(ast, opts.digits);
  return ast;
}

/**
 * Giac's piecewise(condition, value, …, otherwise) in the handheld's order,
 * value then condition, with no otherwise when it's undef (the handheld's
 * own default). One value with undef otherwise is the restriction x²|x≥0.
 */
function piecewiseBack(a: Ast): Ast {
  const REL: Record<string, string> = { "<": ">", ">": "<", "≤": "≥", "≥": "≤" };
  // 0>x reads x<0.
  const cond = (c: Ast): Ast =>
    c.k === "bin" && (c.op === "and" || c.op === "or")
      ? { ...c, a: cond(c.a), b: cond(c.b) }
      : c.k === "bin" && REL[c.op] && isConstant(c.a) && !isConstant(c.b)
        ? { ...c, op: REL[c.op] as typeof c.op, a: c.b, b: c.a }
        : c;
  /**
   * The chain translate's orderedPiecewise makes (x<0, 0, x≤4, f, 0) shown as
   * the intervals it came from (f, 0≤x≤4, 0). Only a chain of upper bounds
   * x<c / x≤c on one variable, rising, with a gap piece (undef, or the
   * otherwise value) or at least two steps: anything else is left alone.
   */
  const fromChain = (x: Extract<Ast, { k: "call" }>): Ast | null => {
    const args = x.args.slice();
    if (args.length % 2 === 0) return null;
    const otherwise = args.pop()!;
    const isUndef = (y: Ast) => y.k === "sym" && y.name === "undef";
    const same = (p: Ast, q: Ast) => JSON.stringify(p) === JSON.stringify(q);
    const steps: { c: Ast; op: string; n: number; value: Ast; v: string }[] = [];
    for (let i = 0; i < args.length; i += 2) {
      const c = cond(args[i]!);
      if (!(c.k === "bin" && (c.op === "<" || c.op === "≤") && c.a.k === "sym" && isConstant(c.b))) return null;
      steps.push({ c: c.b, op: c.op, n: numericValue(c.b), value: args[i + 1]!, v: c.a.name });
    }
    if (!steps.length || steps.some((p) => p.v !== steps[0]!.v || !Number.isFinite(p.n))) return null;
    if (steps.some((p, i) => i > 0 && !(p.n > steps[i - 1]!.n || (p.n === steps[i - 1]!.n && p.op === "≤" && steps[i - 1]!.op === "<")))) return null;
    const gap = (y: Ast) => isUndef(y) || same(y, otherwise);
    // One step with no gap (x<1 → a, otherwise b) reads fine as it is.
    if (!steps.some((p) => gap(p.value)) && steps.length < 2) return null;
    // Gaps of both kinds can't be written back as intervals and one otherwise.
    if (!isUndef(otherwise) && steps.some((p) => isUndef(p.value)) && steps.some((p) => same(p.value, otherwise))) return null;
    const X = sym(steps[0]!.v);
    const out: Ast[] = [];
    let below: { at: Ast; op: "<" | "≤" } | null = null;
    let undefGap = false;
    for (const p of steps) {
      if (gap(p.value)) undefGap ||= isUndef(p.value) && !isUndef(otherwise);
      else {
        const upper: Ast = { k: "bin", op: p.op as "<", a: X, b: p.c };
        out.push(p.value, below ? { k: "bin", op: p.op as "<", a: { k: "bin", op: below.op, a: below.at, b: X }, b: p.c } : upper);
      }
      below = { at: p.c, op: p.op === "<" ? "≤" : "<" };
    }
    if (!isUndef(otherwise)) {
      out.push(otherwise);
      // An undef gap below means the otherwise value only holds above the last end.
      if (undefGap) out.push({ k: "bin", op: below!.op === "≤" ? "≥" : ">", a: X, b: below!.at });
    }
    return { ...x, args: out };
  };
  return mapAst(a, (x) => {
    if (x.k !== "call" || x.f !== "piecewise" || x.args.length < 2) return x;
    const chain = fromChain(x);
    if (chain) return chain;
    const args = x.args.slice();
    const last = args.length % 2 ? args.pop() : undefined;
    const otherwise = last && !(last.k === "sym" && last.name === "undef") ? last : undefined;
    if (args.length === 2 && !otherwise) return { k: "bin", op: "|", a: args[1]!, b: cond(args[0]!) };
    const out: Ast[] = [];
    for (let i = 0; i < args.length; i += 2) out.push(args[i + 1]!, cond(args[i]!));
    if (otherwise) out.push(otherwise);
    return { ...x, args: out };
  });
}

/**
 * A complex constant printed as real part + imaginary part·i, the imaginary
 * part's coefficient written in full before the i: (1+3·i)/2 is 1/2+3/2·i,
 * π·i/2 is π/2·i, (−1+2·i)/5 is −1/5+2/5·i, as the handheld writes them
 * in Rectangular mode. Powers keep their form: in
 * ℯ^(2·i·π/3) the handheld puts i before π.
 */
function complexParts(a: Ast): Ast {
  if ((a.k === "bin" && a.op === "^") || (a.k === "call" && a.f === "exp")) return a;
  if (isConstant(a) && containsI(a)) {
    // A constant sum term by term (1/2+i/2), or one fraction over a real denominator.
    const terms = a.k === "bin" && (a.op === "+" || a.op === "-") ? sumTerms(a, false) : [{ neg: false, t: a }];
    const split = terms.map((x) => {
      const parts = overReal(x.t);
      return parts ? parts.map((y) => ({ ...y, neg: y.neg !== x.neg })) : [x];
    });
    if (split.some((x, k) => x.length !== 1 || x[0] !== terms[k])) return joinTerms(split.flat());
  }
  const m = complexParts;
  switch (a.k) {
    case "call":
      return { ...a, args: a.args.map(m) };
    case "bin":
      // A term of a sum with variables in it is left to that sum: (ℯ^w+i)/2 stays.
      if (a.op === "+" || a.op === "-") return a;
      // i/6·π, as Giac writes ln(i)/3, is π/6·i.
      if (a.op === "*" && isConstant(a)) return iLast({ ...a, a: m(a.a), b: m(a.b) });
      return { ...a, a: m(a.a), b: m(a.b) };
    case "neg":
      return { ...a, a: m(a.a) };
    case "list":
      return { ...a, items: a.items.map(m) };
    case "mat":
      return { ...a, rows: a.rows.map((r) => r.map(m)) };
    default:
      return a;
  }
}

type Term = { neg: boolean; t: Ast };

const I: Ast = { k: "sym", name: "i" };
const isI = (a: Ast) => a.k === "sym" && a.name === "i";
/** X·i with no i in X (or i itself): a term in the handheld's a+b·i form. */
const timesI = (a: Ast) => isI(a) || (a.k === "bin" && a.op === "*" && isI(a.b) && !containsI(a.a));

/** n/d with i in n and not in d, term by term: X·i/d is (X/d)·i. Null when it isn't one. */
function overReal(a: Ast): Term[] | null {
  if (a.k === "neg") {
    const inner = overReal(a.a);
    return inner && inner.map((t) => ({ ...t, neg: !t.neg }));
  }
  if (!(a.k === "bin" && a.op === "/") || containsI(a.b) || !containsI(a.a)) return null;
  const d = a.b;
  const part = ({ neg, t }: Term): Term => {
    if (t.k === "neg") return part({ neg: !neg, t: t.a });
    const u = iLast(t);
    if (!timesI(u)) return { neg, t: over(t, d) };
    const c = over(isI(u) ? { k: "num", v: "1" } : (u as Extract<Ast, { k: "bin" }>).a, d);
    return { neg, t: c.k === "num" && c.v === "1" ? I : { k: "bin", op: "*", a: c, b: I } };
  };
  const terms = sumTerms(a.a, false).map(part);
  // Only when every i ends up as a coefficient times i.
  return terms.every(({ t }) => !containsI(t) || timesI(t)) ? terms : null;
}

/**
 * n/d with a whole-number factor common to both taken out: Giac leaves the
 * entries of [2−i]/2 as (2−i)/2, whose real part is 1, not 2/2.
 */
function over(n: Ast, d: Ast): Ast {
  const whole = (x: Ast) => (x.k === "num" && /^\d+$/.test(x.v) && Number.isSafeInteger(Number(x.v)) ? Number(x.v) : NaN);
  const [k, rest] = n.k === "bin" && n.op === "*" ? [whole(n.a), n.b] : [whole(n), null];
  const q = whole(d);
  if (!Number.isFinite(k) || !Number.isFinite(q) || k === 0 || q === 0) return { k: "bin", op: "/", a: n, b: d };
  let g = k;
  for (let r = q; r; ) [g, r] = [r, g % r];
  const top: Ast = k / g === 1 && rest ? rest : rest ? { k: "bin", op: "*", a: { k: "num", v: `${k / g}` }, b: rest } : { k: "num", v: `${k / g}` };
  return q / g === 1 ? top : { k: "bin", op: "/", a: top, b: { k: "num", v: `${q / g}` } };
}

/** A constant product with i among its factors as coefficient·i: i/6·π is π/6·i, i·√3 is √3·i. */
function iLast(a: Ast): Ast {
  const factors: Ast[] = [];
  const flat = (x: Ast): void => void (x.k === "bin" && x.op === "*" ? (flat(x.a), flat(x.b)) : factors.push(x));
  flat(a);
  const k = factors.findIndex(isI);
  if (k < 0 || k === factors.length - 1 || factors.some((f, j) => j !== k && containsI(f))) return a;
  const [first, ...others] = factors.filter((_, j) => j !== k);
  const product = (xs: Ast[]) => xs.reduce((p, q) => ({ k: "bin", op: "*", a: p, b: q }));
  // A leading 1/6 goes under the rest: π/6, not 1/6·π.
  const coef =
    others.length && first!.k === "bin" && first!.op === "/" && first!.a.k === "num"
      ? over(first!.a.v === "1" ? product(others) : { k: "bin", op: "*", a: first!.a, b: product(others) }, first!.b)
      : product([first!, ...others]);
  return { k: "bin", op: "*", a: coef, b: I };
}

function sumTerms(a: Ast, neg: boolean): Term[] {
  if (a.k === "bin" && a.op === "+") return [...sumTerms(a.a, neg), ...sumTerms(a.b, neg)];
  if (a.k === "bin" && a.op === "-") return [...sumTerms(a.a, neg), ...sumTerms(a.b, !neg)];
  // −(1+i)/2, as canonical writes (−1−i)/2, splits like (1+i)/2.
  if (a.k === "neg") return sumTerms(a.a, !neg);
  return [{ neg, t: a }];
}

function joinTerms(terms: Term[]): Ast {
  const [first, ...rest] = terms;
  return rest.reduce<Ast>((acc, { neg, t }) => ({ k: "bin", op: neg ? "-" : "+", a: acc, b: t }), first!.neg ? { k: "neg", a: first!.t } : first!.t);
}

function containsI(a: Ast): boolean {
  let found = false;
  mapAst(a, (x) => {
    if (x.k === "sym" && x.name === "i") found = true;
    return x;
  });
  return found;
}

/** Giac's text → something our parser reads. */
function preclean(s: string): string {
  let out = s
    .replace(/\bmatrix\[/g, "[")
    // 1.5e-07 → 1.5E-7 (our numbers use E).
    .replace(/(\d)e\+?(-?)0*(\d)/g, "$1E$2$3")
    .replace(/\bseq\[/g, "list[")
    .replace(/\bset\[/g, "list[")
    // Giac's unsigned infinity (1/0, tan(π/2), a limit that differs by side)
    // is the handheld's undef; only +infinity and −infinity are ∞ and −∞.
    .replace(/(^|[^+\-\w])infinity\b/g, "$1undef")
    .replace(/\+infinity\b/g, "infinity");
  // list[ … ] → { … }, matching brackets.
  for (;;) {
    const i = out.indexOf("list[");
    if (i < 0) break;
    let depth = 0;
    let j = i + 4;
    for (; j < out.length; j++) {
      if (out[j] === "[") depth++;
      else if (out[j] === "]" && --depth === 0) break;
    }
    out = `${out.slice(0, i)}{${out.slice(i + 5, j)}}${out.slice(j + 1)}`;
  }
  return out;
}

const CONSTANTS = new Set(["π", "ℯ", "i", "∞"]);

/** True if the expression has no variables (only numbers and constants). */
export function isConstant(a: Ast): boolean {
  switch (a.k) {
    case "num":
      return true;
    case "sym":
      return CONSTANTS.has(a.name) || ["pi", "e", "inf"].includes(a.name);
    case "call":
      return a.args.every(isConstant);
    case "bin":
      return a.op !== "=" && isConstant(a.a) && isConstant(a.b);
    case "neg":
      return isConstant(a.a);
    default:
      return false;
  }
}

/**
 * Giac prints "1/3=0.333333333333" for some exact constants: keep the exact
 * part. Its approximation can overflow (exp(1000)=infinity); ℯ^1000 is still
 * the answer, as on the handheld.
 */
function stripApprox(a: Ast): Ast {
  const overflow = (x: Ast): boolean => (x.k === "sym" && (x.name === "undef" || x.name === "∞")) || (x.k === "neg" && overflow(x.a));
  if (a.k === "bin" && a.op === "=" && (isDecimal(a.b) || isNumber(a.b) || isComplexDecimal(a.b) || overflow(a.b)) && isConstant(a.a)) return a.a;
  return a;
}

/** A complex approximation Giac appends, such as 2.0+3.46410161514*i. */
function isComplexDecimal(a: Ast): boolean {
  let ok = true;
  mapAst(a, (x) => {
    if (!(x.k === "num" || x.k === "neg" || (x.k === "sym" && x.name === "i") || (x.k === "bin" && ["+", "-", "*"].includes(x.op)))) ok = false;
    return x;
  });
  return ok;
}

const isNumber = (a: Ast): boolean => a.k === "num" || (a.k === "neg" && isNumber(a.a));

/** [a,b] → {a,b} when the input had no matrix. */
function listify(input: Ast): Ast {
  return mapAst(input, (a) => (a.k === "mat" && a.rows.length === 1 ? { k: "list", items: a.rows[0]! } : a));
}

const isDecimal = (a: Ast): boolean =>
  (a.k === "num" && /[.E]/.test(a.v)) || (a.k === "neg" && isDecimal(a.a));

const FN_OUT: Record<string, string> = {
  asin: "sin⁻¹",
  acos: "cos⁻¹",
  atan: "tan⁻¹",
  asinh: "sinh⁻¹",
  acosh: "cosh⁻¹",
  atanh: "tanh⁻¹",
  re: "real",
  im: "imag",
  arg: "angle",
  diff: "d",
  integrate: "∫",
};

function rename(input: Ast, counters?: { c: number; n: number }): Ast {
  const nMap = new Map<string, string>();
  const cMap = new Map<string, string>();
  const base = { c: counters?.c ?? 0, n: counters?.n ?? 0 };
  const out = renameWith(input, nMap, cMap, base);
  if (counters) {
    counters.c += cMap.size;
    counters.n += nMap.size;
  }
  return out;
}

function renameWith(input: Ast, nMap: Map<string, string>, cMap: Map<string, string>, base: { c: number; n: number }): Ast {
  return mapAst(input, (a) => {
    if (a.k === "sym") {
      if (a.name === "pi") return sym("π");
      if (a.name === "e") return sym("ℯ");
      if (a.name === "inf" || a.name === "infinity") return sym("∞");
      const n = /^n_(\d+)$/.exec(a.name);
      if (n) {
        if (!nMap.has(a.name)) nMap.set(a.name, `n${base.n + nMap.size + 1}`);
        return sym(nMap.get(a.name)!);
      }
      const c = /^c_(\d+)$/.exec(a.name);
      if (c) {
        if (!cMap.has(a.name)) cMap.set(a.name, `c${base.c + cMap.size + 1}`);
        return sym(cMap.get(a.name)!);
      }
      if (userName(a.name) !== a.name) return sym(userName(a.name));
      // A stored function's parameter is held as x_p_ (defineParts); shown as x.
      const held = /^(\w+?)_p_$/.exec(a.name);
      if (held) return sym(RENAME_OUT[held[1]!] ?? held[1]!);
      return a;
    }
    if (a.k === "call") {
      if (a.f === "sqrt") return { k: "call", f: "√", args: a.args };
      if (a.f === "exp" && a.args.length === 1) return { k: "bin", op: "^", a: sym("ℯ"), b: a.args[0]! };
      if (a.f === "log10" && a.args.length === 1) return { k: "call", f: "log", args: [a.args[0]!, { k: "num", v: "10" }] };
      if (a.f === "logb") return { k: "call", f: "log", args: a.args };
      // Giac's real root, surd(x,3), is written x^(1/3), as the handheld writes every root;
      // an odd root of a power, surd(x²,3), is x^(2/3) (both the real branch).
      if (a.f === "surd" && a.args.length === 2) {
        const [r, n] = [a.args[0]!, integer(a.args[1]!)];
        const m = r.k === "bin" && r.op === "^" ? integer(r.b) : null;
        if (n && m !== null && n % 2) return power(r.k === "bin" ? r.a : r, m * Math.sign(n), Math.abs(n));
        if (n) return power(r, Math.sign(n), Math.abs(n));
      }
      const f = FN_OUT[a.f] ?? (userName(a.f) !== a.f ? userName(a.f) : undefined);
      if (f) return { ...a, f };
    }
    // (x^(1/3))² is x^(2/3), as the handheld writes it: 4·2^(4/7), not 4·(2^(1/7))⁴.
    // A whole power of any power multiplies out on either branch: (x^(2/3))³ is x².
    if (a.k === "bin" && a.op === "^" && a.a.k === "bin" && a.a.op === "^") {
      const m = integer(a.b);
      const r = ratio(a.a.b);
      if (m !== null && r !== null && r.q > 0) return power(a.a.a, m * r.p, r.q);
    }
    if (a.k === "bin" && (a.op === "*" || a.op === "/")) return samePowers(a);
    return a;
  });
}

/** p/q for an integer or integer-fraction exponent. */
function ratio(a: Ast): { p: number; q: number } | null {
  const n = integer(a);
  if (n !== null) return { p: n, q: 1 };
  if (a.k === "neg") {
    const r = ratio(a.a);
    return r && { p: -r.p, q: r.q };
  }
  if (a.k !== "bin" || a.op !== "/") return null;
  const [p, q] = [integer(a.a), integer(a.b)];
  return p !== null && q ? { p, q } : null;
}

/**
 * Powers of one variable in a product added up, as the handheld writes
 * them: x·x^(2/3) is x^(5/3) and 2·x^(2/3)/(3x) is 2/(3·x^(1/3)) (its
 * d(x^(4/3),x) is 4·x^(1/3)/3, its dominantTerm 1/x^(5/3)). Only where a
 * root is odd: x^a·x^b = x^(a+b) then holds on either branch, the real
 * one and Giac's principal one. Numbers keep their form (3·2^(1/3)/2).
 */
function samePowers(a: Ast): Ast {
  const parts: { f: Ast; den: boolean }[] = [];
  const flat = (x: Ast, den: boolean) => {
    if (x.k === "bin" && (x.op === "*" || x.op === "/")) {
      flat(x.a, den);
      flat(x.b, x.op === "/" ? !den : den);
    } else parts.push({ f: x, den });
  };
  flat(a, false);
  const split = (x: Ast) => {
    const r = x.k === "bin" && x.op === "^" ? ratio(x.b) : null;
    return r ? { base: x.k === "bin" ? x.a : x, ...r } : { base: x, p: 1, q: 1 };
  };
  const groups = new Map<string, number[]>();
  parts.forEach((x, i) => {
    const { base } = split(x.f);
    if (base.k === "num" || base.k === "neg" || !hasVars(base)) return;
    const key = JSON.stringify(base);
    groups.set(key, [...(groups.get(key) ?? []), i]);
  });
  let merged = false;
  const out: ({ f: Ast; den: boolean } | null)[] = [...parts];
  for (const idx of groups.values()) {
    if (idx.length < 2) continue;
    const terms = idx.map((i) => ({ ...split(parts[i]!.f), den: parts[i]!.den }));
    if (!terms.some((t) => t.q > 1) || terms.some((t) => t.q % 2 === 0)) continue;
    // Sum of ±p/q.
    let [P, Q] = [0, 1];
    for (const t of terms) [P, Q] = [P * t.q + (t.den ? -t.p : t.p) * Q, Q * t.q];
    merged = true;
    idx.forEach((i) => (out[i] = null));
    if (P !== 0) out[idx[0]!] = { f: power(terms[0]!.base, Math.abs(P), Q), den: P < 0 };
  }
  if (!merged) return a;
  const product = (xs: Ast[]): Ast => xs.reduce((l, r) => ({ k: "bin", op: "*", a: l, b: r }));
  const kept = out.filter((x): x is { f: Ast; den: boolean } => x !== null);
  const top = kept.filter((x) => !x.den).map((x) => x.f);
  const bottom = kept.filter((x) => x.den).map((x) => x.f);
  const n = top.length ? product(top) : { k: "num" as const, v: "1" };
  return bottom.length ? { k: "bin", op: "/", a: n, b: product(bottom) } : n;
}

function hasVars(a: Ast): boolean {
  let found = false;
  mapAst(a, (x) => {
    if (x.k === "sym" && x.name !== "π" && x.name !== "ℯ" && x.name !== "i" && x.name !== "") found = true;
    return x;
  });
  return found;
}

const integer = (a: Ast): number | null =>
  a.k === "num" && /^\d+$/.test(a.v) ? Number(a.v) : a.k === "neg" && a.a.k === "num" && /^\d+$/.test(a.a.v) ? -Number(a.a.v) : null;

/** base^(p/q) in lowest terms; a negative power as 1/base^(|p|/q). */
function power(base: Ast, p: number, q: number): Ast {
  const gcd = (m: number, n: number): number => (n ? gcd(n, m % n) : Math.abs(m));
  const d = gcd(p, q) || 1;
  const [n, m] = [Math.abs(p) / d, q / d];
  const exp: Ast = m === 1 ? { k: "num", v: String(n) } : { k: "bin", op: "/", a: { k: "num", v: String(n) }, b: { k: "num", v: String(m) } };
  const pos: Ast = m === 1 && n === 1 ? base : { k: "bin", op: "^", a: base, b: exp };
  return p < 0 ? { k: "bin", op: "/", a: { k: "num", v: "1" }, b: pos } : pos;
}

/** Command-specific dressing of the answer. */
function dress(a: Ast, opts: FormatOptions): Ast {
  const { hint, vars } = opts;
  const v = vars?.[0] ?? "x";
  if (hint === "solve") return solveForm(a, vars ?? ["x"], opts.counters);
  if (hint === "zeros") {
    // Real zeros in ascending order, as the handheld lists them.
    const l = asList(a);
    if (l.k === "list" && l.items.every((x) => Number.isFinite(numericValue(x)))) {
      return { ...l, items: [...l.items].sort((p, q) => numericValue(p) - numericValue(q)) };
    }
    return l;
  }
  if (hint === "desolve") {
    const sols = a.k === "list" ? a.items : [a];
    const target = vars?.[0] ?? "y";
    const eqs = sols.map((s): Ast => (s.k === "bin" && s.op === "=" ? s : { k: "bin", op: "=", a: sym(target), b: s }));
    return orJoin(eqs);
  }
  if (hint === "nsolve") {
    // Only real roots count: x·ln(x)=−1 has none, which is "No solution found", not a non-real error.
    const vals = (a.k === "list" ? a.items : a.k === "mat" ? (a.rows[0] ?? []) : [a]).filter(
      (x) => !containsI(x) && Number.isFinite(numericValue(x)),
    );
    if (!vals.length) return { k: "str", v: "No solution found" };
    // The handheld reports one root: the one nearest its starting guess, 0.
    // Ties (±1.69) go to the smaller, so the answer doesn't depend on Giac's order.
    return vals.reduce((best, x) => {
      const [v, b] = [numericValue(x), numericValue(best)];
      return Math.abs(v) < Math.abs(b) - 1e-12 || (Math.abs(Math.abs(v) - Math.abs(b)) <= 1e-12 && v < b) ? x : best;
    });
  }
  if (hint === "completesq") return constantsRight(a);
  if (hint === "factors") return fromFactors(a);
  if (hint === "fminmax") {
    const vals = a.k === "list" ? a.items : [a];
    if (vals.length && vals.every((x) => !(x.k === "bin" && x.op === "="))) {
      return orJoin(vals.map((x): Ast => ({ k: "bin", op: "=", a: sym(v), b: x })));
    }
  }
  return a;
}

/** [f1,m1,f2,m2 …] → f1^m1·f2^m2…, negative multiplicities in the denominator. */
function fromFactors(a: Ast): Ast {
  const items = a.k === "list" ? a.items : a.k === "mat" && a.rows.length === 1 ? a.rows[0]! : null;
  if (!items || items.length % 2) return a;
  const top: Ast[] = [];
  const bottom: Ast[] = [];
  let negative = false;
  for (let k = 0; k < items.length; k += 2) {
    const [f, m] = [items[k]!, items[k + 1]!];
    const n = numericValue(m);
    if (!Number.isInteger(n)) return a;
    if ((f.k === "neg" && f.a.k === "num" && f.a.v === "1") || (f.k === "num" && f.v === "-1")) {
      if (n % 2) negative = !negative;
      continue;
    }
    const power = (p: number): Ast => (p === 1 ? f : { k: "bin", op: "^", a: f, b: { k: "num", v: String(p) } });
    if (n > 0) top.push(power(n));
    else if (n < 0) bottom.push(power(-n));
  }
  const product = (fs: Ast[]): Ast =>
    fs.length ? fs.slice(1).reduce<Ast>((acc, f) => ({ k: "bin", op: "*", a: acc, b: f }), fs[0]!) : { k: "num", v: "1" };
  const value: Ast = bottom.length ? { k: "bin", op: "/", a: product(top), b: product(bottom) } : product(top);
  return negative ? { k: "neg", a: value } : value;
}

/** (x+1)^2−4 → (x+1)^2=4: completeSquare of an equation keeps it an equation. */
function constantsRight(a: Ast): Ast {
  const terms: { neg: boolean; t: Ast }[] = [];
  const walk = (x: Ast, neg: boolean) => {
    if (x.k === "bin" && (x.op === "+" || x.op === "-")) {
      walk(x.a, neg);
      walk(x.b, x.op === "-" ? !neg : neg);
    } else if (x.k === "neg") walk(x.a, !neg);
    else terms.push({ neg, t: x });
  };
  walk(a, false);
  const consts = terms.filter((x) => isConstant(x.t));
  const rest = terms.filter((x) => !isConstant(x.t));
  if (!rest.length) return { k: "bin", op: "=", a, b: { k: "num", v: "0" } };
  const join = (list: { neg: boolean; t: Ast }[]): Ast =>
    list.slice(1).reduce<Ast>(
      (acc, x) => ({ k: "bin", op: x.neg ? "-" : "+", a: acc, b: x.t }),
      list[0]!.neg ? { k: "neg", a: list[0]!.t } : list[0]!.t,
    );
  const rhs = consts.length ? join(consts.map((x) => ({ neg: !x.neg, t: x.t }))) : { k: "num" as const, v: "0" };
  return { k: "bin", op: "=", a: join(rest), b: rhs };
}

function asList(a: Ast): Ast {
  if (a.k === "mat" && a.rows.length === 1) return { k: "list", items: a.rows[0]! };
  return a;
}

function orJoin(items: Ast[]): Ast {
  if (!items.length) return sym("false");
  return items.reduce((acc, x) => ({ k: "bin", op: "or", a: acc, b: x }));
}

function andJoin(items: Ast[]): Ast {
  return items.reduce((acc, x) => ({ k: "bin", op: "and", a: acc, b: x }));
}

/** solve's answer as the handheld writes it. */
function solveForm(a: Ast, vars: string[], counters?: { c: number; n: number }): Ast {
  // A system's only solution comes back as one row ([[a,k]], a list once listified): one solution, not several.
  const oneRow = vars.length > 1 && a.k === "list" && a.items.length === vars.length && a.items.every((x) => x.k !== "list" && x.k !== "mat" && !(x.k === "bin" && x.op === "="));
  const items = oneRow ? [a] : a.k === "list" ? a.items : a.k === "mat" ? a.rows.map((r): Ast => ({ k: "list", items: r })) : [a];
  if (!items.length) return sym("false");
  const one = vars[0]!;
  const sols: Ast[] = [];
  const systems: Ast[][] = [];
  for (const it of items) {
    // A system: one list of values per solution, in variable order.
    if (it.k === "list" && vars.length > 1) {
      systems.push(it.items);
      continue;
    }
    if (it.k === "mat" && it.rows.length === 1 && vars.length > 1) {
      sols.push(andJoin(it.rows[0]!.map((val, k): Ast => eqOrRel(vars[k] ?? `x${k}`, val))));
      continue;
    }
    // x itself as a solution means every x works.
    if (it.k === "sym" && it.name === one) return sym("true");
    sols.push(eqOrRel(one, it));
  }
  // A system's solutions in ascending order of the first variable, then the next, when all are
  // numbers or the variable left free (x=-2 and y=c1 before x=2 and y=c1).
  const isFree = (val: Ast, k: number) => val.k === "sym" && val.name === vars[k];
  const values = systems.map((row) => row.map((val, k) => (isFree(val, k) ? 0 : numericValue(val))));
  if (values.every((row) => row.every(Number.isFinite))) {
    const order = systems.map((_, k) => k).sort((p, q) => {
      for (let j = 0; j < values[p]!.length; j++) if (values[p]![j] !== values[q]![j]) return values[p]![j]! - values[q]![j]!;
      return 0;
    });
    systems.splice(0, systems.length, ...order.map((k) => systems[k]!));
  }
  // A variable left free (z=z) becomes an arbitrary constant: z=c1, x=−(c1−7)/2. One
  // constant per free variable, shared by every solution: x=-2 and y=c1 or x=2 and y=c1.
  const constants = new Map<string, Ast>();
  for (let row of systems) {
    for (const [k, val] of row.entries()) {
      const v = vars[k];
      if (v && isFree(val, k)) {
        if (!constants.has(v)) constants.set(v, sym(`c${counters ? ++counters.c : 1}`));
        const c = constants.get(v)!;
        row = row.map((x) => mapAst(x, (y) => (y.k === "sym" && y.name === v ? c : y)));
      }
    }
    sols.push(andJoin(row.map((val, k): Ast => eqOrRel(vars[k] ?? `x${k}`, val))));
  }
  return orJoin(sortNumeric(sols, one));
}

/** "x=v", unless Giac already gave a relation such as x>2. */
function eqOrRel(v: string, val: Ast): Ast {
  if (val.k === "bin" && val.op === "and") return chain(val, v) ?? val;
  if (val.k === "bin" && ["=", "<", ">", "≤", "≥", "≠", "and", "or"].includes(val.op)) return val;
  return { k: "bin", op: "=", a: sym(v), b: val };
}

/** Numeric solutions in ascending order, as the handheld lists them. */
function sortNumeric(sols: Ast[], v: string): Ast[] {
  const keyed = sols.map((s) => {
    const val = s.k === "bin" && s.op === "=" && s.a.k === "sym" && s.a.name === v ? numericValue(s.b) : NaN;
    return { s, val };
  });
  if (keyed.some((k) => Number.isNaN(k.val))) return sols;
  return keyed.sort((p, q) => p.val - q.val).map((k) => k.s);
}

/** Approximate value of a constant expression, or NaN. */
export function numericValue(a: Ast): number {
  switch (a.k) {
    case "num":
      return Number(a.v);
    case "sym":
      return a.name === "π" ? Math.PI : a.name === "ℯ" ? Math.E : NaN;
    case "neg":
      return -numericValue(a.a);
    case "bin": {
      const x = numericValue(a.a);
      const y = numericValue(a.b);
      if (a.op === "+") return x + y;
      if (a.op === "-") return x - y;
      if (a.op === "*") return x * y;
      if (a.op === "/") return x / y;
      if (a.op === "^") return x ** y;
      return NaN;
    }
    case "call": {
      const x = numericValue(a.args[0] ?? { k: "num", v: "NaN" });
      const fns: Record<string, (n: number) => number> = { "√": Math.sqrt, ln: Math.log, sin: Math.sin, cos: Math.cos, tan: Math.tan };
      const fn = fns[a.f];
      if (a.f === "root" && a.args[1]) return Math.cbrt(x) ** (3 / numericValue(a.args[1]));
      return fn ? fn(x) : NaN;
    }
    default:
      return NaN;
  }
}

/**
 * Decimals to the display setting (Float 6 by default), handheld style.
 * With a decimal in the input, whole numbers in the answer are decimals too
 * ("1."), except exponents.
 */
function floats(a: Ast, digits: number, decimal: boolean, inExponent = false): Ast {
  const f = (x: Ast, exp = false) => floats(x, digits, decimal, exp);
  switch (a.k) {
    case "num":
      if (!/[.E]/.test(a.v) && !(decimal && !inExponent)) return a;
      return shownDecimal(a.v, digits);
    case "bin":
      return { ...a, a: f(a.a), b: f(a.b, a.op === "^") };
    case "neg": {
      const inner = f(a.a, inExponent);
      return inner.k === "num" && inner.v === "0." ? inner : { ...a, a: inner };
    }
    case "not":
    case "post":
      return { ...a, a: f(a.a, inExponent) };
    case "call":
      return { ...a, args: a.args.map((x) => f(x)) };
    case "list":
      return { ...a, items: a.items.map((x) => f(x)) };
    case "mat":
      return { ...a, rows: a.rows.map((r) => r.map((x) => f(x))) };
    default:
      return a;
  }
}

/**
 * A decimal as Display Digits shows it. When that drops digits, the number
 * keeps them (`full`), so ans carries on with the value as it was worked out,
 * as the handheld's does whatever the display setting (the setting
 * limits only the places displayed). Without it, 1000 then
 * ×1.05 Enter five times showed 1276.29, from 1215.51 rounded, for 1276.28.
 * Giac's own decimals come with 12 digits; a value worked out here keeps 15.
 */
export function shownDecimal(x: number | string, digits: number): Ast {
  const value = Number(x);
  const shown = formatFloat(value, digits);
  let worked = typeof x === "number" ? formatFloat(x, 15) : x;
  // A whole number stays a decimal (12345678901234.), so ans stays approximate.
  if (!/[.E]/.test(worked)) worked += ".";
  const magnitude = (t: string) => t.replace(/^-/, "");
  const keep = Number.isFinite(value) && shown !== "0." && Number(worked) !== Number(shown);
  const num: Ast = keep ? { k: "num", v: magnitude(shown), full: magnitude(worked) } : { k: "num", v: magnitude(shown) };
  return shown.startsWith("-") ? { k: "neg", a: num } : num;
}

/** The answer with each decimal at the precision it was worked out to (see shownDecimal). */
export const unrounded = (a: Ast): Ast => mapAst(a, (x) => (x.k === "num" && x.full ? { k: "num", v: x.full } : x));

/**
 * Float n: n significant digits, trailing zeros dropped, a whole number
 * keeps its point ("5."), and scientific form (1.23457E6) beyond what fits.
 */
export function formatFloat(x: number, digits = 6): string {
  if (!Number.isFinite(x)) return Number.isNaN(x) ? "undef" : x > 0 ? "∞" : "-∞";
  // Rounding noise from a numeric routine (−1.9E−19 for 0) shows as 0.
  if (x === 0 || Math.abs(x) < 1e-14) return "0.";
  const ax = Math.abs(x);
  if (ax >= 10 ** digits || ax < 1e-3) {
    const [m, e] = x.toExponential(digits - 1).split("e");
    let mant = m!.replace(/0+$/, "").replace(/\.$/, "");
    if (!mant.includes(".")) mant += ".";
    return `${mant}E${Number(e)}`;
  }
  const p = Number(x.toPrecision(digits));
  let s = String(p);
  if (s.includes("e")) s = p.toFixed(10);
  if (!s.includes(".")) s += ".";
  else s = s.replace(/0+$/, "");
  return s;
}

function errorMessage(text: string): string {
  // A user's function past its depth limit (evaluate.ts, recursiveDefinition).
  if (/Too many nested calls/.test(text)) return "Error: Too many nested calls";
  // m[4,1] past the end: Giac's message ends "syntax compatibility mode xcas", which isn't a syntax error.
  if (/Index outside range/i.test(text)) return "Error: Dimension error";
  if (/syntax/i.test(text)) return "Error: Syntax";
  if (/undef|No such variable/i.test(text)) return "Error: Undefined variable";
  if (/Not invertible/i.test(text)) return "Error: Singular matrix";
  // Errors translate.ts raises inside Giac, and Giac's own.
  if (/Sizes do not match|Dimension mismatch/i.test(text)) return "Error: Sizes do not match";
  if (/Dimension error|Invalid dimension/i.test(text)) return "Error: Dimension error";
  if (/Domain error/i.test(text)) return "Error: Domain error";
  if (/Wrong kind of input|Invalid data type/i.test(text)) return "Error: Wrong kind of input";
  if (/Needs vectors of 2 or 3/i.test(text)) return "Error: Needs vectors of 2 or 3 entries";
  if (/argument|Bad Argument/i.test(text)) return "Error: Argument error";
  return "Error: Invalid input";
}

/**
 * ▶Polar: [r, θ] from Giac as the handheld writes it. Radians: ℯ^(i·θ)·r,
 * the exponential first; degrees: (r∠θ). r and θ are each put in normal
 * form, but the product isn't reordered.
 */
function polar(ast: Ast, opts: FormatOptions): Ast {
  const items = ast.k === "list" ? ast.items : ast.k === "mat" && ast.rows.length === 1 ? ast.rows[0]! : [];
  if (items.length !== 2) throw new EngineError("Error: Unable to display the result");
  const tidy = (x: Ast) => floats(canonical(x), opts.digits, opts.decimal === true);
  const [r, theta] = [tidy(items[0]!), tidy(items[1]!)];
  if (opts.angle === "deg") return { k: "bin", op: "∠", a: r, b: theta };
  if (theta.k === "num" && Number(theta.v) === 0) return r;
  // i goes after a leading number and before π: 2·i·π/3, i·π/3.
  const timesI = (t: Ast): Ast => {
    if (t.k === "neg") return { k: "neg", a: timesI(t.a) };
    if (t.k === "bin" && t.op === "/") return { ...t, a: timesI(t.a) };
    if (t.k === "bin" && t.op === "*" && t.a.k === "num") return { ...t, a: { k: "bin", op: "*", a: t.a, b: sym("i") } };
    return { k: "bin", op: "*", a: sym("i"), b: t };
  };
  const iTheta = timesI(theta);
  const e: Ast = { k: "bin", op: "^", a: sym("ℯ"), b: iTheta };
  return r.k === "num" && Number(r.v) === 1 ? e : { k: "bin", op: "*", a: e, b: r };
}

/** x≥−2 and x≤3 → −2≤x≤3, as the handheld writes an interval. */
function chain(a: Extract<Ast, { k: "bin" }>, v: string): Ast | null {
  const isV = (x: Ast) => x.k === "sym" && x.name === v;
  // Each side as "bound op x" with op < or ≤, and whether it's the lower bound.
  const side = (r: Ast): { lower: boolean; op: "<" | "≤"; bound: Ast } | null => {
    if (r.k !== "bin") return null;
    const strict = r.op === "<" || r.op === ">";
    const op = strict ? "<" : "≤";
    if (isV(r.a) && (r.op === ">" || r.op === "≥")) return { lower: true, op, bound: r.b };
    if (isV(r.a) && (r.op === "<" || r.op === "≤")) return { lower: false, op, bound: r.b };
    if (isV(r.b) && (r.op === "<" || r.op === "≤")) return { lower: true, op, bound: r.a };
    if (isV(r.b) && (r.op === ">" || r.op === "≥")) return { lower: false, op, bound: r.a };
    return null;
  };
  const [p, q] = [side(a.a), side(a.b)];
  if (!p || !q || p.lower === q.lower) return null;
  const [lo, hi] = p.lower ? [p, q] : [q, p];
  return { k: "bin", op: hi.op, a: { k: "bin", op: lo.op, a: lo.bound, b: sym(v) }, b: hi.bound };
}

/**
 * A system's value in the handheld's form: terms over one denominator in one
 * fraction, and a leading minus taken out: 7/2−c1/2 is −(c1−7)/2, 1−c2 is −(c2−1).
 */
function overOne(a: Ast, minusOutside = true): Ast {
  if (!(a.k === "bin" && (a.op === "+" || a.op === "-"))) return a;
  const terms: { neg: boolean; t: Ast }[] = [];
  const walk = (x: Ast, neg: boolean) => {
    if (x.k === "bin" && (x.op === "+" || x.op === "-")) {
      walk(x.a, neg);
      walk(x.b, x.op === "-" ? !neg : neg);
    } else if (x.k === "neg") walk(x.a, !neg);
    else terms.push({ neg, t: x });
  };
  walk(a, false);
  if (!terms.some((t) => !isConstant(t.t))) return a;
  const den = (t: Ast) => (t.k === "bin" && t.op === "/" && t.b.k === "num" ? t.b.v : "1");
  const d = den(terms[0]!.t);
  if (!terms.every((t) => den(t.t) === d)) return a;
  if (!minusOutside) {
    if (d === "1") return a;
    const top = terms.map((t) => ({ neg: t.neg, t: (t.t as Extract<Ast, { k: "bin" }>).a }));
    const sum = top.slice(1).reduce<Ast>((acc, t) => ({ k: "bin", op: t.neg ? "-" : "+", a: acc, b: t.t }), top[0]!.neg ? { k: "neg", a: top[0]!.t } : top[0]!.t);
    return { k: "bin", op: "/", a: sum, b: { k: "num", v: d } };
  }
  // The variable terms first, negated as a whole when they lead with a minus.
  const top = terms.map((t) => ({ neg: t.neg, t: d === "1" ? t.t : (t.t as Extract<Ast, { k: "bin" }>).a }));
  top.sort((p, q) => Number(isConstant(p.t)) - Number(isConstant(q.t)));
  const negate = top[0]!.neg;
  const sum = top.slice(1).reduce<Ast>(
    (acc, t) => ({ k: "bin", op: t.neg !== negate ? "-" : "+", a: acc, b: t.t }),
    top[0]!.t,
  );
  const whole: Ast = d === "1" ? sum : { k: "bin", op: "/", a: sum, b: { k: "num", v: d } };
  return negate ? { k: "neg", a: whole } : whole;
}

/** Drop the answers with i in them: from a list, or from Giac's list of solutions. */
function realOnlyAnswers(a: Ast): Ast {
  if (a.k === "list") return { ...a, items: a.items.filter((x) => !containsI(x)) };
  if (a.k === "mat") return { ...a, rows: a.rows.filter((r) => !r.some(containsI)) };
  return containsI(a) ? { k: "list", items: [] } : a;
}

/** Constant sub-expressions holding a decimal, as one decimal (not inside exponents of variables). */
function foldDecimals(a: Ast, digits: number): Ast {
  const constant = (x: Ast): boolean => {
    let ok = true;
    mapAst(x, (y) => {
      if (y.k === "sym" && !["π", "ℯ"].includes(y.name)) ok = false;
      if (y.k === "list" || y.k === "mat" || y.k === "str") ok = false;
      return y;
    });
    return ok;
  };
  const hasDec = (x: Ast): boolean => {
    let d = false;
    mapAst(x, (y) => {
      if (y.k === "num" && /[.E]/.test(y.v)) d = true;
      return y;
    });
    return d;
  };
  const fold = (x: Ast): Ast => {
    if ((x.k === "bin" || x.k === "call" || x.k === "neg") && !(x.k === "bin" && ["=", "<", ">", "≤", "≥", "≠", "and", "or"].includes(x.op)) && constant(x) && hasDec(x)) {
      const v = numericValue(unrounded(x));
      if (Number.isFinite(v)) return shownDecimal(v, digits);
    }
    switch (x.k) {
      case "bin":
        return { ...x, a: fold(x.a), b: fold(x.b) };
      case "neg":
        return { ...x, a: fold(x.a) };
      case "call":
        return { ...x, args: x.args.map(fold) };
      case "list":
        return { ...x, items: x.items.map(fold) };
      case "mat":
        return { ...x, rows: x.rows.map((r) => r.map(fold)) };
      default:
        return x;
    }
  };
  return fold(a);
}
