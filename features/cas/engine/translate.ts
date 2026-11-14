// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 VCE Hub. Part of the /cas calculator: https://github.com/vcehub/cas
import { GIAC_RESERVED } from "./giac-reserved";
import { bin, mapAst, num, sym, type Ast } from "../math/ast";
import { EngineError } from "./format";

/**
 * Calculator input (AST) → a Giac command string.
 *
 * Most commands map one to one with a rename or an argument reorder; a few
 * (tangentLine, normalLine, mod, remain) are built from Giac primitives. The
 * `hint` tells format.ts how to dress Giac's answer back up: solve answers
 * become "x=… or x=…", deSolve answers get "y=" and c1, and so on.
 */
export type Hint =
  | "plain"
  | "solve"
  | "zeros"
  | "desolve"
  | "fminmax"
  | "define"
  | "store"
  | "bool"
  | "delvar"
  | "nsolve"
  | "completesq"
  /** Giac's factors() list [f1,m1,f2,m2 …], multiplied back out as factor() over the rationals. */
  | "factors"
  /** taylor: the handheld lists the series lowest power first. */
  | "series"
  /** ▶Polar: Giac gives [modulus, argument]; the answer is ℯ^(iθ)·r, or (r∠θ) in degrees. */
  | "polar";

export type Translation = {
  giac: string;
  hint: Hint;
  vars?: string[];
  /** No matrix in the input: Giac's [a,b] answers are lists, {a,b}. */
  listify: boolean;
  /** 9→m[1,1]: the element to read back once stored, which is the answer. */
  readBack?: string;
  /**
   * Which parts of the input were decimals, so Auto mode answers those
   * parts in decimals: one flag for a scalar, one per element for a list
   * argument (ceiling({−3.1,1,2.5}) → {−3.,1,3.}).
   */
  decimal: boolean | boolean[];
  /** A second command to try if the first comes back undef. */
  fallback?: string;
  /** Complex answers are expected (cSolve, cFactor …): no "Non-real" error. */
  complex?: boolean;
  /**
   * Commands to run afterwards. Giac's "|" with an inequality leaves an
   * assumption on the variable; these purge it so it can't leak into the
   * next entry.
   */
  cleanup?: string[];
  /**
   * cSolve or cZeros in one variable: answers are shown as a+b·i, complex
   * roots first, so evaluate() asks Giac for each root's parts.
   */
  rect?: boolean;
  /** A command that picks the answer's form (propFrac, expand …): leave its constants alone. */
  keepForm?: boolean;
  /** A substitution: Giac doesn't simplify after it (√3³), so evaluate() tries normal() too. */
  substituted?: boolean;
  /** The command without its simplifying wrapper, to check the wrapper kept the value. */
  unwrapped?: string;
  /** If Giac's answer matches `when`, ask again with `giac` and dress that as `hint`. */
  alt?: { when: RegExp; giac: string; hint: Hint };
};

export class UnsupportedError extends Error {}

/**
 * What translation needs besides the input: the angle unit, and which
 * variables hold lists (Giac's + and * treat lists as vectors and
 * polynomials; the handheld works element by element).
 */
export type Ctx = {
  angle: "rad" | "deg";
  lists?: Set<string>;
  matrices?: Set<string>;
  /**
   * Variables holding a one-row matrix ([1,2,3]→p). Giac keeps it as a flat
   * vector, the same as a list, so the kind is recorded when it's stored.
   */
  rows?: Set<string>;
  /** Functions defined with a vector or matrix (r(t):=[100−10t,10t,0]): what they answer is one, not a list. */
  vectorFns?: Set<string>;
  /** Variables holding a complex number: with one in the input, a complex answer is no error in Real mode. */
  complexVars?: Set<string>;
  mode?: "auto" | "exact" | "approx";
  /** The Complex Format: Real mode takes the real branch of x^(p/q) with q odd (realPower). */
  complex?: "real" | "rect" | "polar";
  /** x^(2/3) as surd(x,3)², for a derivative, an antiderivative or a series (realPower). */
  rootPowers?: boolean;
};

const DEG = 'pi/180';

/**
 * Names Giac reserves that a student may use as variables or functions:
 * e, D, E, I, gamma and beta, and every command or keyword of Giac's that
 * isn't one of the handheld's (area, length, line, si, fi …: giac-reserved.ts).
 * No prototype, so a name like constructor isn't found on it.
 */
export const RENAME_IN: Record<string, string> = Object.assign(Object.create(null) as Record<string, string>, {
  ...Object.fromEntries(GIAC_RESERVED.map((n) => [n, `${n}_`])),
  e: "e_",
  D: "D_",
  E: "E_",
  I: "I_",
  gamma: "gamma_",
  beta: "beta_",
  // θ is a variable like any other, theta to Giac; a variable typed as the letters theta is theta_.
  θ: "theta",
  theta: "theta_",
});
export const RENAME_OUT: Record<string, string> = Object.assign(
  Object.create(null) as Record<string, string>,
  Object.fromEntries(Object.entries(RENAME_IN).map(([k, v]) => [v, k])),
);

/**
 * A member of a variable group (stat.q₁x, aa.b) under a name Giac can hold:
 * the dot and every other character outside a–z and 0–9 is written as its
 * code between underscores, so stat.q₁x is stat_46_q_8321_x.
 */
const groupToGiac = (name: string) => Array.from(name, (c) => (/[a-z0-9]/.test(c) ? c : `_${c.codePointAt(0)}_`)).join("");
function groupFromGiac(name: string): string | null {
  if (!name.includes("_46_") || !/^(?:[a-z0-9]|_\d+_)+$/.test(name)) return null;
  const out = name.replace(/_(\d+)_/g, (_, d: string) => String.fromCodePoint(Number(d)));
  return out.includes(".") && groupToGiac(out) === name ? out : null;
}
/** The name Giac knows a user's variable or function by. */
export const giacName = (name: string): string => RENAME_IN[name] ?? (name.includes(".") ? groupToGiac(name) : name);
/** A Giac name back to the user's: Giac's reserved words and group members renamed on the way in. */
export const userName = (name: string): string => RENAME_OUT[name] ?? groupFromGiac(name) ?? name;

// ans with no answer yet to stand for: Giac's Ans (its own ans is a function).
// ? is the element under test in a countIf or sumIf criterion (the bound q_ there).
const SYMS: Record<string, string> = { "π": "pi", "ℯ": "e", "∞": "inf", i: "i", ans: "Ans", "?": "q_" };

/** Straight renames: our name → Giac name, same arguments. */
const RENAME_FN: Record<string, string> = {
  "√": "sqrt",
  zeros: "zeros",
  cZeros: "cZeros",
  cSolve: "csolve",
  propFrac: "propfrac",
  comDenom: "comDenom",
  getNum: "numer",
  getDenom: "denom",
  tCollect: "tcollect",
  approx: "evalf",
  exact: "exact",
  real: "re",
  imag: "im",
  conj: "conj",
  angle: "arg",
  ln: "ln",
  exp: "exp",
  "sin⁻¹": "asin",
  "cos⁻¹": "acos",
  "tan⁻¹": "atan",
  "csc⁻¹": "acsc",
  "sec⁻¹": "asec",
  "cot⁻¹": "acot",
  arcsin: "asin",
  arccos: "acos",
  arctan: "atan",
  "sinh⁻¹": "asinh",
  "cosh⁻¹": "acosh",
  "tanh⁻¹": "atanh",
  ceiling: "ceil",
  int: "floor",
  iPart: "trunc",
  fPart: "frac",
  isPrime: "isprime",
  det: "det",
  rref: "rref",
  ref: "ref",
  identity: "idn",
  dotP: "dot",
  crossP: "cross",
  mean: "mean",
  stDevPop: "stddev",
  stDevSamp: "stddevp",
  varPop: "variance",
  arcLen: "arcLen",
  fMin: "fMin",
  fMax: "fMax",
  polyDegree: "degree",
  polyQuotient: "quo",
  polyRemainder: "rem",
  polyGcd: "gcd",
  mid: "mid",
  left: "left",
  right: "right",
  augment: "augment",
  trace: "trace",
  dim: "dim",
  sign: "sign",
  max: "max",
  min: "min",
  floor: "floor",
  lcm: "lcm",
  abs: "abs",
  sum: "sum",
  product: "product",
  seq: "seq",
  domain: "domain",
  "list▶mat": "list2mat",
  "mat▶list": "mat2list",
  eigVc: "eigenvects",
  randInt: "randint",
  rand: "rand",
  canonical_form: "canonical_form",
};

/** Build a Giac call string. */
const g = (f: string, ...args: string[]) => `${f}(${args.join(",")})`;

/** AST → Giac. Throws UnsupportedError for commands with no mapping. */
export function translate(input: Ast, settings: Ctx): Translation {
  // ? stands for an element only in a countIf or sumIf criterion; anywhere else it's a syntax error.
  const outside = mapAst(input, (a) => (a.k === "call" && (a.f === "countIf" || a.f === "sumIf") && a.args[1] ? { ...a, args: a.args.filter((_, k) => k !== 1) } : a));
  if (mentionsElement(outside)) throw new EngineError("Error: Syntax");
  // Variables renamed before anything else so commands see the safe names.
  const ast = mapAst(input, (a) => (a.k === "sym" && giacName(a.name) !== a.name ? sym(giacName(a.name)) : a));

  let listify = true;
  // What a name held before a store doesn't decide what's stored: {1,2}→m is a list.
  const target = input.k === "bin" && input.op === "→" ? input.b : input.k === "bin" && input.op === ":=" ? input.a : input.k === "define" ? input.lhs : null;
  // A function's own name doesn't either: r(t):=t² over a vector function is a scalar one.
  const stored = target?.k === "sym" || (target?.k === "call" && target.f !== "index");
  const value = stored ? (input.k === "define" ? input.rhs : input.k === "bin" && input.op === "→" ? input.a : (input as { b: Ast }).b) : input;
  // eigVl answers a list even for a matrix input, and so do dim ({3,3}), mat▶list and seq;
  // a list written out ({m[1,1],m[2,2]}) is a list whatever its entries come from. Stored
  // too: dim(m)→d is the list {2,2}, not a vector.
  const listAnswer = value.k === "list" || (value.k === "call" && ["eigVl", "dim", "mat▶list", "seq"].includes(value.f));
  let hasI = false;
  mapAst(value, (x) => {
    const held = (n: string) => settings.matrices?.has(RENAME_IN[n] ?? n) || settings.rows?.has(RENAME_IN[n] ?? n);
    if (x.k === "mat" && !listAnswer) listify = false;
    if (x.k === "sym" && !listAnswer && held(x.name)) listify = false;
    if (x.k === "call" && !listAnswer && settings.vectorFns?.has(RENAME_IN[x.f] ?? x.f)) listify = false;
    if (x.k === "sym" && (x.name === "i" || settings.complexVars?.has(RENAME_IN[x.name] ?? x.name))) hasI = true;
    return x;
  });
  const top = input.k === "bin" && input.op === "|" ? input.a : input;
  const exactCall = top.k === "call" && (top.f === "exact" || top.f === "▶approxFraction");
  const firstArg = top.k === "call" ? top.args[0] : undefined;
  // invBinom answers a whole number of successes, decimals in or not.
  // List arithmetic keeps Giac's own decimals, element by element: {1.,2,3}·{4,5,6} is {4.,10,18}.
  const decimal: boolean | boolean[] = exactCall || (top.k === "call" && top.f === "invBinom") || (top.k === "bin" && listy(top, settings))
    ? false
    : firstArg?.k === "list"
      ? firstArg.items.map(hasDecimal)
      : firstArg?.k === "mat"
        ? false
        : hasDecimal(input);
  const complex = hasI || (top.k === "call" && /^c[A-Z]|^cPolyRoots$|^conj$|^real$|^imag$|^angle$/.test(top.f));
  const keepForm = (top.k === "call" && FORM_COMMANDS.has(top.f)) || (top.k === "post" && /^▶/.test(top.op));
  // Purges for the assumptions "|x>0" leaves behind, on every path below:
  // fMax(…)|0≤x≤2 once left x assumed in [0,2] for the rest of the session.
  const purges = constrainedVars(input).map((v) => g("purge", RENAME_IN[v] ?? v));
  const flags = { listify, decimal, complex, keepForm, ...(purges.length ? { cleanup: purges } : {}) };

  if (ast.k === "define") {
    return { giac: defineGiac(ast.lhs, ast.rhs, settings), hint: "define", ...flags };
  }
  if (ast.k === "bin" && ast.op === "→") {
    // 9→m[1,1] stores into one element and answers the value stored (9, not Done).
    if (ast.b.k === "call" && ast.b.f === "index") {
      // A one-row matrix is a flat vector in Giac: 9→p[1,2] stores into p[2].
      const [x, i, j] = ast.b.args;
      const flat = ast.b.args.length === 3 && x?.k === "sym" && rowMatrix(x, settings) && i?.k === "num" && i.v === "1";
      const into = flat ? { ...ast.b, args: [x, j!] } : ast.b;
      return { giac: defineGiac(into, ast.a, settings), hint: "store", readBack: toGiac(ast.b, settings), ...flags };
    }
    // expr→f(x) defines a function, answered Done.
    if (ast.b.k === "call") return { giac: defineGiac(ast.b, ast.a, settings), hint: "define", ...flags };
    return { giac: `${toGiac(ast.b, settings)}:=${toGiac(ast.a, settings)}`, hint: "store", ...flags };
  }
  if (ast.k === "bin" && ast.op === ":=") {
    if (ast.a.k === "call") return { giac: defineGiac(ast.a, ast.b, settings), hint: "define", ...flags };
    return { giac: `${toGiac(ast.a, settings)}:=${toGiac(ast.b, settings)}`, hint: "store", ...flags };
  }
  if (ast.k === "call" && ast.f === "DelVar") {
    return { giac: g("purge", ...ast.args.map((a) => toGiac(a, settings))), hint: "delvar", ...flags };
  }
  if (ast.k === "call" && ast.f === "ClearAZ") {
    return { giac: g("purge", ..."abcdefghijklmnopqrstuvwxyz".split("").map((c) => RENAME_IN[c] ?? c)), hint: "delvar", ...flags };
  }

  // The "|" operator applies to the whole command; look through it for the hint.
  const core = ast.k === "bin" && ast.op === "|" ? ast.a : ast;
  let hint: Hint = "plain";
  let vars: string[] | undefined;
  if (core.k === "post" && core.op === "▶Polar") {
    if (core.a.k === "list" || core.a.k === "mat") throw new UnsupportedError("▶Polar");
    const z = toGiac(core.a, settings);
    // In degrees Giac's arg is a decimal, but its atan stays exact (atan(1) = 45):
    // build the argument from atan by quadrant.
    const [x, y] = [`re(${z})`, `im(${z})`];
    const angle =
      settings.angle === "rad"
        ? `normal(arg(${z}))`
        : `when(${x}>0,atan(${y}/${x}),when(${x}<0,atan(${y}/${x})+when(${y}>=0,180,-180),when(${y}>=0,90,-90)))`;
    // Giac's normal never returned on abs((1/2+√3/2·i)·8^(1/3)) (x^(1/3)|x=−8 in Polar); simplify gives 2.
    const modulus = heavy(z) ? `simplify(abs(${z}))` : `normal(abs(${z}))`;
    return { giac: `[${modulus},${angle}]`, hint: "polar", ...flags, complex: true };
  }
  if (core.k === "call") {
    if (core.f === "solve" || core.f === "cSolve") {
      hint = "solve";
      vars = varNames(core.args[1]);
    } else if (core.f === "deSolve") {
      hint = "desolve";
      vars = varNames(core.args[2]);
    } else if (core.f === "zeros" || core.f === "cZeros") hint = "zeros";
    else if (core.f === "taylor" || core.f === "series") hint = "series";

    else if (core.f === "fMin" || core.f === "fMax") {
      hint = "fminmax";
      vars = varNames(core.args[1]);
      // Giac's fMin/fMax are numeric; for a symbolic function, solve f′=0
      // and keep the points where f″ has the right sign.
      const [fx, xv] = [core.args[0], core.args[1]];
      if (fx && xv && core.args.length === 2) {
        const F = toGiac(fx, settings);
        const X = toGiac(xv, settings);
        const sign = core.f === "fMax" ? "<" : ">";
        const fallback = `select(t_->subst(diff(${F},${X},2),${X}=t_)${sign}0,solve(diff(${F},${X})=0,${X}))`;
        return { giac: toGiac(ast, settings), hint, vars, fallback, ...flags };
      }
    } else if (core.f === "nfMin" || core.f === "nfMax") hint = "nsolve";
    else if (core.f === "nSolve") {
      hint = "nsolve";
      vars = varNames(core.args[1]);
      // nSolve(…)|condition: keep the numeric roots that meet it.
      if (ast.k === "bin" && ast.op === "|") {
        const v = vars?.[0] ?? "x";
        const cond = toGiac(ast.b, settings);
        const roots = `flatten([${toGiac(core, settings)}])`;
        return { giac: `select(t_->evalb(subst(${cond},${v}=t_)),${roots})`, hint, vars, ...flags };
      }
    } else if (core.f === "completeSquare" && core.args[0]?.k === "bin" && core.args[0].op === "=") {
      const eq = core.args[0];
      const v = core.args[1] ? toGiac(core.args[1], settings) : "x";
      const giac = `canonical_form((${toGiac(eq.a, settings)})-(${toGiac(eq.b, settings)}),${v})`;
      return { giac, hint: "completesq", vars, ...flags };
    }
  }
  // factor(expr) without a variable stays over the rationals: factor(x²−3) is
  // x²−3, though Giac's factor() brings in √3. cFactor(expr) without one
  // works over the rationals and i: x²+4/9 splits, x²+3 doesn't.
  // factor(2^6−1): no variable in it, so the integer path in callToGiac (ifactor) takes it.
  if (core === ast && core.k === "call" && core.args.length === 1 && core.args[0]?.k !== "num" && !(core.f === "factor" && !containsSym(core.args[0]!))) {
    const E = toGiac(core.args[0]!, settings);
    if (core.f === "factor") return { giac: g("factors", E), hint: "factors", ...flags };
    if (core.f === "cFactor")
      return { giac: g("factor", E, "i"), hint, alt: { when: /sqrt/, giac: g("factors", E), hint: "factors" }, ...flags, complex: true };
  }
  if (isRelation(core) || (core.k === "bin" && core.op === "=")) hint = "bool";
  if (core.k === "bin" && ["and", "or", "xor"].includes(core.op)) hint = "bool";
  if (core.k === "not") hint = "bool";
  if (ast.k === "bin" && ast.op === "|" && hint === "plain" && conjuncts(ast.b).every((c) => c.k === "bin" && c.op === "="))
    Object.assign(flags, { substituted: true });
  // solve(…)|x≠1: Giac takes no ≠ assumption, so those answers are filtered afterwards.
  if (ast.k === "bin" && ast.op === "|" && hint === "solve" && vars?.length === 1) {
    const conds = conjuncts(ast.b);
    const neq = conds.filter((c) => c.k === "bin" && c.op === "≠");
    const others = conds.filter((c) => !(c.k === "bin" && c.op === "≠"));
    if (neq.length) {
      // Built on t_ itself: Giac decides x≠1 as true before any substitution.
      const onT = (c: Ast) => mapAst(c, (x) => (x.k === "sym" && x.name === vars[0] ? sym("t_") : x));
      const test = neq.map((c) => `(${toGiac(onT(c), settings)})`).join(" and ");
      const inner = others.length ? toGiac({ k: "bin", op: "|", a: core, b: andAll(others) }, settings) : toGiac(core, settings);
      return { giac: `select(t_->${test},${inner})`, hint, vars, ...flags };
    }
  }
  if (
    core.k === "call" &&
    (core.f === "cSolve" || core.f === "cZeros") &&
    core.args[1]?.k !== "list" &&
    core.args[0] &&
    conjuncts(core.args[0]).length === 1
  )
    Object.assign(flags, { rect: true });
  // Plain arithmetic with a variable denominator is simplified, as the
  // handheld always does: (x+1)(x−1)/(x−1)+x−3 → 2x−2.
  // Not where Giac's normal can run away (heavy()).
  if (hint === "plain" && core.k === "bin" && hasVarDenominator(core) && !heavy(toGiac(ast, settings))) {
    return { giac: `normal(${toGiac(ast, settings)})`, unwrapped: toGiac(ast, settings), hint, vars, ...flags };
  }
  // Polar numbers multiply out to a+b·i, as the handheld shows: (4∠π/3)·(2∠π/6) = 8·i.
  // Built from re() and im(): Giac's evalc gets the sign wrong at some angles (ℯ^(5πi/12) came out −0.259−0.966i).
  if (hint === "plain" && hasAngle(ast)) {
    const z = toGiac(ast, settings);
    return { giac: `normal(re(${z}))+normal(im(${z}))*i`, hint, vars, ...flags, complex: true };
  }
  // Typed arithmetic gets the handheld's automatic simplification, which
  // Giac leaves out: x²·x³ is x⁵ and 2x+3x is 5x, but (x+1)² stays.
  // Not with a root in it: regroup splits √(2xy) into √2·√(xy).
  if (hint === "plain" && (core.k === "bin" || core.k === "neg") && ast === core && !listy(core, settings) && !hasRoot(core))
    return { giac: `regroup(${toGiac(ast, settings)})`, unwrapped: toGiac(ast, settings), hint, vars, ...flags };
  // A bare equation at the top of a Giac command assigns (x=3 sets x); in a list it doesn't.
  if (ast.k === "bin" && ast.op === "=") return { giac: `[${toGiac(ast, settings)}][0]`, hint, vars, ...flags };
  return { giac: toGiac(ast, settings), hint, vars, ...flags };
}

/** An integer exponent over an integer, in lowest terms: x^(4/6) is p=2, q=3; x^(-1/3) is p=−1, q=3. */
function fractionExponent(b: Ast): { p: number; q: number } | null {
  const int = (x: Ast): number | null =>
    x.k === "num" && /^\d+$/.test(x.v) ? Number(x.v) : x.k === "neg" ? (int(x.a) === null ? null : -int(x.a)!) : null;
  if (b.k === "neg") {
    const f = fractionExponent(b.a);
    return f && { p: -f.p, q: f.q };
  }
  if (b.k !== "bin" || b.op !== "/") return null;
  let [p, q] = [int(b.a), int(b.b)];
  if (p === null || q === null || q <= 0 || !Number.isSafeInteger(p) || !Number.isSafeInteger(q)) return null;
  const gcd = (m: number, n: number): number => (n ? gcd(n, m % n) : Math.abs(m));
  const d = gcd(p, q) || 1;
  [p, q] = [p / d, q / d];
  return { p, q };
}

/** A number, π or ℯ, or a product, quotient, power or root of them: a base whose powers need no branch. */
function positiveConstant(a: Ast): boolean {
  if (a.k === "num") return !a.v.startsWith("-");
  if (a.k === "sym") return a.name === "π" || a.name === "ℯ";
  if (a.k === "bin" && (a.op === "*" || a.op === "/")) return positiveConstant(a.a) && positiveConstant(a.b);
  if (a.k === "bin" && a.op === "^") return positiveConstant(a.a);
  if (a.k === "call" && a.f === "√") return !!a.args[0] && positiveConstant(a.args[0]);
  return false;
}

/**
 * In Real mode a power with an odd denominator is the real root's power:
 * (−8)^(2/3) = (∛−8)² = 4 and x^(2/3) = 4 at x = −8, so
 * solve(x^(2/3)=4,x) is x=−8 or x=8 (in
 * Real mode an odd denominator means the real branch only).
 * Giac's x^(p/q) is the principal branch, (−8)^(2/3) = −2+2√3·i, which is
 * what the handheld gives in Rectangular and Polar, and inside cSolve and
 * cZeros, which work in the complex domain (cSolve(x^(1/3)=−1,x) is false);
 * there the power is left to Giac. A negative number's power is its
 * size's, signed: (−32)^(3/5) = −32^(3/5) = −8. Any other base goes through
 * Giac's real root, surd, split as Giac splits x^(4/3) into x·x^(1/3) so a
 * derivative cancels as before: x^(4/3) is x·surd(x,3), whose derivative
 * normal() makes 4·surd(x,3)/3 (0 at x=0, as on the handheld), while
 * x^(2/3) is surd(x²,3), with derivative 2·surd(x²,3)/(3x), undef at 0.
 * The part under the root is a power inside it, surd(x²,3), because Giac's
 * definite ∫ of surd(x,3)² comes back complex; its antiderivative, though,
 * brings in sign(x), so an indefinite ∫ takes surd(x,3)² (3·x·surd(x,3)²/5),
 * and so does d(), whose normal() expands surd((x+1)²,3) to surd(x²+2x+1,3),
 * and a series, as Giac's series of surd(x²,3) is undef.
 */
function realPower(base: Ast, exponent: Ast, s: Ctx): string | null {
  const f = fractionExponent(exponent);
  if (!f || f.q % 2 === 0 || f.q === 1) return null;
  if (s.complex === "rect" || s.complex === "polar") {
    // Giac leaves (−8)^(1/3) as (1/2+√3/2·i)·8^(1/3) (and ▶Polar of that never returned); simplify gives 1+√3·i.
    return base.k === "neg" && positiveConstant(base.a) ? g("simplify", `(${toGiac(base, s)})^(${f.p}/${f.q})`) : null;
  }
  // A list's power is each element's: Giac's ^ on a list is a dot product ({1,8,27}^2 is 794).
  // regroup evaluates the roots its surd leaves in a list: {−8,8,27}^(2/3) is {4,4,9}.
  if (base.k === "list") return g("regroup", `[${base.items.map((x) => toGiac({ k: "bin", op: "^", a: x, b: exponent }, s)).join(",")}]`);
  if (listy(base, s)) return `map(${toGiac(base, s)},t_->regroup(${realPower(sym("t_"), exponent, s)}))`;
  // x^(1/3) has always been surd(x,3), whatever the base.
  if (f.p === 1) return g("surd", toGiac(base, s), String(f.q));
  if (positiveConstant(base)) return null;
  // A matrix's power is a matrix function, and a complex number's the principal one
  // (i^(2/3) is ℯ^(iπ/3), not ∛(i²) = −1): there's no real branch to take.
  let noBranch = base.k === "mat";
  mapAst(base, (x) => {
    const name = x.k === "sym" ? (RENAME_IN[x.name] ?? x.name) : "";
    if (name === "i" || s.complexVars?.has(name) || s.matrices?.has(name) || (x.k === "bin" && x.op === "∠")) noBranch = true;
    return x;
  });
  if (noBranch) return null;
  if (base.k === "neg" && positiveConstant(base.a)) {
    const size = `(${toGiac(base.a, s)})^(${f.p}/${f.q})`;
    return f.p % 2 ? `(-${size})` : size;
  }
  const B = toGiac(base, s);
  const n = Math.abs(f.p);
  const [whole, part] = [Math.floor(n / f.q), n % f.q];
  const root = g("surd", B, String(f.q));
  const rest = part === 1 ? root : s.rootPowers ? `${root}^${part}` : g("surd", `(${B})^${part}`, String(f.q));
  const factors = [...(whole ? [whole === 1 ? `(${B})` : `(${B})^${whole}`] : []), ...(part ? [rest] : [])];
  const body = factors.join("*");
  return f.p < 0 ? `(1/(${body}))` : `(${body})`;
}

/** A power with a fractional exponent, x^(4/3) (√ isn't one: its derivative is fine as it is). */
function hasFractionalPower(a: Ast): boolean {
  let found = false;
  mapAst(a, (x) => {
    if (x.k === "bin" && x.op === "^" && x.b.k === "bin" && x.b.op === "/") found = true;
    return x;
  });
  return found;
}

function hasRoot(a: Ast): boolean {
  let found = false;
  mapAst(a, (x) => {
    if (x.k === "call" && (x.f === "√" || x.f === "root")) found = true;
    if (x.k === "bin" && x.op === "^" && x.b.k === "bin" && x.b.op === "/") found = true;
    return x;
  });
  return found;
}

function hasAngle(a: Ast): boolean {
  let found = false;
  mapAst(a, (x) => {
    if (x.k === "bin" && x.op === "∠") found = true;
    return x;
  });
  return found;
}

/** Variables in the inequality conditions after "|": they pick up an assumption. */
function constrainedVars(a: Ast): string[] {
  if (!(a.k === "bin" && a.op === "|")) return [];
  const conds = conjuncts(a.b).filter((c) => !(c.k === "bin" && c.op === "="));
  const names = new Set<string>();
  for (const c of conds)
    mapAst(c, (x) => {
      if (x.k === "sym" && !(x.name in SYMS) && x.name !== "") names.add(RENAME_IN[x.name] ?? x.name);
      return x;
    });
  return [...names];
}

function hasDecimal(a: Ast): boolean {
  let found = false;
  mapAst(a, (x) => {
    if (x.k === "num" && /[.E]/.test(x.v)) found = true;
    return x;
  });
  return found;
}

function hasVarDenominator(a: Ast): boolean {
  let found = false;
  mapAst(a, (x) => {
    if (x.k === "bin" && x.op === "/" && containsSym(x.b)) found = true;
    return x;
  });
  return found;
}

function containsSym(a: Ast): boolean {
  let found = false;
  mapAst(a, (x) => {
    if (x.k === "sym" && !(x.name in SYMS)) found = true;
    return x;
  });
  return found;
}

/** The first variable by the handheld's priority (x, y, z, t …, then a …). */
function mainVar(a: Ast): string | undefined {
  const names = new Set<string>();
  mapAst(a, (x) => {
    if (x.k === "sym" && !(x.name in SYMS) && x.name !== "") names.add(x.name);
    return x;
  });
  const order = "xyztuvwabcdefghijklmnopqrs";
  return [...names].sort((p, q) => (order.indexOf(p[0]!) + 1 || 99) - (order.indexOf(q[0]!) + 1 || 99))[0];
}

function isRelation(a: Ast): boolean {
  return a.k === "bin" && ["<", ">", "≤", "≥", "≠"].includes(a.op);
}

function varNames(a: Ast | undefined): string[] | undefined {
  if (!a) return undefined;
  if (a.k === "sym") return [RENAME_OUT[a.name] ?? a.name];
  if (a.k === "list") return a.items.flatMap((x) => varNames(x) ?? []);
  if (a.k === "bin" && a.op === "=" && a.a.k === "sym") return [a.a.name];
  return undefined;
}

function andAll(items: Ast[]): Ast {
  return items.reduce((acc, x) => ({ k: "bin", op: "and", a: acc, b: x }));
}

/** Split "a and b and c" into its parts. */
function conjuncts(a: Ast): Ast[] {
  return a.k === "bin" && a.op === "and" ? [...conjuncts(a.a), ...conjuncts(a.b)] : [a];
}

/**
 * Forms the handheld reads that Giac has no word for, rewritten before translating:
 * - solve(x=2y and x=2,x,y): the variables one by one are the list {x,y}.
 * - Define f(t)=27ℯ^(−kt)|k=ln(3) (or :=, →): k=… is put into the body, and any
 *   other condition (|x≥0) restricts f's domain, f being undef outside it.
 */
export function handheldForms(input: Ast): Ast {
  return mapAst(input, (a) => {
    if (a.k === "call" && (a.f === "solve" || a.f === "cSolve") && a.args.length > 2 && a.args.slice(1).every((x) => x.k === "sym"))
      return { ...a, args: [a.args[0]!, { k: "list", items: a.args.slice(1) }] };
    if (a.k === "define") return { ...a, rhs: restricted(a.lhs, a.rhs) };
    if (a.k === "bin" && a.op === ":=" && a.a.k === "call") return { ...a, b: restricted(a.a, a.b) };
    if (a.k === "bin" && a.op === "→" && a.b.k === "call") return { ...a, a: restricted(a.b, a.a) };
    return a;
  });
}

function restricted(head: Ast, body: Ast): Ast {
  if (!(body.k === "bin" && body.op === "|" && head.k === "call")) return body;
  const params = new Set(head.args.flatMap((p) => (p.k === "sym" ? [p.name] : [])));
  const values: Record<string, Ast> = {};
  const domain: Ast[] = [];
  for (const c of conjuncts(body.b)) {
    if (c.k === "bin" && c.op === "=" && c.a.k === "sym" && !params.has(c.a.name)) values[c.a.name] = c.b;
    else domain.push(c);
  }
  const put = mapAst(body.a, (y) => (y.k === "sym" && y.name in values ? values[y.name]! : y));
  return domain.length ? { k: "call", f: "piecewise", args: [put, andAll(domain), sym("undef")] } : put;
}

const OPS: Record<string, string> = { "≠": "!=", "≤": "<=", "≥": ">=" };

/** Commands whose point is the form of the answer. */
const FORM_COMMANDS = new Set([
  "propFrac", "expand", "factor", "cFactor", "comDenom", "tExpand", "tCollect", "completeSquare", "getNum",
  "getDenom", "exact", "▶approxFraction", "taylor", "series",
]);

const POINTWISE = new Set(["+", "-", "*", "/", "^"]);
/** Commands whose answer is a list. */
const LIST_FNS = new Set([
  "seq", "zeros", "cZeros", "augment", "left", "right", "mid", "cumulativeSum", "mat▶list", "polyRoots",
  "cPolyRoots", "polyCoeffs", "seqGen", "SortA", "SortD", "deltaList", "ΔList", "randInt", "eigVl",
]);
/** Functions applied to a list give a list. */
const ELEMENTWISE = new Set([
  "sin", "cos", "tan", "sin⁻¹", "cos⁻¹", "tan⁻¹", "ln", "log", "√", "abs", "exp", "round", "floor",
  "ceiling", "iPart", "fPart", "int", "sign", "csc", "sec", "cot",
]);

/** A one-row matrix written out ([1,2,3]) or held in a variable. */
function rowMatrix(a: Ast, s: Ctx): boolean {
  return (a.k === "mat" && a.rows.length === 1) || (a.k === "sym" && !!s.rows?.has(RENAME_IN[a.name] ?? a.name));
}

/**
 * A call of a function defined with a vector or matrix (r(1)). Giac holds a
 * vector flat, so it's read as the one-row matrix it is on the handheld; a
 * matrix answer is left as it comes.
 */
function vectorCall(a: Ast | undefined, s: Ctx): boolean {
  return a?.k === "call" && !!s.vectorFns?.has(RENAME_IN[a.f] ?? a.f);
}
const asRow = (v: string) => `(v_->ifte(type(v_[0])==DOM_LIST,v_,[v_]))(${v})`;

/** True if the expression is a list on the handheld. */
function listy(a: Ast, s: Ctx): boolean {
  switch (a.k) {
    case "list":
      return true;
    case "sym":
      return !!s.lists?.has(RENAME_IN[a.name] ?? a.name);
    case "neg":
      return listy(a.a, s);
    case "bin":
      return POINTWISE.has(a.op) && (listy(a.a, s) || listy(a.b, s));
    case "call":
      return LIST_FNS.has(a.f) || (ELEMENTWISE.has(a.f) && !!a.args[0] && listy(a.args[0], s));
    default:
      return false;
  }
}

/** An AST as Giac source. Brackets are generous: Giac doesn't care. */
export function toGiac(a: Ast, s: Ctx): string {
  const t = (x: Ast) => toGiac(x, s);
  const paren = (x: Ast) => (x.k === "num" && !x.v.startsWith("-")) || x.k === "sym" || x.k === "call" || x.k === "list" || x.k === "mat" ? t(x) : `(${t(x)})`;
  switch (a.k) {
    case "num": {
      // An answer brought back (ans) carries on at the precision it was worked out to.
      const v = a.full ?? a.v;
      // Exact mode reads a typed decimal as the fraction it is: 1.25 is 125/100.
      if (s.mode === "exact" && /[.E]/.test(v)) return decimalFraction(v);
      return v.replace("E", "e");
    }
    case "sym":
      if (a.name === "") return "";
      return SYMS[a.name] ?? a.name;
    case "str":
      return JSON.stringify(a.v);
    case "list":
      return `[${a.items.map(t).join(",")}]`;
    case "mat":
      if (a.rows.length === 1) return `[${a.rows[0]!.map(t).join(",")}]`;
      return `[${a.rows.map((r) => `[${r.map(t).join(",")}]`).join(",")}]`;
    case "neg":
      return `-${paren(a.a)}`;
    case "not":
      return `not(${t(a.a)})`;
    case "define":
      return `${t(a.lhs)}:=${t(a.rhs)}`;
    case "post":
      return postToGiac(a.op, a.a, s);
    case "bin": {
      // r∠θ is r·ℯ^(iθ), θ in the current angle unit.
      if (a.op === "∠") return `((${t(a.a)})*exp(i*(${t(a.b)})${s.angle === "deg" ? `*${DEG}` : ""}))`;
      if (a.op === "^" && a.a.k === "sym" && a.a.name === "ℯ") return g("exp", t(a.b));
      if (a.op === "^") {
        const real = realPower(a.a, a.b, s);
        if (real) return real;
      }
      if (a.op === "|") {
        // expr|x=3 substitutes after evaluating (d(x^3,x)|x=3 is 27);
        // Giac's own | is kept for inequality constraints (solve(…)|x>0).
        const conds = conjuncts(a.b);
        // t=2=0 after "|" is ambiguous (the handheld rejects it too): an input error, not a guess.
        const rel = (x: Ast) => x.k === "bin" && ["=", "<", ">", "≤", "≥", "≠"].includes(x.op);
        if (conds.some((c) => c.k === "bin" && c.op === "=" && (rel(c.a) || rel(c.b)))) throw new Error("chained relation");
        if (conds.every((c) => c.k === "bin" && c.op === "=")) {
          return g("subst", t(a.a), `[${conds.map(t).join(",")}]`);
        }
      }
      if (a.op === "→") return `${t(a.b)}:=${t(a.a)}`;
      // 0≤x≤2π is (0≤x) and (x≤2π): Giac would read (0≤x)≤2π as true≤2π whenever it evaluates it.
      const REL = ["<", ">", "≤", "≥"];
      if (REL.includes(a.op) && a.a.k === "bin" && REL.includes(a.a.op)) {
        return `(${t(a.a)}) and (${t({ k: "bin", op: a.op, a: a.a.b, b: a.b })})`;
      }
      // Degree mode is Giac's own setting (angle_radian:=0), so trig needs
      // no wrapping here; only a typed ° in radian mode is converted.
      // Sizes the handheld checks and Giac doesn't (it pads the shorter one, or takes a dot product).
      {
        const list = (x: Ast) => x.k !== "mat" && listy(x, s);
        const matrix = (x: Ast) => x.k === "mat" || (x.k === "sym" && !!s.matrices?.has(RENAME_IN[x.name] ?? x.name));
        // Translated only when a check applies: doing it for every operator doubles the work per level (1+2+…+100 hung).
        const both = () => [paren(a.a), paren(a.b)] as const;
        // {1,2,3}+{1,2}
        if (POINTWISE.has(a.op) && list(a.a) && list(a.b)) {
          const [p, q] = both();
          return `ifte(size(${p})==size(${q}),${p} .${a.op} ${q},"Error: Sizes do not match")`;
        }
        // [[1,2,3][4,5,6]]+[[1,2][3,4]], [1,2,3]+[1,2]
        if ((a.op === "+" || a.op === "-") && matrix(a.a) && matrix(a.b)) {
          const [p, q] = both();
          return `ifte(dim(${p})==dim(${q}),${p}${a.op}${q},"Error: Sizes do not match")`;
        }
        // [1,2,3]*[4,5,6]: no product of two row vectors (Giac's is the dot product).
        if (a.op === "*" && a.a.k === "mat" && a.b.k === "mat" && a.a.rows.length === 1 && a.b.rows.length === 1) return `"Error: Dimension error"`;
        // [1,2,3]+2, [x,y]+a: a scalar goes on the diagonal of a square matrix only (the identity-matrix warning, warnings.ts).
        // A name counts only where it's known which names hold lists and matrices (not every caller says).
        const scalar = (x: Ast): boolean =>
          x.k === "num" ||
          (x.k === "sym" && x.name !== "" && !!s.lists && !!s.matrices && !list(x) && !matrix(x)) ||
          (x.k === "neg" && scalar(x.a)) ||
          (x.k === "bin" && ["+", "-", "*", "/", "^"].includes(x.op) && scalar(x.a) && scalar(x.b)) ||
          (x.k === "call" && ELEMENTWISE.has(x.f) && x.args.length === 1 && scalar(x.args[0]!));
        const nonSquare = (x: Ast) => x.k === "mat" && x.rows.length !== x.rows[0]!.length;
        if ((a.op === "+" || a.op === "-") && ((nonSquare(a.a) && scalar(a.b)) || (nonSquare(a.b) && scalar(a.a)))) return `"Error: Dimension error"`;
        // A 1×1 matrix is square, but Giac reads [5] as a polynomial ([5]+1 was poly1[6]): its one element takes the scalar.
        const single = (x: Ast) => (x.k === "mat" && x.rows.length === 1 && x.rows[0]!.length === 1 ? x.rows[0]![0]! : null);
        const one = single(a.a) ?? single(a.b);
        if ((a.op === "+" || a.op === "-") && one && scalar(single(a.a) ? a.b : a.a))
          return single(a.a) ? `[(${t(one)})${a.op}(${t(a.b)})]` : `[(${t(a.a)})${a.op}(${t(one)})]`;
      }
      // With a list on either side, arithmetic is element by element: 15−{10,15,20}.
      if (POINTWISE.has(a.op) && (listy(a.a, s) || listy(a.b, s)) && a.a.k !== "mat" && a.b.k !== "mat") {
        return `${paren(a.a)} .${a.op} ${paren(a.b)}`;
      }
      const op = OPS[a.op] ?? a.op;
      return `${paren(a.a)}${op === "and" || op === "or" || op === "xor" ? ` ${op} ` : op}${paren(a.b)}`;
    }
    case "call":
      return callToGiac(a.f, a.args, s);
  }
}

function postToGiac(op: string, a: Ast, s: Ctx): string {
  const x = toGiac(a, s);
  switch (op) {
    case "!":
      return `(${x})!`;
    case "%":
      return `(${x})/100`;
    case "°":
      return s.angle === "deg" ? `(${x})` : `(${x})*${DEG}`;
    case "ᵀ":
      return g("transpose", x);
    case "'":
      return `${x}'`;
    case "▶Decimal":
      return g("evalf", x);
    case "▶approxFraction":
      return g("exact", x);
    case "▶Rect":
      // a+b·i with each part simplified: √2+√2·i, not (1+i)·√2.
      return `normal(re(${x}))+normal(im(${x}))*i`;
    // At the top of an entry ▶Polar is handled in translate(); inside one it isn't.
    case "▶Polar":
      throw new UnsupportedError(op);
    case "▶exp":
      return g("lin", g("exp2pow", x));
    case "▶ln":
      return g("lncollect", x);
    case "▶sin":
      return g("trigsin", x);
    case "▶cos":
      return g("trigcos", x);
  }
  throw new UnsupportedError(op);
}

/** Distribution functions: the handheld always answers these in decimals. */
const DISTRIBUTIONS = new Set([
  "normPdf", "normCdf", "invNorm", "binomPdf", "binomCdf", "poissPdf", "poissCdf",
  "geomPdf", "geomCdf", "tPdf", "tCdf", "invt",
]);

function callToGiac(f: string, args: Ast[], s: Ctx): string {
  if (DISTRIBUTIONS.has(f)) return g("evalf", exactCall(f, args, s));
  // A command built from several pieces (mod, median, nPr …) is bracketed,
  // so it stays whole inside a bigger expression: x/nPr(z,c).
  const out = exactCall(f, args, s);
  return singleCall(out) ? out : `(${out})`;
}

/** True if ? (the element under test in countIf and sumIf) is in the expression. */
function mentionsElement(a: Ast): boolean {
  let found = false;
  mapAst(a, (x) => {
    if (x.k === "sym" && x.name === "?") found = true;
    return x;
  });
  return found;
}

/** True for "name(…)" whose first bracket closes at the very end. */
function singleCall(s: string): boolean {
  const m = /^[A-Za-z_][\w.]*\(/.exec(s);
  if (!m) return false;
  let depth = 0;
  for (let i = m[0].length - 1; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")" && --depth === 0) return i === s.length - 1;
  }
  return false;
}

/** Templates whose boxes all need filling: an empty one (∫f d□) is a syntax error, not undef. */
const FILLED = new Set(["∫", "integral", "d", "derivative", "limit", "lim", "Σ", "sumSeq", "Π", "prodSeq"]);

function exactCall(f: string, args: Ast[], ctx: Ctx): string {
  if (FILLED.has(f) && args.some((x) => x.k === "sym" && x.name === "")) throw new EngineError("Error: Syntax");
  // cSolve and cZeros work in the complex domain even in Real mode: x^(1/3) is the principal root there.
  const s: Ctx = f === "cSolve" || f === "cZeros" ? { ...ctx, complex: "rect" } : ctx;
  const t = (x: Ast) => toGiac(x, s);
  const A = args.map(t);
  const [a0, a1, a2, a3] = A;
  switch (f) {
    case "solve":
    case "cSolve": {
      // Giac's solve handles a base-b log only as ln(x)/ln(b).
      args = args.map((x) =>
        mapAst(x, (y) =>
          y.k === "call" && y.f === "log" && y.args.length === 2
            ? { k: "bin", op: "/", a: { k: "call", f: "ln", args: [y.args[0]!] }, b: { k: "call", f: "ln", args: [y.args[1]!] } }
            : y,
        ),
      );
      const gf = f === "solve" ? "solve" : "csolve";
      const eqs = args[0] ? conjuncts(args[0]) : [];
      const target = args[1];
      if (eqs.length > 1 || target?.k === "list") {
        const vars = target?.k === "list" ? target.items.map(t) : target ? [t(target)] : [];
        // A system's answers come back half-worked ((−3/2)²−2): simplified, as the handheld shows them.
        return g("normal", g(gf, `[${eqs.map(t).join(",")}]`, `[${vars.join(",")}]`));
      }
      return g(gf, ...A);
    }
    case "nSolve": {
      const eq = a0 ?? "";
      const v = args[1];
      if (args.length >= 4) return g("fsolve", eq, `${t(v!)}=${a2}..${a3}`);
      return g("fsolve", eq, a1 ?? "x");
    }
    case "completeSquare":
      return g("canonical_form", ...A);
    case "nCr":
    case "nPr": {
      // Element by element on matrices; symbolic n with a whole k is the
      // product n·(n−1)…, and both symbolic is the factorial form.
      const [n, k] = args;
      if (n?.k === "mat" || k?.k === "mat") return elementwise(`(a_,b_)->${f}(a_,b_)`, args, A);
      const whole = k?.k === "num" && /^\d+$/.test(k.v) ? Number(k.v) : k?.k === "neg" && k.a.k === "num" && /^\d+$/.test(k.a.v) ? -Number(k.a.v) : null;
      if (n && containsSym(n) && whole !== null) {
        const falling = whole >= 0 ? (whole ? g("factor", `product((${a0})-k_,k_,0,${whole - 1})`) : "1") : `1/${g("factor", `product((${a0})+k_,k_,1,${-whole})`)}`;
        return f === "nPr" ? falling : `${falling}/${g("factorial", String(Math.abs(whole)))}`;
      }
      if (n && k && containsSym(n) && containsSym(k)) return f === "nPr" ? `(${a0})!/((${a0})-(${a1}))!` : `(${a0})!/((${a1})!*((${a0})-(${a1}))!)`;
      return g(f, ...A);
    }
    case "gcd":
      return args.some((x) => x.k === "mat") ? elementwise("(a_,b_)->gcd(a_,b_)", args, A) : g("gcd", ...A);
    case "tExpand":
      // Like terms combined: tExpand(cos(x−y)−cos(x+y)) is 2·sin(x)·sin(y).
      return g("regroup", g("texpand", ...A));
    case "cFactor":
      // Over i and radicals; other variables' factors are left real: a·(a²+1)·(x−i)·(x+i).
      return g("factor", a0!, "i");
    case "factor":
      // An integer factors into primes; Giac's factor() would leave it.
      if (args.length === 1 && args[0]?.k === "num" && /^\d+$/.test(args[0].v)) return g("ifactor", a0!);
      // So does an integer worked out first: factor(2^6−1) is 3²·7 (it stayed 63).
      if (args.length === 1 && args[0] && !containsSym(args[0])) return `ifte(type(${a0})==DOM_INT,ifactor(${a0}),factor(${a0}))`;
      return g("factor", ...A);
    case "expand": {
      // The handheld's expand also splits a fraction into partial fractions:
      // over the rationals without a variable (a denominator that doesn't
      // factor stays whole, after dividing out the polynomial part), and
      // over radicals in the variable given.
      const e = args[0];
      if (e && hasVarDenominator(e)) {
        if (args[1]) return g("partfrac", a0!, a1!);
        const v = mainVar(e);
        if (!v) return g("expand", a0!);
        return `ifte(size(factors(denom(normal(${a0}))))<=2,propfrac(${a0},${v}),partfrac(${a0},${v}))`;
      }
      return g("expand", a0!);
    }
    case "polyRoots":
    case "cPolyRoots": {
      const v = a1 ?? "x";
      const all = `sort(flatten(map(roots(${a0},${v}),r_->seq(r_[0],k_,1,r_[1]))))`;
      return f === "polyRoots" ? `select(r_->im(r_)==0,${all})` : all;
    }
    case "d":
    case "derivative":
      // With a root or fractional power, Giac's raw derivative of x^(4/3) is x^(1/3)+x/(3·(x^(1/3))²),
      // 0/0 at x=0; normal() gives 4·x^(1/3)/3.
      if (args[0] && hasFractionalPower(args[0]) && !heavy(a0!)) {
        // surd(x+1,3)², not surd((x+1)²,3): normal() expands the radicand of the second.
        return g("normal", g("diff", ...args.map((x) => toGiac(x, { ...s, rootPowers: true }))));
      }
      return g("regroup", g("diff", ...A));
    case "∫":
    case "integral":
      if (args.length >= 4) return g("integrate", ...A);
      return g("regroup", g("integrate", ...args.map((x) => toGiac(x, { ...s, rootPowers: true }))));
    case "limit":
    case "lim":
      return g("limit", ...A);
    case "Σ":
    case "sumSeq":
      // A sum to n is factored, as the handheld shows it: k·(k+1)/2.
      return args.slice(1).some(containsSym) && args[3] && containsSym(args[3]) ? g("factor", g("sum", ...A)) : g("sum", ...A);
    case "Π":
    case "prodSeq":
      return g("product", ...A);
    case "tangentLine": {
      const [fx, x, at] = [a0!, ...lineAt(args, s)];
      return g("expand", `subst(${fx},${x},${at})+subst(diff(${fx},${x}),${x},${at})*(${x}-(${at}))`);
    }
    case "normalLine": {
      const [fx, x, at] = [a0!, ...lineAt(args, s)];
      return g("expand", g("normal", `subst(${fx},${x},${at})-(${x}-(${at}))/subst(diff(${fx},${x}),${x},${at})`));
    }
    case "deSolve": {
      const parts = args[0] ? conjuncts(args[0]) : [];
      const ode = parts.length > 1 ? `[${parts.map(t).join(",")}]` : (a0 ?? "");
      return g("desolve", ode, a1 ?? "x", a2 ?? "y");
    }
    case "impDif": {
      // dy/dx of F(x,y)=0 is −F_x/F_y.
      const eq = args[0];
      const F = eq?.k === "bin" && eq.op === "=" ? `(${t(eq.a)})-(${t(eq.b)})` : (a0 ?? "0");
      const [x, y] = [a1 ?? "x", a2 ?? "y"];
      const first = g("normal", `-diff(${F},${x})/diff(${F},${y})`);
      // impDif(eq,x,y,n): each further derivative is ∂p/∂x + ∂p/∂y·y′ (the order was ignored).
      const order = args[3]?.k === "num" ? Number(args[3].v) : 1;
      let p = first;
      for (let k = 1; k < order && k < 6; k++) p = g("normal", `diff(${p},${x})+diff(${p},${y})*(${first})`);
      return p;
    }
    case "taylor":
    case "series": {
      // taylor(expr, x, order[, point]). Giac's series of surd(x²,3) is undef ("Sign error"); of surd(x,3)² it is x^(2/3).
      const e = args[0] ? toGiac(args[0], { ...s, rootPowers: true }) : a0!;
      return g("convert", g("series", e, `${a1}=${a3 ?? "0"}`, a2 ?? "5"), "polynom");
    }
    case "log":
      return args.length === 2 ? g("logb", a0!, a1!) : g("log10", a0!);
    case "median":
      // A list's middle value, or the mean of the two middle values (Giac's
      // median takes the lower one). Matrices go column by column in Giac.
      // A stored list counts too, and a frequency list repeats each value.
      // Giac's median of a matrix is in decimals; exact entries keep an exact answer.
      if (!(args[0] && listy(args[0], s)))
        return listData(args[0], a0!, args[0] && !hasDecimal(args[0]) ? g("exact", g("median", ...A)) : g("median", ...A));
      {
        const L = a1 ? `flatten(seq(seq((${a0})[k_],j_,1,(${a1})[k_]),k_,0,size(${a0})-1))` : a0!;
        return freqSized(A, `(L_->(sort(L_)[floor((size(L_)-1)/2)]+sort(L_)[ceil((size(L_)-1)/2)])/2)(${L})`);
      }
    case "root":
      // Giac leaves surd(8,3) as 8^(1/3); the handheld shows 2.
      return g("simplify", g("surd", a0!, a1 ?? "2"));
    // mod(x,0) and remain(x,0) are x; lists and matrices go element by element.
    case "mod":
      return elementwise("(a_,b_)->when(b_==0,a_,a_-b_*floor(a_/b_))", args, A);
    case "remain":
      return elementwise("(a_,b_)->when(b_==0,a_,a_-b_*trunc(a_/b_))", args, A);
    case "lcm":
      return g("abs", g("lcm", ...A));
    case "sum":
    case "product": {
      // sum(list, start[, end]) adds the elements start…end, counted from 1.
      const range = args.length > 1 ? `[(${a1})-1..${args.length > 2 ? `(${a2})-1` : "size(" + a0 + ")-1"}]` : "";
      return g("normal", g(f, `(${a0})${range}`));
    }
    case "varSamp":
      return twoOrMore(args[0], a0!, freqSized(A, g("normal", `${g("stddevp", ...A)}^2`)), s);
    case "mean":
      return listData(args[0], a0!, freqSized(A, g("mean", ...A)), s);
    case "piecewise": {
      const ordered = orderedPiecewise(args, s);
      if (ordered) return ordered;
      // Ours: value, condition, …; Giac: condition, value, …
      const out: string[] = [];
      for (let i = 0; i < A.length; i += 2) {
        if (A[i + 1] !== undefined) out.push(A[i + 1]!, A[i]!);
        else out.push(A[i]!);
      }
      return g("piecewise", ...out);
    }
    case "when":
      return g("when", ...A);
    case "normPdf":
      return g("normald", a1 ?? "0", a2 ?? "1", a0!);
    case "normCdf": {
      // With an unknown (solve(normCdf(3.5,∞,2.5,s)=0.02,s)), Giac's normal_cdf can't be solved;
      // the erf form can, an infinite end giving ±1.
      if (args.some(containsSym)) {
        const [mu, sd] = [a2 ?? "0", a3 ?? "1"];
        const end = (v: string) => {
          const w = infinite(v);
          return w === "inf" ? "1" : w === "-inf" ? "-1" : `erf(((${v})-(${mu}))/((${sd})*sqrt(2)))`;
        };
        return `((${end(a1!)})-(${end(a0!)}))/2`;
      }
      return g("normal_cdf", a2 ?? "0", a3 ?? "1", infinite(a0!), infinite(a1!));
    }
    case "invNorm":
      return g("normal_icdf", a1 ?? "0", a2 ?? "1", a0!);
    case "binomPdf":
      return args.length === 2 ? g("seq", g("binomial", a0!, "k", a1!), "k", "0", a0!) : g("binomial", a0!, a2!, a1!);
    case "binomCdf":
      if (infiniteBound(args.slice(2))) return `"Error: Domain error"`;
      // An unknown number of trials up to all of them (solve(binomCdf(n,0.2,1,n)≥0.99,n)):
      // Giac can't sum to a symbolic end (Bad Argument, then the session dies), but
      // Pr(X≥a) is 1−Pr(X≤a−1), a finite sum it can. Only for a≤1, where that is
      // 1−(1−p)^n: from a=2 Giac writes C(n,k) with Gamma, which the handheld can't
      // show, its solve of an equation in it misses the real root (n=11.4318 for
      // binomCdf(n,0.3,2,n)=0.9) and its solve of an inequality still crashes.
      if (args.length === 4 && containsSym(args[0]!) && a3 === a0) {
        const from = constantValue(args[2]!);
        if (Number.isInteger(from) && from <= 1) return from <= 0 ? "1" : `(1-${g("binomial_cdf", a0!, a1!, "0", "0")})`;
      }
      return args.length === 3 ? g("binomial_cdf", a0!, a1!, a2!) : g("binomial_cdf", a0!, a1!, a2!, a3!);
    case "invBinom":
      return g("binomial_icdf", a1!, a2!, a0!);
    case "poissPdf":
      return g("poisson", a0!, a1!);
    case "poissCdf":
      if (infiniteBound(args.slice(1))) return `"Error: Domain error"`;
      return args.length === 2 ? g("poisson_cdf", a0!, a1!) : g("poisson_cdf", a0!, a1!, a2!);
    case "geomPdf":
      return g("geometric", a0!, a1!);
    case "geomCdf":
      if (infiniteBound(args.slice(1))) return `"Error: Domain error"`;
      return args.length === 2 ? g("geometric_cdf", a0!, a1!) : g("geometric_cdf", a0!, a1!, a2!);
    case "tPdf":
      return g("studentd", a1!, a0!);
    case "tCdf":
      return g("student_cdf", a2!, infinite(a0!), infinite(a1!));
    case "invt":
      return g("student_icdf", a1!, a0!);
    case "unitV":
      // Divided by the length of all its entries (l2norm of a column matrix is a decimal norm).
      // A zero vector is undef in every place ([[undef,undef,undef]]): Giac's
      // normal of it divided by 0 leaves a single undef.
      return `ifte(dot(flatten(${a0}),flatten(${a0}))==0,(${a0})*undef,${g("normal", `(${a0})/sqrt(dot(flatten(${a0}),flatten(${a0})))`)})`;
    case "norm":
      if (args[0]?.k === "mat" && args[0].rows.length > 1) return g("frobenius_norm", a0!);
      // With a variable the sum of squares is collected: norm([−10t,100−10t,20t−100]) is
      // 10·√2·√(3t²−30t+100), where Giac's l2norm leaves √(100·t·t+(100−10t)·(100−10t)+…).
      return args[0] && containsSym(args[0]) && !heavy(a0!) ? g("normal", g("l2norm", a0!)) : g("l2norm", a0!);
    case "nInt":
      return g("evalf", g("integrate", ...A));
    // nfMin(f,x,a,b): the bounds as Giac's range.
    case "nfMin":
    case "nfMax":
      return g("evalf", g(f.slice(1), a0!, args.length >= 4 ? `${a1}=${a2}..${a3}` : (a1 ?? "x")));
    case "csc":
    case "sec":
    case "cot":
      // 2/√2 → √2: the handheld rationalises.
      return g("normal", g(f, ...A));
    case "polyCoeffs": {
      // Each coefficient factored, as the handheld shows them: {1,2·(y+z),(y+z)²}.
      const v = a1 ?? (args[0] ? mainVar(args[0]) : undefined) ?? "x";
      return `map(coeff(${a0},${v}),factor)`;
    }
    case "charPoly":
      // det(m − x·I), the handheld's sign.
      return g("expand", g("det", `(${a0})-(${a1 ?? "x"})*idn(rowdim(${a0}))`));
    case "nDerivative":
      return g("evalf", g("subst", g("diff", a0!, varOf(args[1], s)), a1 ?? "x"));
    case "index": {
      // The handheld counts from 1, Giac from 0. zeros(…)[k] counts in the
      // handheld's ascending order; a matrix's row stays a one-row matrix.
      const x = args[0];
      // A one-row matrix is a flat vector in Giac: q[1,2] is read from [q].
      const row = args.length === 3 && !!x && (rowMatrix(x, s) || (x.k === "sym" && !!s.lists?.has(RENAME_IN[x.name] ?? x.name)));
      const base = x?.k === "call" && x.f === "zeros" ? g("sort", a0!) : args.length === 3 && vectorCall(x, s) ? asRow(a0!) : row ? `[${a0}]` : x?.k === "sym" || x?.k === "call" ? a0! : `(${a0})`;
      const at = `${base}[${A.slice(1).map((k) => `(${k})-1`).join(",")}]`;
      const matrixVar = args[0]?.k === "sym" && s.matrices?.has(RENAME_IN[args[0].name] ?? args[0].name);
      return matrixVar && args.length === 2 ? `[${at}]` : at;
    }
    case "newMat":
      return g("matrix", a0!, a1!);
    case "dim":
      // A one-row matrix is 1 by n ({1,3}), not a list's length.
      if (vectorCall(args[0], s)) return g("dim", asRow(a0!));
      return args[0] && rowMatrix(args[0], s) ? g("dim", `[${a0}]`) : g("dim", ...A);
    case "round":
      // In binary 1234.565 is 1234.56499…; the handheld (decimal arithmetic) rounds the written
      // digits. A nudge of 1E−13, far above binary error and far below a real difference, puts
      // the half back on the half (exact() of the float gave a fraction just under it: 1234.56).
      // Halves go away from zero (−5.05 → −5.1, −2.5 → −3); Giac's round sends them up.
      // With no digits it's 12 significant digits (round(−2.5) is −2.5).
      {
        const n = a1 ?? "0";
        const one = (v: string) => {
          if (!a1) return `evalf(${v},12)`;
          const e = `(${v})*10^(${n})`;
          return `sign(${e})*floor(abs(${e})*(1+10^(-13))+1/2)/10^(${n})`;
        };
        const x = args[0];
        const matrix = x && (x.k === "mat" || (x.k === "sym" && s.matrices?.has(RENAME_IN[x.name] ?? x.name)));
        const r = matrix ? `map(${a0},r_->map(r_,t_->${one("t_")}))` : x && listy(x, s) ? `map(${a0},t_->${one("t_")})` : one(a0!);
        return a1 ? `evalf(${r})` : r;
      }
    case "cumulativeSum":
      return g("cumSum", ...A);
    // An element meets the criterion when it is true with the element for ?
    // (?<5, 2<?<8, ?<4 or ?>6), or, with no ?, when it equals it (3, "def", x):
    // countIf and sumIf both count this way. An element the test can't decide
    // (undef, a symbol against ?<5) doesn't.
    case "countIf":
    case "sumIf": {
      if (args.length < 2 || args.length > (f === "countIf" ? 2 : 3)) break;
      const crit = args[1]!;
      const test = mentionsElement(crit) ? a1! : `q_==(${a1})`;
      // evalb leaves an undecided test as it is, so only a true one counts. A string
      // against an order test ("abc"<5) is skipped before Giac compares them, which crashes it.
      const met = (then: string) => `ifte(type(q_)==DOM_STRING and ${mentionsElement(crit) ? 1 : 0},0,ifte(evalb(${test})==1,${then},0))`;
      if (f === "countIf") return `sum(map(${a0},q_->${met("1")}))`;
      if (!a2) return `normal(sum(map(${a0},q_->${met("q_")})))`;
      return `ifte(size(${a0})==size(${a2}),normal(sum(zip((q_,w_)->${met("w_")},${a0},${a2}))),"Error: Sizes do not match")`;
    }
    // seqGen(expr, n, u, {n0, nMax}, {first terms}, step): the terms for n = n0, n0+step, … nMax,
    // the first ones given and each after from expr, where u(n−1) is the term before. One Giac
    // program builds the list with n local to it, so a stored n is left as it was.
    case "seqGen": {
      const [expr, v, dep, range, first, step] = args;
      // A system of sequences ({expr, expr}, {u1, u2}) and CeilingValue aren't done yet.
      if (!expr || expr.k === "list" || v?.k !== "sym" || dep?.k !== "sym" || range?.k !== "list" || range.items.length !== 2 || args.length > 6)
        throw new UnsupportedError(f);
      const [n0, nMax] = range.items as [Ast, Ast];
      const by = step ?? num(1);
      // u(k) is the term at n = k: position (k − n0)/step + 1 in L_, counting from 1. Giac counts
      // L_[−1] from the end and rounds L_[1.5] down, so a term before the first (u(n−2) with one
      // first term) or between two would quietly be another one: those are a Dimension error
      // (Giac's own word for a position out of range). ifte works out only the branch it takes,
      // so a term a when() steers around (when(n=1,1,u(n−1))) is never looked up.
      const at: string[] = [];
      const term = mapAst(expr, (x) => {
        if (x.k !== "call" || x.f !== dep.name || x.args.length !== 1) return x;
        const p = `(${t(bin("+", bin("/", bin("-", x.args[0]!, n0), by), num(1)))})`;
        at.push(`ifte(${p}>=1 and ${p}<=size(L_) and ${p}==floor(${p}),L_[${p}-1],error("Invalid dimension"))`);
        return sym(`seqat${at.length - 1}_`);
      });
      // Innermost last: u(u(n−1)) puts one position inside another.
      const body = at.reduceRight((text, code, k) => text.replaceAll(`seqat${k}_`, code), t(term));
      const n = t(v);
      const last = `((${t(nMax)})-(${t(n0)}))/(${t(by)})`;
      return `((L_)->{local k_,${n}; for(k_:=size(L_);k_<=${last};k_++){${n}:=(${t(n0)})+k_*(${t(by)}); L_:=append(L_,${body});} return L_;})(${first ? t(first) : "[]"})`;
    }
    case "ΔList":
    case "deltaList":
      return g("deltalist", ...A);
    // Positions count from 1 on the handheld, from 0 in Giac.
    case "mid":
      if (A.length < 2) break;
      return g("mid", a0!, `(${a1})-1`, ...A.slice(2));
    case "subMat":
      return g("subMat", a0!, `(${a1 ?? "1"})-1`, `(${a2 ?? "1"})-1`, `(${a3 ?? `rowdim(${a0})`})-1`, `(${A[4] ?? `coldim(${a0})`})-1`);
    case "linSolve": {
      const eqs = args[0]?.k === "list" ? args[0].items : args[0] ? conjuncts(args[0]) : [];
      const vs = args[1]?.k === "list" ? args[1].items : args[1] ? [args[1]] : [];
      return g("linsolve", `[${eqs.map((x) => toGiac(x, s)).join(",")}]`, `[${vs.map((x) => toGiac(x, s)).join(",")}]`);
    }
    case "stDevPop":
    case "stDevSamp":
    case "varPop":
      return twoOrMore(args[0], a0!, freqSized(A, g("normal", g(RENAME_FN[f]!, ...A))), s);
    case "eigVl":
      // Decimals, ascending, as the handheld lists them.
      return `sort(evalf([${g("eigenvals", a0!)}]))`;
      // Giac gives a bare sequence; the handheld a list.
    // Rows count from 1 on the handheld, from 0 in Giac.
    // Sizes the handheld checks: Giac gives det of a non-square matrix, and pads dot and cross.
    case "det":
      if (A.length !== 1) break;
      return `ifte(type(dim(${a0}))==DOM_LIST and dim(${a0})[0]==dim(${a0})[1],det(${a0}),"Error: Dimension error")`;
    case "dotP":
      if (A.length !== 2) break;
      return `ifte(size(${a0})==size(${a1}),dot(${a0},${a1}),"Error: Wrong kind of input")`;
    case "crossP":
      if (A.length !== 2) break;
      return `ifte(size(${a0})==size(${a1}) and (size(${a0})==2 or size(${a0})==3),cross(${a0},${a1}),"Error: Needs vectors of 2 or 3 entries")`;
    case "rowSwap":
    case "rowAdd":
      return g(f, a0!, `(${a1})-1`, `(${a2})-1`);
    case "mRow":
      return g("mRow", a0!, a1!, `(${a2})-1`);
    case "mRowAdd":
      return g("mRowAdd", a0!, a1!, `(${a2})-1`, `(${a3})-1`);
    case "colAugment":
      // Needs one-row matrices kept as matrices, which this engine flattens to vectors.
      throw new UnsupportedError(f);
  }
  const renamed = RENAME_FN[f];
  if (renamed) return g(renamed, ...A);
  // A user-defined function, or a variable applied to arguments.
  return g(giacName(f), ...A);
}

/** The variable named in "x=a" (nDerivative's form). */
function varOf(a: Ast | undefined, s: Ctx): string {
  if (a && a.k === "bin" && a.op === "=") return toGiac(a.a, s);
  return "x";
}

/**
 * binomCdf, poissCdf and geomCdf take numbers for bounds: ∞ is a Domain error
 * on the handheld (binomCdf(10,0.3,4,∞)), where Giac refuses it with Bad
 * Argument or sums to it.
 */
function infiniteBound(bounds: Ast[]): boolean {
  return bounds.some((b) => Math.abs(constantValue(b)) === Infinity);
}

/**
 * A frequency list gives one count per element; one of another length is a
 * size error, as on the handheld (mean({1,2,3},{1,2})), where Giac's
 * mean says Bad Argument and its median reads past the end.
 */
function freqSized(A: string[], expr: string): string {
  return A.length === 2 ? `ifte(size(${A[0]})==size(${A[1]}),${expr},"Error: Sizes do not match")` : expr;
}

/**
 * The statistics of data (mean, median and the spreads) take a list or a
 * matrix. Anything else is a type error, as on the handheld: mean(undefinedlist)
 * there, where Giac answers with the name. A literal or stored list needs no check.
 */
function listData(arg: Ast | undefined, data: string, expr: string, s?: Ctx): string {
  if (arg && s && listy(arg, s)) return expr;
  return `ifte(type(${data})==DOM_LIST,${expr},"Error: Wrong kind of input")`;
}

/**
 * The spreads need a list of two or more elements, a matrix of two or more
 * rows (stDevSamp, stDevPop, varSamp and varPop):
 * stDevSamp({5}) is a Dimension error on the handheld, undef in Giac. A
 * one-row matrix ([[1,2]], or [1,2]) is one too, though it reaches Giac as
 * a plain list.
 */
function twoOrMore(arg: Ast | undefined, data: string, expr: string, s: Ctx): string {
  if (arg?.k === "mat" && arg.rows.length === 1) return `"Error: Dimension error"`;
  return listData(arg, data, `ifte(size(${data})<2,"Error: Dimension error",${expr})`, s);
}

/** The handheld's ±9E999 stand-ins for infinity. */
function infinite(v: string): string {
  if (/^-9e999$/.test(v)) return "-inf";
  if (/^9e999$/.test(v)) return "inf";
  return v;
}

/** tangentLine(f, x, a) or tangentLine(f, x=a): the variable and the point. */
export function lineAt(args: Ast[], s: Ctx): [string, string] {
  const v = args[1];
  if (v?.k === "bin" && v.op === "=") return [toGiac(v.a, s), toGiac(v.b, s)];
  return [v ? toGiac(v, s) : "x", args[2] ? toGiac(args[2], s) : "0"];
}

/** A two-argument function applied element by element when either argument is a list or matrix. */
function elementwise(fn: string, args: Ast[], A: string[]): string {
  const [x, y] = args;
  const [a, b] = A;
  const many = (t?: Ast) => t?.k === "list" || t?.k === "mat";
  if (many(x) && many(y)) return `zip(${fn},${a},${b})`;
  if (many(x)) return `map(${a},t_->(${fn})(t_,${b}))`;
  if (many(y)) return `map(${b},t_->(${fn})(${a},t_))`;
  return `(${fn})(${a},${b})`;
}

/**
 * Too costly for Giac's normal to simplify: it ran out of memory on
 * 3^(1/3)+4^(1/4) and never returned on (√2−√6)/4+9^(1/4), taking the
 * engine down. Two higher roots, a higher root beside a square root, or a
 * long answer; the handheld leaves such sums as they are.
 */
export function heavy(text: string): boolean {
  const higher = (text.match(/\^\(\s*-?\d*\s*\/\s*([3-9]|\d{2,})\s*\)|surd\(/g) ?? []).length;
  const square = (text.match(/sqrt\(/g) ?? []).length;
  return text.length > 400 || higher > 1 || (higher > 0 && square > 0) || /rootof/.test(text);
}

/** "1.25" → "(125/100)", "1.5E10" → "(15*10^9)": a decimal literal as an exact number. */
function decimalFraction(v: string): string {
  const [mant, exp = "0"] = v.split("E");
  const [whole = "0", frac = ""] = mant!.split(".");
  const digits = `${whole}${frac}`.replace(/^(-?)0+(?=\d)/, "$1") || "0";
  const shift = Number(exp) - frac.length;
  return shift >= 0 ? `(${digits}*10^${shift})` : `(${digits}/10^${-shift})`;
}

/**
 * Define f(x)=expr, as the handheld does it: the right side is worked out
 * when it's defined, so Define q(t)=d(p(t),t) stores the derivative and
 * q(2) is a number. evaluate() works it out with the parameters and every
 * other variable held as placeholders (x_p_, a_q_), so a stored x can't
 * turn f(x)=x² into a constant and a slider a stays live, then puts the
 * names back and stores the result; this plain form is the fallback.
 */
function defineGiac(lhs: Ast, rhs: Ast, s: Ctx): string {
  return `${toGiac(lhs, s)}:=${toGiac(rhs, s)}`;
}

/** A number written with digits, π, ℯ, √ and + − × ÷ ^ (NaN for anything else). */
function constantValue(a: Ast): number {
  switch (a.k) {
    case "num":
      return Number(a.v.replace(/\.$/, "").replace("E", "e"));
    case "sym":
      return a.name === "π" ? Math.PI : a.name === "ℯ" ? Math.E : a.name === "∞" ? Infinity : NaN;
    case "neg":
      return -constantValue(a.a);
    case "bin": {
      const [p, q] = [constantValue(a.a), constantValue(a.b)];
      return a.op === "+" ? p + q : a.op === "-" ? p - q : a.op === "*" ? p * q : a.op === "/" ? p / q : a.op === "^" ? p ** q : NaN;
    }
    case "call":
      return a.f === "√" && a.args.length === 1 ? Math.sqrt(constantValue(a.args[0]!)) : NaN;
    default:
      return NaN;
  }
}

type Piece = { value: Ast; lo?: { at: Ast; n: number; closed: boolean }; hi?: { at: Ast; n: number; closed: boolean } };

/**
 * piecewise with interval pieces (0≤x≤4, x>2) as an ordered chain:
 * piecewise(k*x*(4−x),0≤x≤4,0) is piecewise(x<0,0,x<=4,k*x*(4−x),0).
 * Giac's integrate and solve can't work with a condition that's an "and"
 * (∫ over −∞..∞ is undef; solve(g(x)=2,x) is false); with one comparison
 * per piece they can. Only for pieces that are intervals of one variable
 * with number ends that don't overlap; anything else is left as written.
 * format's piecewiseBack shows the chain as intervals again.
 */
function orderedPiecewise(args: Ast[], s: Ctx): string | null {
  const REL = ["<", "≤", ">", "≥"];
  let v: string | undefined;
  const side = (c: Ast, p: Piece): boolean => {
    if (c.k !== "bin" || !REL.includes(c.op)) return false;
    const flip: Record<string, string> = { "<": ">", ">": "<", "≤": "≥", "≥": "≤" };
    const [x, k, op] =
      c.a.k === "sym" && !Number.isNaN(constantValue(c.b))
        ? [c.a, c.b, c.op]
        : c.b.k === "sym" && !Number.isNaN(constantValue(c.a))
          ? [c.b, c.a, flip[c.op]!]
          : [null, null, ""];
    if (!x || x.k !== "sym" || !k || Number.isNaN(constantValue(k))) return false;
    if (v !== undefined && v !== x.name) return false;
    v = x.name;
    const end = { at: k, n: constantValue(k), closed: op === "≤" || op === "≥" };
    if (op === "<" || op === "≤") {
      if (p.hi) return false;
      p.hi = end;
    } else {
      if (p.lo) return false;
      p.lo = end;
    }
    return true;
  };
  const interval = (c: Ast, p: Piece): boolean => {
    if (c.k === "bin" && c.op === "and") return interval(c.a, p) && interval(c.b, p);
    // a≤x≤b parses as (a≤x)≤b.
    if (c.k === "bin" && REL.includes(c.op) && c.a.k === "bin" && REL.includes(c.a.op))
      return side(c.a, p) && side({ k: "bin", op: c.op, a: c.a.b, b: c.b }, p);
    return side(c, p);
  };
  const pieces: Piece[] = [];
  for (let i = 0; i + 1 < args.length; i += 2) {
    const p: Piece = { value: args[i]! };
    if (!interval(args[i + 1]!, p)) return null;
    pieces.push(p);
  }
  if (!v || !pieces.some((p) => p.lo && p.hi)) return null;
  const otherwise = args.length % 2 ? toGiac(args[args.length - 1]!, s) : "undef";
  pieces.sort((p, q) => (p.lo?.n ?? -Infinity) - (q.lo?.n ?? -Infinity));
  const X = toGiac(sym(v), s);
  const out: string[] = [];
  let cursor = -Infinity;
  let cursorClosed = true;
  for (const [i, p] of pieces.entries()) {
    const lo = p.lo?.n ?? -Infinity;
    const hi = p.hi?.n ?? Infinity;
    if (lo > hi || lo < cursor || (lo === cursor && lo !== -Infinity && cursorClosed && p.lo?.closed)) return null;
    // The gap below this piece, if there is one, takes the otherwise value.
    if (p.lo && (lo > cursor || (!cursorClosed && !p.lo.closed))) out.push(`${X}${p.lo.closed ? "<" : "<="}${toGiac(p.lo.at, s)}`, otherwise);
    if (!p.hi) {
      if (i !== pieces.length - 1) return null;
      out.push(toGiac(p.value, s));
      return g("piecewise", ...out);
    }
    out.push(`${X}${p.hi.closed ? "<=" : "<"}${toGiac(p.hi.at, s)}`, toGiac(p.value, s));
    cursor = hi;
    cursorClosed = p.hi.closed;
  }
  out.push(otherwise);
  return g("piecewise", ...out);
}

/**
 * head: the function with its parameters held (f(x_p_)). The stored
 * definition keeps them held: Giac's integrate and solve go wrong when the
 * variable they work in has the parameter's name (f(x):=piecewise(0≤x≤1,…)
 * then ∫(f(x),x,0,1) is undef, while ∫(f(t),t,0,1) is right).
 */
export type DefineParts = { head: string; body: string; names: Record<string, string> };

/** The pieces evaluate() needs to work a definition out first (null if it isn't f(x,…)=…). */
export function defineParts(input: Ast, s: Ctx): DefineParts | null {
  const pair =
    input.k === "define" ? [input.lhs, input.rhs] : input.k === "bin" && input.op === "→" ? [input.b, input.a] : input.k === "bin" && input.op === ":=" ? [input.a, input.b] : null;
  if (!pair) return null;
  const [lhs, rhs] = pair as [Ast, Ast];
  if (!(lhs.k === "call" && lhs.args.length && lhs.args.every((p) => p.k === "sym"))) return null;
  const params = lhs.args.map((p) => (p as { name: string }).name);
  const names: Record<string, string> = {};
  const body = mapAst(rhs, (y) => {
    if (y.k !== "sym" || y.name in SYMS || y.name === "") return y;
    const giacName = RENAME_IN[y.name] ?? y.name;
    const held = params.includes(y.name) ? `${giacName}_p_` : `${giacName}_q_`;
    names[held] = giacName;
    return sym(held);
  });
  const head: Ast = { ...lhs, args: lhs.args.map((p) => sym(`${RENAME_IN[(p as { name: string }).name] ?? (p as { name: string }).name}_p_`)) };
  return { head: toGiac(head, s), body: toGiac(body, s), names };
}
