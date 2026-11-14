// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 VCE Hub. Part of the /cas calculator: https://github.com/vcehub/cas
import { isCommand, mapAst, parse, ParseError, sym, type Ast } from "../math/ast";
import { print } from "../math/print";
import { decimalArithmetic } from "./decimal";
import { EngineError, format, formatFloat, numericValue, shownDecimal, unrounded } from "./format";
import { frequencies, meanInterval, meanTest, memberName, oneVar, propInterval, regression, STAT_COMMANDS, twoVar, zStatistic, type StatResult, type StatRow } from "./stats";
import { finance, FINANCE, type FinanceArg, type FinanceValue } from "./finance";
import { BUILTINS } from "../math/builtins";
import { rootIn, rootsIn } from "../graphs/analyze";
import { defineParts, handheldForms, heavy, lineAt, RENAME_IN, toGiac, translate, UnsupportedError } from "./translate";
import { inputWarning, warning, type Warning } from "./warnings";

/**
 * One entry-line evaluation: entry-line text in, the answer out. The
 * Giac call is injected (a worker in the browser, the wasm module directly in
 * the parity script) so both run exactly this code.
 */
export type Settings = {
  angle: "rad" | "deg";
  /** Auto approximates only when the input has a decimal; Approximate always. */
  mode: "auto" | "exact" | "approx";
  /** Float n display digits. */
  digits: number;
  /** Polar shows every complex answer as ℯ^(iθ)·r (or r∠θ in degrees). */
  complex: "real" | "rect" | "polar";
};

export const DEFAULT_SETTINGS: Settings = { angle: "rad", mode: "auto", digits: 6, complex: "real" };

export type Giac = (cmd: string) => Promise<string>;

/**
 * Giac's "zero" threshold. Its exact algebra lowers it (to 1E−180) and
 * leaves it there when it fails part-way (iquo error on a cubic inequality),
 * after which numeric solves return the wrong number of roots; so it is set
 * again with every entry.
 */
const EPSILON = "epsilon:=1e-12";

/** Giac commands that put it in the state the handheld's defaults imply. */
export function setupCommands(s: Settings): string[] {
  return [
    "xcas_mode(0)",
    "all_trig_solutions:=1",
    `angle_radian:=${s.angle === "rad" ? 1 : 0}`,
    `complex_mode:=${s.complex === "real" ? 0 : 1}`,
    EPSILON,
  ];
}

export type EvalResult =
  | {
      ok: true;
      input: Ast;
      output: Ast;
      outputText: string;
      definition?: string;
      /** Every definition a line of several commands (1→a:2→b:…) made. */
      definitions?: string[];
      /** A regression's equation saved as a function (f1 …), for the Graphs pages to plot. */
      regEqn?: { n: number; text: string };
      /** The handheld's ⚠ beside the entry: the answer stands, with this message. */
      warning?: Warning;
    }
  | { ok: false; input?: Ast; error: string };

export async function evaluate(
  text: string,
  giac: Giac,
  opts: {
    settings: Settings;
    ans?: Ast;
    approx?: boolean;
    /**
     * The caller reads the solutions as values (fMax's critical points, the
     * sign method's breaks): no conditions are added to what Giac solves.
     */
    values?: boolean;
  },
): Promise<EvalResult> {
  // Whatever goes wrong inside, the entry answers with an error rather than throwing.
  try {
    return await evaluateText(text, giac, opts);
  } catch (e) {
    if (e instanceof EngineError) return { ok: false, error: e.message };
    if (e instanceof UnsupportedError) return { ok: false, error: "Error: Not available here yet" };
    return { ok: false, error: "Error: Invalid input" };
  }
}

const SOLVE_LIKE = new Set(["solve", "cSolve", "zeros", "cZeros", "nSolve"]);
/** Functions of one argument a student might type with none (sin()), or name without brackets (sin x). */
const ONE_ARG = new Set(["sin", "cos", "tan", "sin⁻¹", "cos⁻¹", "tan⁻¹", "csc", "sec", "cot", "sinh", "cosh", "tanh", "ln", "log", "√", "abs", "exp", "floor", "ceiling", "int", "iPart", "fPart", "sign", "conj", "real", "imag", "angle"]);
const TWO_ARGS = new Set(["nCr", "nPr", "mod", "gcd", "lcm", "root", "remain"]);

/**
 * Inputs the handheld refuses before working anything out: solve(x^2=4)
 * and zeros(x^2-4) without a variable and sin() or nCr(5) are "Too few
 * arguments"; solve of an expression, 5→3, Define 3=x and sin x each get
 * an error in our own words.
 */
function inputError(a: Ast): string | null {
  let err: string | null = null;
  // Any comparison in it counts ({x+1=2} is fine on the handheld): only a bare expression is refused.
  const relation = (x: Ast): boolean => {
    let found = false;
    mapAst(x, (y) => {
      if (y.k === "bin" && ["=", "≠", "<", ">", "≤", "≥"].includes(y.op)) found = true;
      return y;
    });
    return found;
  };
  const target = a.k === "bin" && a.op === "→" ? a.b : a.k === "define" ? a.lhs : null;
  if (target && !(target.k === "sym" && !["π", "ℯ", "pi", "∞"].includes(target.name)) && !(target.k === "call" && /^[A-Za-z]/.test(target.f)) && !(target.k === "call" && target.f === "index"))
    return "Error: That name can't be used";
  mapAst(a, (x) => {
    if (err) return x;
    if (x.k === "call") {
      if (SOLVE_LIKE.has(x.f) && x.args.length < 2) err = "Error: Too few arguments";
      else if ((x.f === "solve" || x.f === "cSolve") && x.args[0] && !relation(x.args[0]) && !["sym", "call"].includes(x.args[0].k))
        err = "Error: Solve needs an equation or inequality first";
      else if ((ONE_ARG.has(x.f) && x.args.length < 1) || (TWO_ARGS.has(x.f) && x.args.length < 2)) err = "Error: Too few arguments";
    }
    // sin x: a function's name used as a factor.
    if (x.k === "bin" && x.implicit && x.a.k === "sym" && ONE_ARG.has(x.a.name)) err = "Error: Put the argument in brackets";
    // A substitution of a variable by something that has it in it (…|x=x-1/2) can't be made.
    if (x.k === "bin" && x.op === "|" && conjuncts(x.b).some((c) => c.k === "bin" && c.op === "=" && c.a.k === "sym" && mentions(c.b, c.a.name)))
      err = "Error: Invalid constraint";
    return x;
  });
  return err;
}

/** True if name occurs free in a: fMax(h(x),x) and d(f(x),x) bind their x. */
function mentions(a: Ast, name: string): boolean {
  switch (a.k) {
    case "sym":
      return a.name === name;
    case "call":
      if (a.args.slice(1).some((x) => x.k === "sym" && x.name === name)) return false;
      return a.args.some((x) => mentions(x, name));
    case "bin":
      return mentions(a.a, name) || mentions(a.b, name);
    case "neg":
    case "not":
    case "post":
      return mentions(a.a, name);
    case "list":
      return a.items.some((x) => mentions(x, name));
    case "mat":
      return a.rows.some((r) => r.some((x) => mentions(x, name)));
    default:
      return false;
  }
}

/**
 * A | domain on the solve variable whose bounds can't both hold (x>0 and x<0):
 * "Invalid constraint" on the handheld, not false. Only plain numeric bounds
 * count; x≠2 and x≠−2 stays an ordinary constraint (false for x²=4).
 */
async function emptyDomain(a: Ast, giac: Giac, settings: Settings): Promise<boolean> {
  if (!(a.k === "bin" && a.op === "|" && a.a.k === "call" && a.a.f === "solve" && a.a.args[1]?.k === "sym")) return false;
  const d = domainOf(a.b, a.a.args[1].name, settings);
  if (!d?.lo || !d.hi) return false;
  const [lo, hi] = splitTop((await giac(`[evalf(${d.lo.v}),evalf(${d.hi.v})]`)).replace(/^\[|\]$/g, "")).map(Number);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return false;
  return lo! > hi! || (lo === hi && !(d.lo.closed && d.hi.closed));
}

/**
 * An entry that starts with an operator needing a left side (+1, *2, ^2, /4)
 * or with a conversion (▶Decimal) works on the last answer. On the handheld
 * it's the entry line that does this: the key or menu item, used on an empty
 * line, writes ans in front of itself (given "+1" as text, its evaluator says
 * Syntax). The page's entry line does the same as it's typed (calc-keys.ts);
 * this is for text that arrives whole, standing for those keys. A leading
 * minus stays a negative sign.
 */
const onAns = (text: string) => (/^[+*/^×÷·▶►]/.test(text) ? `ans${text}` : text);

const isAns = (a: Ast) => a.k === "sym" && (a.name === "ans" || a.name === "Ans");

function namesAns(a: Ast): boolean {
  let found = false;
  mapAst(a, (x) => {
    if (isAns(x)) found = true;
    return x;
  });
  return found;
}

/** The last answer put in where ans is named. */
const withAnswer = (a: Ast, ans: Ast | undefined): Ast => (ans ? mapAst(a, (x) => (isAns(x) ? ans : x)) : a);

async function evaluateText(
  typedText: string,
  giac: Giac,
  opts: { settings: Settings; ans?: Ast; approx?: boolean; seen?: Set<string>; values?: boolean },
): Promise<EvalResult> {
  const text = onAns(typedText);
  let input: Ast;
  try {
    input = parse(text);
  } catch (e) {
    if (e instanceof ParseError) return { ok: false, error: "Error: Syntax" };
    throw e;
  }
  const refused = inputError(input);
  if (refused) return { ok: false, input, error: refused };
  if (input.k === "bin" && input.op === ":") return statements(input, giac, opts);
  // With no answer before it (a new document), ans is an error,
  // never whatever Giac last worked out.
  if (!opts.ans && namesAns(input)) return { ok: false, input, error: "Error: No earlier answer to use" };
  if (input.k === "call" && input.f === "CopyVar") return copyVar(input, giac, opts.settings);
  if (input.k === "call" && STAT_COMMANDS.has(input.f)) return statistics(withAnswer(input, opts.ans) as typeof input, giac, opts.settings);
  const results = await statResults(input, giac, opts.settings);
  if (results) return results;
  if (opts.settings.complex === "polar") {
    // Work in rectangular form; a complex answer is then shown as ▶Polar would.
    const rect = { ...opts, settings: { ...opts.settings, complex: "rect" as const } };
    const r = await evaluate(text, giac, rect);
    if (!r.ok) return r;
    // An entry that ends in a conversion keeps the form it asked for: ▶Rect shows a+b·i
    // even in Polar mode, as ▶Polar already does.
    if (!/\bi\b/.test(r.outputText) || r.definition || /▶(Polar|Rect)\s*$/.test(text)) return r;
    // Each complex number in the answer, solutions and list entries too, as ▶Polar shows it.
    const polar = async (x: Ast): Promise<Ast> => {
      if (x.k === "bin" && (x.op === "or" || x.op === "and")) return { ...x, a: await polar(x.a), b: await polar(x.b) };
      if (x.k === "bin" && x.op === "=") return { ...x, b: await polar(x.b) };
      if (x.k === "list") return { ...x, items: await Promise.all(x.items.map(polar)) };
      let free = false;
      let complexValue = false;
      mapAst(x, (y) => {
        if (y.k === "sym" && y.name === "i") complexValue = true;
        else if (y.k === "sym" && !["π", "ℯ"].includes(y.name)) free = true;
        return y;
      });
      if (free || !complexValue) return x;
      const p = await evaluate(`(${print(x)})▶Polar`, giac, rect);
      return p.ok ? p.output : x;
    };
    if (r.output.k === "mat") return r;
    const output = await polar(r.output);
    return { ...r, output, outputText: print(output) };
  }
  const stats = await statVariables(input, giac);
  let typed = handheldForms(withAnswer(stats, opts.ans));
  const fin = await financeCalls(input, typed, giac, opts.settings);
  if (fin && "ok" in fin) return fin;
  if (fin) typed = fin;
  const withAns = await storedVariables(typed, giac);
  if (typeof withAns === "string") return { ok: false, input, error: withAns };
  // Arithmetic on decimals is the handheld's 14-digit decimal arithmetic, not Giac's doubles.
  // A store (normCdf(8,∞,0,1)→p, or p:=normCdf(8,∞,0,1)) keeps that value, in range of Giac's doubles.
  const store = withAns.k === "bin" && ((withAns.op === "→" && withAns.b.k === "sym") || (withAns.op === ":=" && withAns.a.k === "sym")) ? withAns : null;
  const stored = store && (store.op === "→" ? store.a : store.b);
  const decimal = opts.settings.mode === "exact" ? null : await decimalArithmetic(stored ?? withAns, giac, opts.settings, opts.settings.mode === "approx" || opts.approx === true);
  if (decimal && !store) return { ok: true, input, output: decimal, outputText: print(decimal) };
  const held = decimal && unrounded(decimal);
  if (store && held && Number.isFinite(numericValue(held)) && (numericValue(held) !== 0 || /^0\.$/.test(print(held)))) {
    const r = await evaluateParsed(input, store.op === "→" ? { ...store, a: held } : { ...store, b: held }, giac, opts);
    return r.ok ? { ...r, output: decimal, outputText: print(decimal!) } : r;
  }
  let r = (await eachDomain(input, withAns, giac, opts)) ?? (await evaluateParsed(input, withAns, giac, opts));
  if (r.ok) {
    // A user's function that calls one (Define p(k)=tvmPmt(k,…), then p(240)) comes back
    // from Giac with the call in it, its arguments now numbers: worked out once more.
    let omitted = false;
    const output = mapAst(r.output, (x) => (x.k === "sym" && x.name === OMITTED ? ((omitted = true), sym("")) : x));
    if (numericFinance(output)) return { ...(await evaluate(print(output), giac, opts)), input };
    if (omitted) r = { ...r, output, outputText: print(output) };
  }
  if (r.ok && !r.warning) {
    const w = await inputWarning(withAns, r.output, giac, { ...opts.settings, approx: opts.approx });
    if (w) r = { ...r, warning: w };
  }
  if (withAns === typed || !r.ok) return r;
  // A variable renamed out of the way keeps its own name in the answer.
  const output = mapAst(r.output, (a) => (a.k === "sym" && a.name.endsWith(FORMAL) ? sym(a.name.slice(0, -FORMAL.length)) : a));
  return { ...r, output, outputText: print(output) };
}

const DOMAIN_SPLIT = new Set(["solve", "cSolve", "zeros", "cZeros"]);

/**
 * solve(…)|x<0 or x>3: Giac takes no "or" assumption, so each side of the
 * "or" is solved on its own and the answers joined (repeats dropped, in
 * ascending order where they're numbers).
 */
async function eachDomain(
  input: Ast,
  withAns: Ast,
  giac: Giac,
  opts: { settings: Settings; ans?: Ast; approx?: boolean },
): Promise<EvalResult | null> {
  if (!(withAns.k === "bin" && withAns.op === "|" && withAns.a.k === "call" && DOMAIN_SPLIT.has(withAns.a.f))) return null;
  const branches: Ast[] = [];
  const split = (c: Ast): void => {
    if (c.k === "bin" && c.op === "or") {
      split(c.a);
      split(c.b);
    } else branches.push(c);
  };
  split(withAns.b);
  if (branches.length < 2) return null;
  const list = withAns.a.f === "zeros" || withAns.a.f === "cZeros";
  // A decimal in either side makes the whole answer decimal, as the entry would be.
  const decimal = /\d\.|\.\d/.test(print(withAns.b));
  const each = decimal ? { ...opts, approx: true } : opts;
  const found: Ast[] = [];
  for (const b of branches) {
    const r = await evaluateParsed(input, { ...withAns, b }, giac, each);
    if (!r.ok) return r;
    const leaves: Ast[] = [];
    const walk = (x: Ast): void => {
      if (x.k === "bin" && x.op === "or") {
        walk(x.a);
        walk(x.b);
      } else if (x.k === "list") leaves.push(...x.items);
      else if (!(x.k === "sym" && x.name === "false")) leaves.push(x);
    };
    walk(r.output);
    for (const l of leaves) if (!found.some((f) => print(f) === print(l))) found.push(l);
  }
  const key = (x: Ast) => numericValue(x.k === "bin" && x.op === "=" ? x.b : x);
  // Some branches come back exact even so (x=−1 beside x=1.).
  if (decimal)
    for (const [i, x] of found.entries()) {
      const v = key(x);
      if (!Number.isFinite(v)) continue;
      const n = shownDecimal(v, opts.settings.digits);
      found[i] = x.k === "bin" && x.op === "=" ? { ...x, b: n } : n;
    }
  if (found.every((x) => Number.isFinite(key(x)))) found.sort((p, q) => key(p) - key(q));
  const output: Ast = list
    ? { k: "list", items: found }
    : found.length
      ? found.reduce((acc, x) => ({ k: "bin", op: "or", a: acc, b: x }))
      : sym("false");
  return { ok: true, input, output, outputText: print(output) };
}

/** evaluate() from the parsed input on (withAns: Ans already put in). */
async function evaluateParsed(
  input: Ast,
  withAns: Ast,
  giac: Giac,
  opts: { settings: Settings; ans?: Ast; approx?: boolean; values?: boolean },
): Promise<EvalResult> {
  if (await emptyDomain(withAns, giac, opts.settings)) return { ok: false, input, error: "Error: Invalid constraint" };
  // solve, zeros, polyRoots, nSolve and fMin/fMax are real commands: they
  // run in Giac's real mode whatever the Complex Format, as on the handheld
  // (and Giac's complex mode aborted on solve(|x−2|+3=−3,x)).
  const top = withAns.k === "bin" && withAns.op === "|" ? withAns.a : withAns;
  const real = opts.settings.complex !== "real" && top.k === "call" && REAL_COMMANDS.has(top.f);
  if (real) {
    await giac("complex_mode:=0");
    try {
      return await evaluateParsed(input, withAns, giac, { ...opts, settings: { ...opts.settings, complex: "real" } });
    } finally {
      await giac("complex_mode:=1");
    }
  }
  // factor works over the reals in every Complex Format: factor(x²+1) stays x²+1 in
  // Rectangular and Polar, and only cFactor brings in i. Giac's factor splits over ℂ
  // under complex_mode 1, so it runs under 0. The settings stay complex, so an answer
  // with i in it (a polynomial with complex coefficients) is still printed.
  if (opts.settings.complex !== "real" && top.k === "call" && top.f === "factor") {
    await giac("complex_mode:=0");
    try {
      return await evaluateCore(input, withAns, giac, opts);
    } finally {
      await giac("complex_mode:=1");
    }
  }
  // An inequality over a polynomial Giac's exact solver aborts on goes straight to the sign method.
  const risky = await riskyInequality(withAns, giac, opts.settings);
  let r = risky ? null : await evaluateCore(input, withAns, giac, opts);
  // A system Giac gives up on (y=ℯ^x and y=2x+5): eliminate one variable and solve the other.
  if (r && ((r.ok && r.outputText === "false") || !r.ok)) {
    const alt = await systemBySubstitution(withAns, giac, opts);
    if (alt) r = { ...alt, input };
  }
  // A system no exact method can do (n^x=x^n and …): solved numerically, as the handheld falls back to.
  if (r && !r.ok && withAns.k === "call" && withAns.f === "solve" && withAns.args[0]?.k === "bin" && withAns.args[0].op === "and" && withAns.args[1]?.k === "list") {
    const n = await nSolveForms({ ...withAns, f: "nSolve" }, giac, opts.settings);
    if (n?.ok && n.output.k !== "str") r = { ...n, input };
  }
  // An inequality Giac can't solve (a cubic without nice roots, a removable hole) is solved by
  // signs, and so is one where Giac's answer disagrees with the inequality when sampled.
  const isInequality = (() => {
    const call = withAns.k === "bin" && withAns.op === "|" ? withAns.a : withAns;
    if (!(call.k === "call" && call.f === "solve" && call.args[0])) return false;
    let found = false;
    mapAst(call.args[0], (y) => {
      if (y.k === "bin" && y.op in INEQ) found = true;
      return y;
    });
    return found;
  })();
  if (isInequality && r?.ok) {
    const call = withAns.k === "bin" && withAns.op === "|" ? withAns.a : withAns;
    const compound = call.k === "call" && call.args[0]?.k === "bin" && call.args[0].op === "and";
    // Compound inequalities, and a flat true or false, are worked by signs from the roots:
    // sampling can step over a narrow interval (x³+4x≥2 and x³+4x<4 is 0.47…≤x<0.79…).
    // So is one with a | domain: Giac's own answer can run past it (x>−0.567 for −6≤x≤3).
    const domain = withAns.k === "bin" && withAns.op === "|";
    if (compound || domain || r.outputText === "true" || r.outputText === "false") {
      const alt = await inequalityBySigns(withAns, giac, opts.settings);
      if (alt) return { ok: true, input, output: alt, outputText: print(alt) };
    } else if (!(await inequalityAgrees(withAns, r.output, giac, opts.settings))) r = null;
    else {
      const output = await boundaryEnds(withAns, r.output, giac, opts.settings);
      if (output !== r.output) r = { ...r, output, outputText: print(output) };
    }
  }
  if (!r || !r.ok || /rootof/.test(r.outputText)) {
    const alt = await inequalityBySigns(withAns, giac, opts.settings);
    if (alt) return { ok: true, input, output: alt, outputText: print(alt) };
  }
  return r ?? { ok: false, input, error: "Error: Invalid input" };
}

async function evaluateCore(
  input: Ast,
  withAns: Ast,
  giac: Giac,
  opts: { settings: Settings; ans?: Ast; approx?: boolean; seen?: Set<string>; values?: boolean },
): Promise<EvalResult> {
  await giac(EPSILON);
  withAns = await listCalls(withAns, giac);
  const median = await piecewiseBoundSolve(withAns, giac, opts.settings);
  if (median) return { ...median, input };
  // solve(h(x)=x,x)|k=2: the equation is worked out with k=2 first (h's body included), then solved.
  const pushed = await substituteFirst(withAns, giac, opts);
  if (pushed) return evaluateParsed(input, pushed, giac, opts);
  const loose = await parameterBounds(withAns, giac, opts);
  if (loose) return loose.ok ? { ...loose, input } : loose;
  const direct = await polyRootsNumeric(withAns, giac, opts.settings);
  if (direct) return { ...direct, input };
  const divergent = await divergentIntegral(withAns, giac, opts.settings);
  if (divergent) return { ...divergent, input };
  const risky = await riskyIntegral(withAns, giac, opts.settings);
  if (risky) return { ...risky, input };
  const integrand = withAns.k === "bin" && withAns.op === "|" && withAns.a.k === "call" && (withAns.a.f === "∫" || withAns.a.f === "integral") ? withAns.a.args[0] : undefined;
  const first = integrand && boundsFirst(withAns, (await giac(toGiac(integrand, opts.settings))).includes("piecewise"));
  if (first) return evaluateParsed(input, first, giac, opts);
  const pieces = await piecewiseIntegral(withAns, giac, opts.settings);
  if (pieces) return { ...pieces, input };
  const inert = await nonElementaryIntegral(withAns, giac, opts.settings);
  if (inert) return { ...inert, input };
  const within = await inertInside(withAns, giac, opts);
  if (within) return { ...within, input };
  const kink = await breakDerivative(withAns, giac, opts.settings);
  if (kink) return { ...kink, input };
  const ftc = await leibniz(withAns, giac, opts.settings);
  if (ftc) return evaluateParsed(input, ftc, giac, opts);
  const safe = await numericRoots(withAns, giac, opts.settings);
  if (safe !== withAns) return evaluateParsed(input, safe, giac, opts);
  const split = await perAnswer(withAns, giac, opts);
  if (split) return split.ok ? { ...split, input } : split;
  if (withAns.k === "call" && withAns.f === "euler") return eulerMethod(input, withAns, giac, opts.settings);
  if (withAns.k === "call" && withAns.f === "nSolve") {
    const n = await nSolveForms(withAns, giac, opts.settings);
    if (n) return { ...n, input };
  }
  // nSolve(…)→r stores the answer shown (one number), not Giac's list of roots.
  if (withAns.k === "bin" && withAns.op === "→" && withAns.b.k === "sym" && withAns.a.k === "call" && SHOWN_STORE.has(withAns.a.f)) {
    const r = await evaluate(print(withAns.a), giac, opts);
    if (!r.ok) return { ...r, input };
    const name = RENAME_IN[withAns.b.name] ?? withAns.b.name;
    const value = r.output.k === "str" ? `"${r.output.v}"` : translate(r.output, opts.settings).giac;
    const definition = `${name}:=${value}`;
    await giac(definition);
    return { ok: true, input, output: r.output, outputText: r.outputText, definition };
  }
  // cSolve of |z−a|=|z−b|, z·conj(z)=4 …: Giac returns one point of a line or circle, which reads
  // as the whole answer. With abs, conj, real, imag or angle of the unknown it says so instead.
  if (nonAnalytic(withAns)) return { ok: false, input, error: "Error: Not available here yet" };
  if (overDetermined(withAns)) return { ok: false, input, error: "Error: Argument error" };
  const extremum = await globalExtremum(withAns, giac, opts.settings);
  if (extremum) return { ok: true, input, output: extremum, outputText: print(extremum) };
  if (input.k === "call" && input.f === "completeSquare") {
    const sq = await completeSquares(input, giac, opts.settings);
    if (sq) return { ok: true, input, output: sq, outputText: print(sq) };
  }
  if (input.k === "call" && (input.f === "tangentLine" || input.f === "normalLine")) {
    const steep = await steepLine(input, giac, opts.settings);
    if (steep) return { ok: true, input, output: steep, outputText: print(steep) };
  }
  // Purges for assumptions a "|" makes, run however the entry ends.
  let cleanup: string[] = [];
  try {
    const containers = await containerVars(withAns, giac);
    const misuse = functionNameMisuse(withAns, containers.functions);
    if (misuse) return { ok: false, input, error: misuse };
    const tr = translate(withAns, { ...opts.settings, ...containers });
    cleanup = tr.cleanup ?? [];
    const approx = opts.approx || opts.settings.mode === "approx";
    let cmd = approx && tr.hint !== "define" && tr.hint !== "store" ? `evalf(${tr.giac})` : tr.giac;
    // A recursive function's helper, stored (and replayed) before the function itself.
    let helper: string | undefined;
    const recursive = tr.hint === "define" ? recursiveDefinition(withAns, opts.settings) : null;
    if (recursive) {
      helper = recursive.helper;
      await giac(helper);
      cmd = recursive.main;
    }
    const integral = tr.hint === "define" && !recursive ? await definedIntegral(withAns, giac, opts.settings) : null;
    if (integral) cmd = integral;
    // A definition's right side is worked out first, its names held as placeholders, then stored.
    if (tr.hint === "define" && !recursive && !integral) {
      // Not a body that takes a whole list: mean(l) worked out for a symbol l is l itself.
      // Nor one with an = or ≠ test (when(n=0,…)): Giac decides x_p_=0 as false for a
      // placeholder, so the test has to wait for the argument. The same goes for a body
      // that calls a function with such a test, or a recursive one.
      const parts =
        WHOLE_LIST_IN.test(print(withAns)) || hasEqualityTest(withAns) || (await callsUnheldTest(withAns, giac)) ? null : defineParts(withAns, { ...opts.settings });
      if (parts) {
        // Only a trailing decimal echo (=2.0) goes: the = of a ≥ in piecewise(x≥0,0.5*x,0) stays.
        const worked = (await giac(parts.body)).trim().replace(/(?<![<>!=])=\s*[-+]?\d*\.\d*(?:e[-+]?\d+)?\s*$/i, "");
        if (!/error|undef|^"/i.test(worked)) {
          // Parameters stay held (x_p_); other names go back to theirs.
          const back = worked.replace(/\b([A-Za-z]\w*_q_)\b/g, (m) => parts.names[m] ?? m);
          cmd = `${parts.head}:=${back}`;
        }
      }
    }
    let raw = await giac(cmd);
    if (tr.readBack && !/error/i.test(raw)) raw = await giac(tr.readBack);
    await giac(EPSILON);
    if (tr.fallback && /undef/.test(raw)) raw = await giac(tr.fallback);
    if (/\bexpand\(/.test(cmd)) raw = await negatedPowers(raw, giac);
    // A simplifying wrapper (regroup, normal) has to keep the value: Giac's normal
    // has flipped the sign of complex constants with nested radicals.
    if (tr.unwrapped && !/error/i.test(raw)) {
      const plain = await giac(approx ? `evalf(${tr.unwrapped})` : tr.unwrapped);
      if (!/error/i.test(plain) && !(await same(giac, raw, plain))) raw = plain;
    }
    // Roots Giac can only write as rootof(…) (a cubic without nice roots): decimals, as the handheld gives.
    if (/rootof/.test(raw)) raw = await giac(`evalf(${cmd})`);
    let hint = tr.hint;
    // deSolve where Giac's answer fails a separable equation: none, a constant
    // that can't take every value, or an integer constant left by the condition.
    // And y′=p(x)·yⁿ with n>2, which the handheld separates although Giac can solve it.
    const power = hint === "desolve" ? await separable(withAns, giac, opts.settings, approx, true) : null;
    if (power) raw = power;
    else if (hint === "desolve" && (raw.trim() === "[]" || /\bexp\(c_\d+\)|\bn_\d/.test(raw))) {
      raw = (await separable(withAns, giac, opts.settings, approx)) ?? raw;
      // Not separable: every branch meets the condition, and the principal one (n=0) is taken.
      const ns = [...new Set(raw.match(/\bn_\d+\b/g) ?? [])];
      if (ns.length) raw = await giac(`subst(${raw},[${ns.join(",")}],[${ns.map(() => 0).join(",")}])`);
    }
    // nSolve(eq,x,lo,hi): when Giac's bisection finds nothing (a root by the
    // edge of the function's domain), the range is sampled and refined.
    if (hint === "nsolve" && !/\d/.test(raw)) raw = (await nSolveRange(withAns, giac, opts.settings)) ?? raw;
    // Giac's numeric solver can stop at the edge of the domain (x=−3 for −4√(x+3)−1=2):
    // a root that doesn't satisfy the equation is dropped.
    if (hint === "nsolve") raw = await realRootsOnly(withAns, raw, giac, opts.settings);
    // Decimal roots from Giac's numeric polynomial solver can be inaccurate or
    // not roots at all: each is polished by Newton's method from where it is
    // and kept only if it satisfies the equation.
    if (hint === "solve" && tr.vars?.length === 1 && /\d\.\d/.test(raw)) raw = await polishRoots(withAns, raw, giac, opts.settings);
    // ln(0) and log(0) are undef on the handheld, not −∞.
    if (withAns.k === "call" && (withAns.f === "ln" || withAns.f === "log") && raw.trim() === "-infinity") raw = "undef";
    // A relation with nothing left to vary is true or false: x=2|x=2 is true.
    if (hint === "bool") raw = await decide(raw, giac);
    // Substituted values simplified when that's shorter: √3³−2√3+7 is √3+7, (a+1)² stays.
    if (tr.substituted && !/error/i.test(raw) && !heavy(cmd + raw)) {
      const n = await giac(`normal(${cmd})`);
      const bare = (t: string) => t.replace(/=[^=]*\d\.\d*[^=]*$/, "").length;
      if (!/error/i.test(n) && bare(n) < bare(raw) && (await same(giac, raw, n))) raw = n;
    }
    // An exact constant is simplified and rationalised, as the handheld always does: 1/√2 is √2/2.
    // Logs of numbers are collected: ln(2)+ln(3) is ln(6).
    if (hint === "plain" && !tr.decimal && !tr.keepForm && isExactConstant(raw) && !heavy(raw)) {
      const bareRaw = raw.replace(/=[^=]*\d\.\d*[^=]*$/, "");
      const logs = (bareRaw.match(/\bln\(/g) ?? []).length > 1 ? `lncollect(${bareRaw})` : bareRaw;
      // A complex constant: each part on its own (normal of the whole has flipped signs).
      const n = /\bi\b/.test(bareRaw)
        ? await giac(`normal(re(${bareRaw}))+normal(im(${bareRaw}))*i`)
        : await giac(`normal(regroup(${logs}))`);
      const bare = (t: string) => t.replace(/=[^=]*\d\.\d*[^=]*$/, "").length;
      if (!/error|undef/i.test(n) && bare(n) <= bare(raw) && (await same(giac, raw, n))) raw = n;
    }
    // A principal root of a negative number in Rectangular: Giac leaves x^(1/3)|x=−8 as
    // (1/2+√3/2·i)·8^(1/3); simplify gives 1+√3·i, as the handheld shows it (then a+b·i, part by part).
    if (hint === "plain" && !tr.decimal && opts.settings.complex !== "real" && /\bi\b/.test(raw) && isExactConstant(raw) && heavy(raw) && raw.length < 200) {
      const bare = (t: string) => t.replace(/=[^=]*\d\.\d*[^=]*$/, "");
      const bareRaw = bare(raw);
      const z = bare(await giac(`simplify(${bareRaw})`));
      const n = /error|undef/i.test(z) || heavy(z) ? z : bare(await giac(`normal(re(${z}))+normal(im(${z}))*i`));
      if (!/error|undef/i.test(n) && n.length < bareRaw.length && (await same(giac, bareRaw, n))) raw = n;
    }
    const top0 = core(withAns);
    // abs() of typed arithmetic is collected inside, as the handheld does: |x−2x| is |x|,
    // and each element of a vector's (|10t+10t−100| is |20t−100|).
    if (hint === "plain" && top0.k === "call" && top0.f === "abs" && /\babs\(/.test(raw) && !/error/i.test(raw) && !heavy(raw)) {
      const n = await giac(`regroup(${raw.replace(/=[^=]*\d\.\d*[^=]*$/, "")})`);
      if (!/error|undef/i.test(n) && n.length <= raw.length && (await same(giac, raw, n))) raw = n;
    }
    // A user's function of an expression is multiplied out when that's shorter: f(a+1) is a³−3a²+5.
    if (hint === "plain" && core(withAns).k === "call" && !BUILTINS.has((core(withAns) as { f: string }).f) && !/error/i.test(raw) && !heavy(raw)) {
      const n = await giac(`normal(${raw.replace(/=[^=]*\d\.\d*[^=]*$/, "")})`);
      if (!/error/i.test(n) && n.length < raw.length && (await same(giac, raw, n))) raw = n;
    }
    // A derivative with a variable power is simplified and factored: (ln(x)+1)·x^x.
    if (hint === "plain" && top0.k === "call" && top0.f === "d" && /\^\([^()]*[a-z]/.test(raw)) {
      const n = await giac(`factor(simplify(${raw}))`);
      if (!/error/i.test(n) && n.length < raw.length && (await same(giac, raw, n))) raw = n;
    }
    // A derivative that is one fraction is collected over the original factors, as the handheld
    // writes the quotient rule's answer: d((5x+1)/(5x−1),x) is −10/(5x−1)², not
    // (5(5x−1)−5(5x+1))/(5x−1)². Giac's factor() keeps the denominator's factors
    // (normal() would multiply them out); a sum of terms is left alone.
    if (hint === "plain" && top0.k === "call" && top0.f === "d" && !topLevelSum(raw) && /\/\(/.test(raw) && !heavy(raw)) {
      const n = await giac(`factor(${raw})`);
      if (!/error/i.test(n) && n.length < raw.length && (await same(giac, raw, n))) raw = n;
    }
    // A derivative with a common exponential factor beside trig is factored: (2·cos(x)−sin(x))·ℯ^(2x).
    if (hint === "plain" && core(withAns).k === "call" && (core(withAns) as { f: string }).f === "d" && /exp\(/.test(raw)) {
      const n = await giac(`factor(${raw})`);
      // Only with a function beside the exponential: x²·ℯ^x+2x·ℯ^x stays as it is.
      const cofactor = n.replace(/\*?exp\([^()]*(\([^()]*\))*[^()]*\)\*?/, "");
      if (!/error/i.test(n) && /\b(sin|cos|tan|ln)\(/.test(cofactor) && /exp\(/.test(n) && n.length <= raw.length && (await same(giac, raw, n))) raw = n;
    }
    // Trig with arguments a period apart collapses: f(t+12)−f(t) is 360, not a page of cosines.
    // (Not on an unevaluated integral, sum or limit: simplify(integrate(|…|)) doesn't come back.)
    const unevaluated = /\b(integrate|sum|limit|product|diff)\(/.test(raw);
    if (hint === "plain" && !tr.keepForm && !unevaluated && /\b(sin|cos|tan)\(/.test(raw) && raw.length > 60 && !heavy(raw)) {
      const n = await giac(`simplify(${raw.replace(/=[^=]*\d\.\d*[^=]*$/, "")})`);
      if (!/error/i.test(n) && n.length < raw.length * 0.7 && (await same(giac, raw, n))) raw = n;
    }
    // sin(t)²+cos(t)² is 1, as the handheld simplifies it.
    if (hint === "plain" && !tr.keepForm && !unevaluated && /\bsin\(([^()]*)\)\^2/.test(raw) && /\bcos\(([^()]*)\)\^2/.test(raw) && !heavy(raw)) {
      const n = await giac(`simplify(${raw.replace(/=[^=]*\d\.\d*[^=]*$/, "")})`);
      if (!/error/i.test(n) && n.length < raw.length && (await same(giac, raw, n))) raw = n;
    }
    // angle() is in (−π, π]: a negative real computed as −64+0·i is π, not −π.
    if (top0Name(withAns) === "angle") {
      const v = Number((await giac(`evalf(${raw.replace(/=[^=]*\d\.\d*[^=]*$/, "")})`)).trim());
      if (Math.abs(v + Math.PI) < 1e-10) raw = /\d\./.test(raw.replace(/=.*$/, "")) ? "3.14159265359" : "pi";
    }
    // A definite integral Giac answers with erf, Si, Ci or Ei: the handheld gives a decimal.
    if (/\b(erf|Si|Ci|Ei)\(/.test(raw)) {
      const approxRaw = await giac(`evalf(${raw})`);
      if (!/[a-z]/i.test(approxRaw.replace(/\be\b|E/g, ""))) raw = approxRaw;
    }
    if (tr.alt && tr.alt.when.test(raw)) [raw, hint] = [await giac(tr.alt.giac), tr.alt.hint];
    // The handheld has no LambertW: it answers those numerically.
    if (/LambertW/.test(raw)) raw = await giac(`evalf(${raw})`);
    // General solutions come back as −1/4·(−4·n1·π−π); the handheld writes n1·π+π/4.
    if (tr.hint === "solve" && /\bn_\d/.test(raw)) raw = await giac(`expand(${cmd})`);
    if (tr.rect && /\bi\b/.test(raw)) {
      const call = core(withAns);
      const eq = call.k === "call" ? call.args[0] : undefined;
      const v = tr.vars?.length === 1 ? tr.vars[0] : undefined;
      const p = eq && (eq.k === "bin" && eq.op === "=" ? `(${toGiac(eq.a, opts.settings)})-(${toGiac(eq.b, opts.settings)})` : toGiac(eq, opts.settings));
      raw = await rectangular(cmd, giac, raw, p && v ? { p, v } : undefined);
    }
    // An integral Giac can't do in closed form: the handheld gives a decimal.
    if (/\bintegrate\(/.test(raw)) {
      const approxRaw = await giac(`evalf(${raw})`);
      if (!/\bintegrate\(/.test(approxRaw)) raw = approxRaw;
    }
    // The problem's running constant counts live in Giac, so Clear a–z keeps them.
    const counters = /\b[cn]_\d|\bsolve\(/.test(raw + cmd) ? await readCounters(giac) : undefined;
    const before = counters && { ...counters };
    const top = core(withAns);
    let output = format(raw, {
      realSolutions: top.k === "call" && ["solve", "zeros", "polyRoots"].includes(top.f),
      combine: top.k === "call" && top.f === "tCollect",
      counters,
      hint,
      vars: tr.vars,
      digits: opts.settings.digits,
      listify: tr.listify,
      decimal: opts.settings.mode === "exact" ? false : tr.decimal,
      realOnly: opts.settings.complex === "real" && !tr.complex,
      angle: opts.settings.angle,
    });
    // log(10,3)−log(5,3) collects to ln(2)/ln(3), which the handheld writes log(2,3).
    const bases = logBases(withAns);
    if (bases) output = mapAst(output, (x) => logBase(x, bases));
    if (counters && before && (counters.c !== before.c || counters.n !== before.n))
      await giac(`cas_cnt_:=[${counters.c},${counters.n}]`);
    // Real solutions only, each once, none from general solutions that are never real,
    // and a numeric search of a bounded domain when Giac gives up there.
    if ((hint === "solve" || hint === "zeros") && tr.vars?.length !== 0 && top.k === "call" && ["solve", "zeros"].includes(top.f))
      output = await cleanSolutions(output, withAns, giac, opts.settings);
    if (hint === "solve" && tr.vars?.length === 1) output = await rootsPastPoles(output, withAns, giac, opts.settings);
    // A system's solutions outside its | conditions go (b=0, r=3.9E−12 for 0<r<5π/2).
    if (hint === "solve" && (tr.vars?.length ?? 0) > 1 && withAns.k === "bin" && withAns.op === "|") output = await systemInDomain(output, withAns.b, giac, opts.settings);
    // solve(…)|domain: a decimal answer Giac's assumption didn't filter (a
    // LambertW root made decimal afterwards) is checked against the domain.
    if (hint === "solve" && withAns.k === "bin" && withAns.op === "|" && tr.vars?.length === 1) output = await inDomain(output, withAns.b, tr.vars[0]!, giac, opts.settings);
    if (!opts.values && hint === "solve" && tr.vars?.length === 1 && withAns.k === "call" && withAns.f === "solve") output = await isolationConditions(output, withAns, giac, opts.settings);
    const definition = tr.hint === "define" || tr.hint === "store" || tr.hint === "delvar" ? cmd : undefined;
    const extra = [
      ...(helper ? [helper] : []),
      ...(await markRow(withAns, output, tr, containers.flagged, giac)),
      ...(await lateBinding(withAns, tr.hint, giac, opts)),
    ];
    return { ok: true, input, output, outputText: print(output), definition, ...(extra.length ? { definitions: extra } : {}) };
  } catch (e) {
    if (e instanceof EngineError) return { ok: false, input, error: e.message };
    if (e instanceof UnsupportedError) return { ok: false, input, error: "Error: Not available here yet" };
    return { ok: false, input, error: "Error: Invalid input" };
  } finally {
    for (const c of cleanup) await giac(c).catch(() => "");
  }
}

/**
 * cSolve and cZeros roots as a+b·i, in the handheld's order. A quadratic keeps
 * the quadratic formula's order with the principal square root, (−b+√D)/(2a)
 * first: z²=5+12i is 3+2i then −3−2i, z²−2z+5 is 1+2i then 1−2i. Otherwise
 * the roots with a real part come first, ascending, each pair with +i before
 * −i; then the purely imaginary ones, +i first; then the real roots ascending
 * ({2+i,2−i,3i,−3i}, i,−i,−1 for x³+x²+x+1). Binomials zⁿ=w with |w|≠1 follow
 * neither rule on the handheld (z³=8 has −1−√3i first) and are left sorted.
 * Each part is written in simplest radical form, as the handheld writes it:
 * 16^(1/4) is 2, e^(ln(81)/4) is 3, 2√3/2 is √3.
 */
async function rectangular(cmd: string, giac: Giac, raw: string, poly?: { p: string; v: string }): Promise<string> {
  const parts = await giac(`map(${cmd},s_->[re(s_),im(s_),evalf(re(s_)),evalf(im(s_))])`);
  const rows = splitTop(parts.replace(/^\[|\]$/g, "")).map((r) => splitTop(r.replace(/^\[|\]$/g, "")));
  if (!rows.length || rows.some((r) => r.length !== 4)) return raw;
  const keyed = rows.map(([re, im, reN, imN]) => ({ re: re!, im: im!, reN: Number(reN), imN: Number(imN) }));
  if (keyed.some((k) => Number.isNaN(k.reN) || Number.isNaN(k.imN))) return raw;
  for (const k of keyed) [k.re, k.im] = [await simplestRadical(k.re, giac), await simplestRadical(k.im, giac)];
  const text = (k: (typeof keyed)[number]) =>
    Math.abs(k.imN) <= 1e-12 ? k.re : k.re === "0" ? `(${k.im})*i` : `${k.re}+(${k.im})*i`;
  const lead = poly && keyed.length === 2 ? await quadraticLead(poly, giac) : undefined;
  if (lead) {
    // a·(r1−r2) is ±√D; r1 comes first when it is the principal root (re>0, or re=0 and im>0).
    const [p, q] = keyed as [(typeof keyed)[number], (typeof keyed)[number]];
    const dRe = p.reN - q.reN;
    const dIm = p.imN - q.imN;
    const wRe = lead.re * dRe - lead.im * dIm;
    const wIm = lead.re * dIm + lead.im * dRe;
    const tol = 1e-9 * (Math.abs(wRe) + Math.abs(wIm));
    const principal = wRe > tol || (Math.abs(wRe) <= tol && wIm > 0);
    return `list[${(principal ? [p, q] : [q, p]).map(text).join(",")}]`;
  }
  const isReal = (k: (typeof keyed)[number]) => Math.abs(k.imN) <= 1e-12;
  const isImaginary = (k: (typeof keyed)[number]) => !isReal(k) && Math.abs(k.reN) <= 1e-12 * Math.max(1, Math.abs(k.imN));
  const complex = keyed.filter((k) => !isReal(k) && !isImaginary(k)).sort((p, q) => p.reN - q.reN || q.imN - p.imN);
  const imaginary = keyed.filter(isImaginary).sort((p, q) => q.imN - p.imN);
  const real = keyed.filter(isReal).sort((p, q) => p.reN - q.reN);
  return `list[${[...complex, ...imaginary, ...real].map(text).join(",")}]`;
}

/** The leading coefficient of a quadratic polynomial in v, numerically; undefined when p is not one. */
async function quadraticLead(poly: { p: string; v: string }, giac: Giac): Promise<{ re: number; im: number } | undefined> {
  const { p, v } = poly;
  const r = await giac(`(P_->when(is_polynomial(P_,${v}) and degree(P_,${v})==2,[evalf(re(lcoeff(P_,${v}))),evalf(im(lcoeff(P_,${v})))],[]))(expand(${p}))`);
  const m = /^\[([^,\]]+),([^,\]]+)\]$/.exec(r.trim());
  if (!m) return undefined;
  const [re, im] = [Number(m[1]), Number(m[2])];
  return Number.isFinite(re) && Number.isFinite(im) && (re !== 0 || im !== 0) ? { re, im } : undefined;
}

/**
 * A numeric part of a complex root in simplest radical form. Giac writes the
 * modulus of a root of zⁿ=w as e^(ln|w|/n) or |w|^(1/n) and leaves 2·√3/2
 * unreduced. Powers become radicals, a perfect power comes out of each
 * integer radical (16^(1/4) → 2, 81^(1/4) → 3, 64^(1/6) → 2) and the
 * coefficients are reduced.
 */
async function simplestRadical(part: string, giac: Giac): Promise<string> {
  // A constant result comes back from Giac with its decimal value after an =.
  const exact = async (c: string) => (await giac(c)).trim().replace(/=[-+]?[\d.]+(?:e[-+]?\d+)?$/i, "");
  const usable = (t: string) => t !== "" && !/error|undef|\b(exp|ln)\(/i.test(t);
  const hadExp = /\b(exp|ln)\(/.test(part);
  let q = hadExp ? await exact(`exp2pow(${part})`) : part;
  q = q.replace(/\b(\d+)\^\((\d+)\/(\d+)\)/g, (m, n: string, a: string, b: string) => takeOutPower(Number(n), Number(a), Number(b)) ?? m);
  if (q === part) {
    // Only an unreduced coefficient (2*sqrt(3)/2, or 2*(sqrt(5)-1)/4 for z⁵=−32): normalised
    // when that is shorter.
    if (!/\d\*.*\/\d/.test(part)) return part;
    const n = await exact(`ratnormal(${part})`);
    return usable(n) && n.length < part.length ? n : part;
  }
  // ratnormal treats each radical as a symbol, so it reduces coefficients without
  // merging √s into one; normal() can fold 3·√(2+√2)/2 into √((9√2+18)/4), and
  // which it does depends on what Giac has seen before. Kept unless it multiplies
  // the terms out into something longer.
  const n = await exact(`ratnormal(${q})`);
  if (usable(n) && (!usable(q) || n.length <= q.length)) return n;
  return usable(q) ? q : part;
}

/** n^(a/b) with the largest perfect b-th power taken out: 16^(1/4) is 2, 24^(1/3) is 2·3^(1/3). */
function takeOutPower(n: number, a: number, b: number): string | undefined {
  if (!Number.isSafeInteger(n) || n < 2 || n > 1e12 || b < 2) return undefined;
  let out = 1;
  let rest = n;
  for (let p = 2; p * p <= rest; p++) {
    let e = 0;
    while (rest % p === 0) {
      rest /= p;
      e++;
    }
    out *= p ** Math.floor(e / b);
  }
  const outer = out ** a;
  if (out === 1 || !Number.isSafeInteger(outer)) return undefined;
  const inside = n / out ** b;
  return inside === 1 ? `${outer}` : `(${outer}*${inside}^(${a}/${b}))`;
}

/** Split Giac text at its top-level commas. */
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === "," && depth === 0) {
      out.push(s.slice(start, i).trim());
      start = i + 1;
    }
  }
  if (s.trim()) out.push(s.slice(start).trim());
  return out;
}

/**
 * OneVar, TwoVar and the regressions. Lists can be typed ({1,2,3}) or named;
 * Giac evaluates them to numbers and stats.ts does the rest. The answer is
 * the handheld's two-column table of results. A regression's fourth
 * argument (f1 …) saves its equation as that function.
 */
async function statistics(input: Extract<Ast, { k: "call" }>, giac: Giac, settings: Settings): Promise<EvalResult> {
  const values = async (a: Ast | undefined): Promise<number[] | number | undefined> => {
    if (!a) return undefined;
    const raw = (await giac(`evalf(${translate(a, settings).giac})`)).trim();
    const list = raw.startsWith("[") || raw.startsWith("list[");
    const inner = raw.replace(/^(list)?\[|\]$/g, "").trim();
    // {} is an empty list, not a list holding 0.
    if (list && !inner) return [];
    const nums = inner.split(",").map((t) => Number(t.trim()));
    if (nums.some((v) => !Number.isFinite(v))) throw new EngineError("Error: Wrong kind of input");
    return list ? nums : nums[0];
  };
  const asList = (v: number[] | number | undefined) => {
    if (!Array.isArray(v)) throw new EngineError("Error: Wrong kind of input");
    return v;
  };
  try {
    const [a0, a1, a2, a3, a4] = input.args;
    let result: StatResult;
    /**
     * Category and Include, after the frequencies, are lists of category codes:
     * only the data whose code is in Include count, as if the others had
     * frequency 0. Anything but a list there is an error, as on the
     * handheld: LinRegMx xs,ys,1,f1 on the handheld (the
     * regression wizard saves RegEqn with CopyVar, not with a 4th argument).
     * A Category with no Include after it is ignored, as it was before.
     */
    const included = async (xs: number[], freq: number[] | number, category?: Ast, include?: Ast) => {
      const codes = async (a: Ast) => {
        const v = await values(a).catch(() => undefined);
        if (!Array.isArray(v)) throw new EngineError("Error: Expected a list");
        return v;
      };
      const cat = category && (await codes(category));
      const inc = include && (await codes(include));
      if (!cat || !inc) return freq;
      if (cat.length !== xs.length) throw new EngineError("Error: Sizes do not match");
      return frequencies(xs, freq).map((w, i) => (inc.includes(cat[i]!) ? w : 0));
    };
    // From a list: its mean, size and sample sd, weighted by an optional frequency list.
    const fromData = (xs: number[], f: number[] | number | undefined) => {
      const w = frequencies(xs, f ?? 1);
      const n = w.reduce((s, v) => s + v, 0);
      const mean = xs.reduce((s, x, i) => s + x * w[i]!, 0) / n;
      const sx = Math.sqrt(xs.reduce((s, x, i) => s + w[i]! * (x - mean) ** 2, 0) / (n - 1));
      return { mean, n, sx };
    };
    const zq = async (p: number) => Number((await giac(`evalf(normal_icdf(0,1,${p}))`)).trim());
    if (input.f === "zInterval") {
      // zInterval σ,x̄,n[,CLevel] or zInterval σ,List[,Freq[,CLevel]]
      const sigma = await values(a0);
      const second = await values(a1);
      if (typeof sigma !== "number") throw new EngineError("Error: Wrong kind of input");
      if (Array.isArray(second)) {
        const freq = await values(a2);
        const level = (await values(a3)) ?? 0.95;
        if (typeof level !== "number") throw new EngineError("Error: Wrong kind of input");
        const d = fromData(second, freq);
        result = meanInterval(sigma, d.mean, d.n, level, await zq((1 + level) / 2), d.sx);
      } else {
        const [n, level] = [await values(a2), (await values(a3)) ?? 0.95];
        if (typeof second !== "number" || typeof n !== "number" || typeof level !== "number") throw new EngineError("Error: Wrong kind of input");
        result = meanInterval(sigma, second, n, level, await zq((1 + level) / 2));
      }
    } else if (input.f === "zTest") {
      // zTest μ0,σ,x̄,n[,Hypoth] or zTest μ0,σ,List[,Freq[,Hypoth]]
      const [mu0, sigma, third] = [await values(a0), await values(a1), await values(a2)];
      if (typeof mu0 !== "number" || typeof sigma !== "number") throw new EngineError("Error: Wrong kind of input");
      // The standard normal cdf at each z the test needs, from Giac.
      const cdfAt = async (z: number) => Number((await giac(`evalf(normal_cdf(0,1,-inf,${z}))`)).trim());
      const run = async (mean: number, n: number, hyp: number, sx?: number) => {
        const z = zStatistic(mu0, sigma, mean, n);
        return meanTest(mu0, sigma, mean, n, hyp, { atZ: await cdfAt(z), atAbsZ: await cdfAt(Math.abs(z)) }, sx);
      };
      if (Array.isArray(third)) {
        const freq = await values(a3);
        const hyp = (await values(a4)) ?? 0;
        if (typeof hyp !== "number") throw new EngineError("Error: Wrong kind of input");
        const d = fromData(third, freq);
        result = await run(d.mean, d.n, hyp, d.sx);
      } else {
        const [n, hyp] = [await values(a3), (await values(a4)) ?? 0];
        if (typeof third !== "number" || typeof n !== "number" || typeof hyp !== "number") throw new EngineError("Error: Wrong kind of input");
        result = await run(third, n, hyp);
      }
    } else if (input.f === "zInterval_1Prop") {
      const [x, n, c] = [await values(a0), await values(a1), (await values(a2)) ?? 0.95];
      if (typeof x !== "number" || typeof n !== "number" || typeof c !== "number") throw new EngineError("Error: Wrong kind of input");
      const z = Number((await giac(`evalf(normal_icdf(0,1,${(1 + c) / 2}))`)).trim());
      result = propInterval(x, n, c, z);
    } else if (input.f === "OneVar") result = oneVar(asList(await values(a0)), (await values(a1)) ?? 1);
    else {
      // TwoVar and the regressions: X, Y[, [Freq][, Category, Include]].
      const [xs, ys] = [asList(await values(a0)), asList(await values(a1))];
      const freq = await included(xs, (await values(a2)) ?? 1, a3, a4);
      result = input.f === "TwoVar" ? twoVar(xs, ys, freq) : regression(input.f, xs, ys, freq);
    }
    const definition = await storeStats(result, giac);
    const output = statTable(result.rows, settings.digits, (v) => listAst(v, settings.digits));
    return { ok: true, input, output, outputText: print(output), definition };
  } catch (e) {
    const message = e instanceof Error ? e.message : "Error: Invalid input";
    return { ok: false, input, error: message.startsWith("Error") ? message : "Error: Invalid input" };
  }
}

/**
 * A number as the handheld shows it at Float n, undef when it isn't one. Like
 * any decimal answer (shownDecimal), a cell keeps the digits it was worked
 * out to when Display Digits rounds it, so ans[2,2] carries on with stat.x̄
 * itself.
 */
const numCell = (v: number, digits: number): Ast => {
  if (!Number.isFinite(v)) return { k: "num", v: "undef" };
  const shown = formatFloat(v, digits);
  const full = (v < 0 ? "-" : "") + decimalText(v);
  return shown !== "0." && Number(full) !== Number(shown) ? { k: "num", v: shown, full } : { k: "num", v: shown };
};

/** |v| written out in full, still a decimal (11., not 11): the digits stat.x̄ and the other results keep. */
function decimalText(v: number): string {
  const t = String(Math.abs(v)).replace("e+", "E").replace("e", "E");
  return /[.E]/.test(t) ? t : `${t}.`;
}
const listAst = (v: number[], digits: number): Ast => ({ k: "list", items: v.map((x) => numCell(x, digits)) });

/** The results as the two-column matrix stat.results is: [["Title",…]["x̄",22.6364]…]. */
function statTable(rows: StatRow[], digits: number, list: (v: number[]) => Ast): Ast {
  const cell = (v: StatRow[1]): Ast => (typeof v === "string" ? { k: "str", v } : Array.isArray(v) ? list(v) : numCell(v, digits));
  return { k: "mat", rows: rows.map(([label, v]) => [{ k: "str", v: label }, cell(v)]) };
}

/**
 * The latest statistics results, kept in Giac so that a restart's replay of
 * the definitions brings them back and clearing the calculator clears them:
 * stats.ts's rows and the regression equation, as JSON in a base64 string
 * (Giac rewrites some characters inside its strings, a brace among them).
 */
const STAT_STORE = "stat_results_";
type StatStore = { rows: StatRow[]; regEqn?: string };

async function storeStats(result: StatResult, giac: Giac): Promise<string> {
  const json = JSON.stringify({ rows: result.rows, regEqn: result.regEqn } satisfies StatStore, (_, v: unknown) =>
    typeof v === "number" && !Number.isFinite(v) ? null : v,
  );
  let bytes = "";
  for (const b of new TextEncoder().encode(json)) bytes += String.fromCharCode(b);
  const definition = `${STAT_STORE}:="${btoa(bytes)}"`;
  await giac(definition);
  return definition;
}

async function loadStats(giac: Giac): Promise<StatStore | null> {
  const raw = (await giac(STAT_STORE)).trim();
  const m = /^"([A-Za-z0-9+/=]*)"$/.exec(raw);
  if (!m) return null;
  const store = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(m[1]!), (c) => c.charCodeAt(0)))) as StatStore;
  // Infinity and NaN went into the JSON as null; both show as undef.
  for (const row of store.rows) if (row[1] === null) row[1] = NaN;
  return store;
}

/**
 * The results by the name each is stored under on the handheld (stat.x̄,
 * stat.q₁x …), folded as the parser folds a typed name. RegEqn is left out:
 * stat.RegEqn is the fitted function, not the "m*x+b" the table shows.
 */
function statMembers(store: StatStore): Map<string, StatRow[1]> {
  const out = new Map<string, StatRow[1]>();
  for (const [label, v] of store.rows) {
    const name = memberName(label);
    if (!name || name === "RegEqn") continue;
    try {
      const typed = parse(`stat.${name}`);
      if (typed.k === "sym") out.set(typed.name, v);
    } catch {
      // Not a name a person could type.
    }
  }
  return out;
}

/** A value as an expression, at full precision, still a decimal (stat.n is 11., not 11). */
function valueAst(v: StatRow[1]): Ast {
  if (typeof v === "string") return { k: "str", v };
  if (Array.isArray(v)) return { k: "list", items: v.map((x) => valueAst(x)) };
  if (!Number.isFinite(v)) return sym("undef");
  const n: Ast = { k: "num", v: decimalText(v) };
  return v < 0 ? { k: "neg", a: n } : n;
}

/**
 * stat.x̄, stat.Resid, stat.RegEqn(10) …: the latest statistics results put
 * in where they're named. A name the latest command didn't store is left as
 * it is, as the handheld leaves an undefined name (stat.q1x: the handheld's
 * name is stat.Q₁X).
 */
async function statVariables(a: Ast, giac: Giac): Promise<Ast> {
  let named = false;
  mapAst(a, (x) => {
    if ((x.k === "sym" && x.name.startsWith("stat.")) || (x.k === "call" && x.f.startsWith("stat."))) named = true;
    return x;
  });
  if (!named) return a;
  const store = await loadStats(giac);
  if (!store) return a;
  const members = statMembers(store);
  const regEqn = store.regEqn ? parse(store.regEqn) : null;
  return mapAst(a, (x) => {
    if (x.k === "sym" && x.name === "stat.results") return { k: "mat", rows: store.rows.map(([label, v]) => [{ k: "str", v: label }, Array.isArray(v) ? { k: "str", v: "{...}" } : valueAst(v)]) };
    if (x.k === "sym" && members.has(x.name)) return valueAst(members.get(x.name)!);
    // stat.RegEqn is a function of x.
    if (x.k === "call" && x.f === "stat.regeqn" && regEqn && x.args.length === 1)
      return mapAst(regEqn, (y) => (y.k === "sym" && y.name === "x" ? x.args[0]! : y));
    return x;
  });
}

/**
 * stat.results (and an entry of it, stat.results[2,1]) answered as the
 * handheld shows it: each result at the display digits, a list as the
 * string "{...}". stat.values is the second column, a list written out in
 * full as a string.
 */
async function statResults(input: Ast, giac: Giac, settings: Settings): Promise<EvalResult | null> {
  const [name, index] = input.k === "sym" ? [input.name, []] : input.k === "call" && input.f === "index" && input.args[0]?.k === "sym" ? [input.args[0].name, input.args.slice(1)] : [null, []];
  if (name !== "stat.results" && name !== "stat.values") return null;
  const store = await loadStats(giac);
  if (!store) return null;
  const table = statTable(store.rows, settings.digits, (v) => ({ k: "str", v: name === "stat.results" ? "{...}" : print(listAst(v, settings.digits)) }));
  let output: Ast = name === "stat.results" ? table : { k: "mat", rows: (table as { rows: Ast[][] }).rows.map((r) => [r[1]!]) };
  if (index.length) {
    const at = index.map((i) => (i.k === "num" ? Number(i.v) : NaN));
    const rows = (output as { rows: Ast[][] }).rows;
    const row = rows[at[0]! - 1];
    const cell = at.length === 2 ? row?.[at[1]! - 1] : row && { k: "mat" as const, rows: [row] };
    if (!cell || at.some((i) => !Number.isInteger(i))) return { ok: false, input, error: "Error: Dimension error" };
    output = cell;
  }
  return { ok: true, input, output, outputText: print(output) };
}

/**
 * tvmPmt, bal, ΣInt and the other finance functions (finance.ts), wherever
 * they are in the entry, innermost first: nom(eff(6,12),12) is 6. An entry
 * that is one of them, or stores one (→, :=), is answered here as the
 * handheld shows it, amortTbl's payment numbers whole beside decimal money.
 * Anywhere else the value goes into the entry as a decimal and the entry
 * carries on (round(tvmPmt(…),2)). A call with an argument that isn't a
 * number is left as typed. Null when the entry has none of them.
 */
async function financeCalls(input: Ast, a: Ast, giac: Giac, settings: Settings): Promise<EvalResult | Ast | null> {
  let found = false;
  mapAst(a, (x) => {
    if (x.k === "call" && FINANCE.has(x.f)) found = true;
    return x;
  });
  if (!found) return null;
  const arg = async (x: Ast): Promise<FinanceArg> => {
    if (x.k === "sym" && (x.name === "" || x.name === OMITTED)) return { k: "empty" };
    // A decimal from Ans carries its worked-out digits (full) behind the shown ones.
    const typedNumber = x.k === "num" ? Number(x.full ?? x.v) : x.k === "neg" && x.a.k === "num" ? -Number(x.a.full ?? x.a.v) : NaN;
    if (Number.isFinite(typedNumber)) return { k: "num", v: typedNumber };
    const raw = (await giac(`evalf(${translate(x, settings).giac},15)`)).trim();
    if (/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(raw)) return { k: "num", v: Number(raw) };
    if (/^\[\[.*\]\]$/.test(raw)) {
      const rows = raw.slice(2, -2).split(/\]\s*,\s*\[/).map((r) => r.split(",").map((t) => Number(t.trim())));
      if (rows.every((r) => r.every(Number.isFinite))) return { k: "table", rows };
    }
    return { k: "other" };
  };
  // The arguments' own finance calls first, then the call itself.
  const value = async (call: Extract<Ast, { k: "call" }>): Promise<FinanceValue | null> => {
    const args: FinanceArg[] = [];
    for (const x of call.args) args.push(await arg(await inner(x)));
    return finance(call.f, args);
  };
  // As a decimal Giac reads as an ordinary float: 14 significant digits (15 and it reads a long float).
  // Exact mode would read a typed decimal as a fraction; these answers are decimals in any mode.
  const decimal = (v: number): Ast => {
    let s = String(Number(v.toPrecision(14))).replace("e+", "E").replace("e", "E");
    if (!/[.E]/.test(s)) s += ".";
    const n: Ast = { k: "num", v: s };
    return settings.mode === "exact" ? { k: "call", f: "approx", args: [n] } : n;
  };
  const asAst = (v: FinanceValue): Ast =>
    typeof v === "number" ? decimal(v) : { k: "mat", rows: v.table.map(([n, ...money]) => [{ k: "num", v: String(n) }, ...money.map(decimal)]) };
  const inner = async (x: Ast): Promise<Ast> => {
    switch (x.k) {
      case "call": {
        if (FINANCE.has(x.f)) {
          const v = await value(x);
          if (v !== null) return asAst(v);
        }
        const args: Ast[] = [];
        for (const y of x.args) args.push(await inner(y));
        // Giac drops an empty argument, which shifts the rest along (FV read as PpY) in a
        // function stored with the call in it: an omitted one goes to Giac as a name.
        if (FINANCE.has(x.f)) return { ...x, args: args.map((y) => (y.k === "sym" && y.name === "" ? sym(OMITTED) : y)) };
        return { ...x, args };
      }
      case "bin":
        return { ...x, a: await inner(x.a), b: await inner(x.b) };
      case "neg":
      case "not":
      case "post":
        return { ...x, a: await inner(x.a) };
      case "list": {
        const items: Ast[] = [];
        for (const y of x.items) items.push(await inner(y));
        return { ...x, items };
      }
      case "mat": {
        const rows: Ast[][] = [];
        for (const r of x.rows) {
          const row: Ast[] = [];
          for (const y of r) row.push(await inner(y));
          rows.push(row);
        }
        return { ...x, rows };
      }
      case "define":
        return { ...x, rhs: await inner(x.rhs) };
      default:
        return x;
    }
  };
  // The answer as shown: numbers to the display digits, payment numbers whole.
  // Each decimal keeps its worked-out digits behind the shown ones, so Ans carries on with them.
  // In Approx mode every number is a decimal, the payment numbers too ({12,15}→ages shows
  // {12.,15.} on the handheld).
  const paymentNumber = (n: number): Ast => (settings.mode === "approx" ? shownDecimal(n, settings.digits) : { k: "num", v: String(n) });
  const shown = (v: FinanceValue): Ast =>
    typeof v === "number"
      ? shownDecimal(v, settings.digits)
      : { k: "mat", rows: v.table.map(([n, ...money]) => [paymentNumber(n!), ...money.map((m) => shownDecimal(m, settings.digits))]) };
  const isFinance = (x: Ast): x is Extract<Ast, { k: "call" }> => x.k === "call" && FINANCE.has(x.f);
  const [call, name] =
    a.k === "bin" && a.op === "→" && isFinance(a.a) && a.b.k === "sym"
      ? [a.a, a.b.name]
      : a.k === "bin" && a.op === ":=" && isFinance(a.b) && a.a.k === "sym"
        ? [a.b, a.a.name]
        : [isFinance(a) ? a : null, null];
  if (call) {
    const v = await value(call);
    if (v !== null) {
      const output = shown(v);
      if (!name) return { ok: true, input, output, outputText: print(output) };
      // Stored at full precision; the table keeps its whole payment numbers.
      const definition = `${RENAME_IN[name] ?? name}:=${toGiac(asAst(v), settings)}`;
      await giac(definition);
      return { ok: true, input, output, outputText: print(output), definition };
    }
  }
  return inner(a);
}

/** An omitted finance argument as Giac holds it (see financeCalls); shown as the empty slot it was. */
const OMITTED = "omitted_";

/**
 * A finance call whose arguments are all numbers (a fraction, an amortisation
 * table) or omitted: one financeCalls can always work out, so working it out
 * again can't come back to the same call.
 */
function numericFinance(a: Ast): boolean {
  let found = false;
  const number = (x: Ast): boolean => x.k === "num" || (x.k === "neg" && number(x.a)) || (x.k === "bin" && x.op === "/" && number(x.a) && number(x.b));
  const numeric = (x: Ast): boolean =>
    number(x) || (x.k === "sym" && (x.name === "" || x.name === OMITTED)) || (x.k === "mat" && x.rows.length > 1 && x.rows.every((r) => r.every(number)));
  mapAst(a, (x) => {
    if (x.k === "call" && FINANCE.has(x.f) && x.args.every(numeric)) found = true;
    return x;
  });
  return found;
}

/**
 * CopyVar stat.RegEqn,f1: how the regression wizard saves the equation. The
 * handheld's wizard pastes LinRegMx X,Y,1: CopyVar stat.RegEqn,f1:
 * stat.results, so f1 becomes the latest regression's
 * function, at full precision, and every Graphs page plots it. Other copies
 * aren't done here yet.
 */
async function copyVar(input: Extract<Ast, { k: "call" }>, giac: Giac, settings: Settings): Promise<EvalResult> {
  const [from, to] = input.args;
  if (!(input.args.length === 2 && from?.k === "sym" && from.name === "stat.regeqn" && to?.k === "sym"))
    return { ok: false, input, error: "Error: Not available here yet" };
  const store = await loadStats(giac);
  if (!store?.regEqn) return { ok: false, input, error: "Error: Undefined variable" };
  const def = await evaluate(`Define ${to.name}(x)=${store.regEqn}`, giac, { settings });
  if (!def.ok) return { ...def, input };
  const n = /^f(\d+)$/.exec(to.name);
  const output = sym("Done");
  return { ok: true, input, output, outputText: print(output), definition: def.definition, regEqn: n ? { n: Number(n[1]), text: store.regEqn } : undefined };
}

/** 1→a:2→b:g(a,b): each command in turn, answering with the last. */
async function statements(input: Ast, giac: Giac, opts: { settings: Settings; ans?: Ast; approx?: boolean }): Promise<EvalResult> {
  const parts: Ast[] = [];
  const walk = (a: Ast): void => {
    if (a.k === "bin" && a.op === ":") {
      walk(a.a);
      walk(a.b);
    } else parts.push(a);
  };
  walk(input);
  const definitions: string[] = [];
  let ans = opts.ans;
  let last: EvalResult | undefined;
  // A regression equation copied to f1 part-way (the regression wizard's paste).
  let regEqn: { n: number; text: string } | undefined;
  for (const p of parts) {
    last = await evaluate(print(p), giac, { ...opts, ans });
    if (!last.ok) return { ...last, input };
    ans = last.output;
    definitions.push(...(last.definitions ?? []), ...(last.definition ? [last.definition] : []));
    regEqn = last.regEqn ?? regEqn;
  }
  if (!last?.ok) return { ok: false, input, error: "Error: Invalid input" };
  return { ...last, input, definition: undefined, definitions, regEqn };
}

/**
 * x=1 or x=2, and x=2 and y=1|…: Giac reads joined equations as a test, so
 * a solution comes back false. Each equation is evaluated (or substituted
 * into) on its own and the answer joined again, true and false folded in.
 */
async function perAnswer(a: Ast, giac: Giac, opts: { settings: Settings; approx?: boolean }): Promise<EvalResult | null> {
  const logical = (x: Ast): boolean => x.k === "bin" && (x.op === "or" || x.op === "and");
  // approx(x=√2 or x=−√2) and Ans▶Decimal after a solve: decimals for each answer (Giac's evalf of an "or" is false).
  if ((a.k === "call" && a.f === "approx" && a.args.length === 1 && logical(a.args[0]!)) || (a.k === "post" && a.op === "▶Decimal" && logical(a.a))) {
    const inner = a.k === "call" ? a.args[0]! : (a as { a: Ast }).a;
    const r = await perAnswer(inner, giac, { ...opts, approx: true });
    return r && r.ok ? { ...r, input: a } : r;
  }
  const [lhs, cond] = a.k === "bin" && a.op === "|" ? [a.a, a.b] : [a, undefined];
  if (!logical(lhs)) return null;
  const relation = (x: Ast): boolean => x.k === "bin" && ["=", "≠", "<", ">", "≤", "≥"].includes(x.op);
  const leaves: Ast[] = [];
  const walk = (x: Ast): void => {
    if (logical(x) && x.k === "bin") {
      walk(x.a);
      walk(x.b);
    } else leaves.push(x);
  };
  walk(lhs);
  if (!leaves.every(relation)) return null;
  const fold = async (x: Ast): Promise<Ast | string> => {
    if (x.k === "bin" && (x.op === "or" || x.op === "and")) {
      const [l, r] = [await fold(x.a), await fold(x.b)];
      if (typeof l === "string") return l;
      if (typeof r === "string") return r;
      const t = (y: Ast, v: string) => y.k === "sym" && y.name === v;
      if (x.op === "or") {
        if (t(l, "true") || t(r, "true")) return sym("true");
        if (t(l, "false")) return r;
        if (t(r, "false")) return l;
      } else {
        if (t(l, "false") || t(r, "false")) return sym("false");
        if (t(l, "true")) return r;
        if (t(r, "true")) return l;
      }
      return { ...x, a: l, b: r };
    }
    const r = await evaluate(print(cond ? { k: "bin", op: "|", a: x, b: cond } : x), giac, opts);
    return r.ok ? r.output : r.error;
  };
  const output = await fold(lhs);
  if (typeof output === "string") return { ok: false, error: output };
  return { ok: true, input: a, output, outputText: print(output) };
}

/**
 * tangentLine and normalLine where the slope is infinite or zero: a vertical
 * tangent is x=a (and its normal the level line), a level tangent's normal
 * is x=a, and a point the function only reaches from one side is undef.
 */
async function steepLine(input: Extract<Ast, { k: "call" }>, giac: Giac, settings: Settings): Promise<Ast | null> {
  if (!input.args[0]) return null;
  const F = translate(input.args[0], settings).giac;
  const [X, A] = lineAt(input.args, settings);
  const slope = (await giac(`subst(diff(${F},${X}),${X},${A})`)).trim();
  const vertical = (): Ast => ({ k: "bin", op: "=", a: parse(X, { giac: true }), b: parse(A, { giac: true }) });
  // A level tangent's normal is vertical (also when the slope comes out 0. from a decimal point).
  if (input.f === "normalLine" && (slope === "0" || Number(slope.replace(/=.*$/, "")) === 0)) return vertical();
  if (!/^([+-]?infinity|undef)$/.test(slope)) return null;
  const lim = (await giac(`limit(diff(${F},${X}),${X},${A})`)).trim();
  const sides = await giac(`[evalf(subst(${F},${X},(${A})-1e-6)),evalf(subst(${F},${X},(${A})+1e-6))]`);
  const real = !/\bi\b|undef/.test(sides);
  if (!/^[+-]?infinity$/.test(lim) || !real) return sym("undef");
  if (input.f === "tangentLine") return vertical();
  const level = await giac(`subst(${F},${X},${A})`);
  return format(level, { hint: "plain", digits: settings.digits });
}

const RELATIONS: Record<string, string> = { "=": "==", "≠": "!=", "<": "<", ">": ">", "≤": "<=", "≥": ">=" };

/** "2=−2" → "false"; anything with a variable left in it is returned as it was. */
async function decide(raw: string, giac: Giac): Promise<string> {
  let a: Ast;
  try {
    a = parse(raw.trim(), { giac: true });
  } catch {
    return raw;
  }
  const s = { angle: "rad" as const };
  // Lists and matrices compare element by element, each decided: {1,2}={1,2} is {true,true}.
  if (a.k === "list" || a.k === "mat") {
    const each = async (xs: Ast[]) => {
      const out: string[] = [];
      for (const x of xs) out.push(await decide(toGiac(x, s), giac));
      return `[${out.join(",")}]`;
    };
    if (a.k === "list") return each(a.items);
    if (a.rows.length === 1 && !raw.trim().startsWith("[[")) return each(a.rows[0]!);
    const rows: string[] = [];
    for (const r of a.rows) rows.push(await each(r));
    return `[${rows.join(",")}]`;
  }
  if (!(a.k === "bin" && RELATIONS[a.op])) return raw;
  let free = false;
  mapAst(a, (x) => {
    if (x.k === "sym" && !["pi", "e", "i", "π", "ℯ", "inf", "infinity"].includes(x.name)) free = true;
    return x;
  });
  // An identity is true however its variables vary: sin(x)²+cos(x)²=1.
  if (free) {
    if (a.op !== "=") return raw;
    const same = (await giac(`simplify((${toGiac(a.a, s)})-(${toGiac(a.b, s)}))==0`)).trim();
    return same === "true" || same === "1" ? "true" : raw;
  }
  const test = a.op === "=" ? `normal((${toGiac(a.a, s)})-(${toGiac(a.b, s)}))==0` : `(${toGiac(a.a, s)})${RELATIONS[a.op]}(${toGiac(a.b, s)})`;
  const v = (await giac(test)).trim();
  return v === "true" || v === "1" ? "true" : v === "false" || v === "0" ? "false" : raw;
}

/**
 * completeSquare in several variables, or in a power: each variable's
 * square is completed in turn on what the last left over, so
 * x²+4x+y²+6y+3=0 is (x+2)²+(y+3)²=10 and x⁶+2x³+3 in x³ is (x³+1)²+2.
 * One plain variable is left to the single-variable path.
 */
async function completeSquares(input: Extract<Ast, { k: "call" }>, giac: Giac, settings: Settings): Promise<Ast | null> {
  const [e, ...rest] = input.args;
  if (!e || !rest.length) return null;
  const vars = rest.length === 1 && rest[0]!.k === "list" ? rest[0]!.items : rest;
  if (vars.length === 1 && vars[0]!.k === "sym") return null;
  const t = (a: Ast) => translate(a, settings).giac;
  const equation = e.k === "bin" && e.op === "=";
  let D = equation ? `(${t(e.a)})-(${t(e.b)})` : t(e);
  // A power such as x³ stands in as one variable, put back at the end.
  const names: string[] = [];
  const back: string[] = [];
  for (const [k, v] of vars.entries()) {
    if (v.k === "sym") names.push(t(v));
    else if (v.k === "bin" && v.op === "^" && v.a.k === "sym") {
      const name = `sq${k}_`;
      D = (await giac(`simplify(subst(${D},${t(v.a)}=${name}^(1/(${t(v.b)}))))`)).trim();
      names.push(name);
      back.push(`${name}=${t(v)}`);
    } else return null;
  }
  D = (await giac(`expand(${D})`)).trim();
  const squares: string[] = [];
  for (const v of names) {
    if ((await giac(`degree(${D},${v})`)).trim() !== "2") continue;
    const a = (await giac(`coeff(${D},${v},2)`)).trim();
    const b = (await giac(`coeff(${D},${v},1)`)).trim();
    const h = (await giac(`normal((${b})/(2*(${a})))`)).trim();
    squares.push(`(${a})*(${v}+(${h}))^2`);
    D = (await giac(`expand((${D})-(${a})*${v}^2-(${b})*${v}-(${b})^2/(4*(${a})))`)).trim();
  }
  if (!squares.length) return null;
  let raw = (await giac(`${squares.join("+")}+(${D})`)).trim();
  // Giac may append its decimal value ("…=3·(x+0.666667)²…"); the exact part comes first.
  raw = raw.replace(/=[^=]*\d\.\d[^=]*$/, "");
  if (back.length) raw = (await giac(`subst(${raw},[${back.join(",")}])`)).trim();
  return format(raw, { hint: equation ? "completesq" : "plain", digits: settings.digits });
}

/** Giac's record of the functions whose bodies call other user functions: ["g","<source, base64>",…]. */
const DEPENDS = "cas_deps_";

const toBase64 = (t: string) => {
  let bytes = "";
  for (const b of new TextEncoder().encode(t)) bytes += String.fromCharCode(b);
  return btoa(bytes);
};
const fromBase64 = (t: string) => new TextDecoder().decode(Uint8Array.from(atob(t), (c) => c.charCodeAt(0)));

/** The user functions an expression calls, other than self. */
function userCalls(a: Ast, self?: string): Set<string> {
  const out = new Set<string>();
  mapAst(a, (x) => {
    if (x.k === "call" && x.f !== self && x.f !== "index" && /^[A-Za-z]\w*$/.test(x.f) && !BUILTINS.has(x.f) && !isCommand(x.f)) out.add(x.f);
    return x;
  });
  return out;
}

/**
 * On the handheld a function calls the current definition of another:
 * Define g(x)=f(x)+1, then Define f(x)=x, and g(2) is 3 (it
 * was 9, from the f that g was defined with). Define works a body out when
 * it's defined (Define k(x)=d(f(x),x) stores the derivative), so to keep
 * that and still follow f, each function whose body calls another user
 * function keeps its source in Giac (DEPENDS, replayed after a restart),
 * and when a function is defined again or deleted, the functions that call
 * it are defined again from their sources, in the order they were made,
 * and so on for the ones that call those. That is the same as working the
 * body out from its source whenever it's called, as long as the functions
 * have no side effects, which on the Calculator page they don't.
 */
async function lateBinding(a: Ast, hint: string | undefined, giac: Giac, opts: { settings: Settings; approx?: boolean; seen?: Set<string> }): Promise<string[]> {
  let changed: string[] = [];
  let own: { name: string; src: string } | null = null;
  // The new definition's parameter count: a call with another count is left alone
  // (Giac crashes, uncatchably, on f(x) for an f of two parameters).
  let arity: number | undefined;
  if (hint === "define") {
    const pair = a.k === "define" ? [a.lhs, a.rhs] : a.k === "bin" && a.op === "→" ? [a.b, a.a] : a.k === "bin" && a.op === ":=" ? [a.a, a.b] : null;
    if (!pair || pair[0]!.k !== "call") return [];
    const name = pair[0]!.f;
    changed = [name];
    arity = pair[0]!.args.length;
    if (userCalls(pair[1]!, name).size) own = { name, src: print({ k: "define", lhs: pair[0]!, rhs: pair[1]! }) };
  } else if (hint === "delvar" && a.k === "call") {
    changed = a.args.flatMap((x) => (x.k === "sym" ? [x.name] : []));
  } else return [];
  const raw = (await giac(DEPENDS)).trim();
  const flat = [...raw.matchAll(/"([^"]*)"/g)].map((m) => m[1]!);
  const entries: { name: string; src: string }[] = [];
  for (let k = 0; k + 1 < flat.length; k += 2) {
    try {
      entries.push({ name: flat[k]!, src: fromBase64(flat[k + 1]!) });
    } catch {
      // A damaged entry is dropped.
    }
  }
  if (!entries.length && !own) return [];
  const kept = entries.flatMap((e) => (!changed.includes(e.name) ? [e] : own && e.name === own.name ? [own] : []));
  if (own && !kept.includes(own)) kept.push(own);
  const defs: string[] = [];
  const text = (es: typeof entries) => `${DEPENDS}:=[${es.map((e) => `"${e.name}","${toBase64(e.src)}"`).join(",")}]`;
  if (text(kept) !== text(entries)) {
    const cmd = text(kept);
    await giac(cmd);
    defs.push(cmd);
  }
  const seen = opts.seen ?? new Set<string>(changed);
  for (const e of kept) {
    if (seen.has(e.name)) continue;
    let src: Ast;
    try {
      src = parse(e.src);
    } catch {
      continue;
    }
    if (![...userCalls(src)].some((f) => changed.includes(f))) continue;
    let fits = true;
    mapAst(src, (x) => {
      if (x.k === "call" && changed.includes(x.f) && arity !== undefined && x.args.length !== arity) fits = false;
      return x;
    });
    if (!fits) continue;
    seen.add(e.name);
    const r = await evaluateText(e.src, giac, { settings: opts.settings, seen });
    if (r.ok) defs.push(...(r.definitions ?? []), ...(r.definition ? [r.definition] : []));
  }
  return defs;
}

/**
 * A user's function's name where a value goes. Storing a value in it is
 * refused with an error (5→p after Define p(x)=2x; 2+0.25*f(1,2)→y1
 * where y1 is still a function Defined earlier), while Define replaces
 * whatever a name holds (3→h then Define h(x)=x+1 works). The name used
 * without its arguments is an "Argument Error" (p+1, y1+0.25*f(1.25,y1)→y2).
 * DelVar takes the name itself.
 */
function functionNameMisuse(a: Ast, functions: Set<string>): string | null {
  if (!functions.size || (a.k === "call" && a.f === "DelVar")) return null;
  // A function's parameters and a command's variable are names of their own there:
  // Define v(h)=4π·h and seq(h²,h,1,3) don't mean the function h (they worked before
  // h was protected, and a parameter is local on the handheld).
  const local = new Set<string>();
  const head = a.k === "define" ? a.lhs : a.k === "bin" && a.op === "→" ? a.b : a.k === "bin" && a.op === ":=" ? a.a : null;
  if (head?.k === "call") for (const p of head.args) if (p.k === "sym") local.add(p.name);
  const names = (x: Ast | undefined): string[] =>
    !x ? [] : x.k === "sym" ? [x.name] : x.k === "list" ? x.items.flatMap(names) : x.k === "bin" && x.op === "=" && x.a.k === "sym" ? [x.a.name] : [];
  mapAst(a, (x) => {
    if (x.k === "call") for (const k of [...(VARIABLE_ARGS[x.f] ?? []), ...(SOLVE_LIKE.has(x.f) ? [1] : [])]) for (const n of names(x.args[k])) local.add(n);
    return x;
  });
  const isFn = (x: Ast) => x.k === "sym" && !local.has(x.name) && functions.has(RENAME_IN[x.name] ?? x.name);
  const store = a.k === "bin" && (a.op === "→" || a.op === ":=") ? (a.op === "→" ? [a.b, a.a] : [a.a, a.b]) : null;
  if (store && isFn(store[0]!)) return "Error: That name is already a function";
  let bare = false;
  mapAst(a.k === "define" ? a.rhs : store ? store[1]! : a, (x) => {
    if (isFn(x)) bare = true;
    return x;
  });
  return bare ? "Error: Argument Error" : null;
}

/**
 * [1,2,3]→p and Define ab=[0,1,1]: on the handheld a vector is a one-row
 * matrix, so p[1,3] is 3, dim(p) is {1,3} and ab shows as [0,1,1], not the
 * list {0,1,1}. Giac holds it as a flat vector, the same as a list, so the
 * name is marked (cas_row_p_:=1) when what's stored shows as a one-row
 * matrix, and unmarked when something else is stored over a marked name.
 * The mark is returned as a definition, so a restart's replay keeps it.
 */
async function markRow(a: Ast, output: Ast, tr: { hint?: string; listify: boolean }, flagged: Set<string>, giac: Giac): Promise<string[]> {
  const hint = tr.hint;
  if (hint !== "store" && hint !== "define" && hint !== "delvar") return [];
  const target = a.k === "define" ? a.lhs : a.k === "bin" && a.op === "→" ? a.b : a.k === "bin" && a.op === ":=" ? a.a : null;
  const names = hint === "delvar" && a.k === "call" ? a.args : target ? [target] : [];
  const out: string[] = [];
  for (const t of names) {
    // r(t):=[100−10t,10t,0]: the function is marked, so r(0) shows as [100,0,0] and not the list {100,0,0}.
    if (t.k === "call" && hint === "define" && /^[A-Za-z]\w*$/.test(t.f)) {
      const f = RENAME_IN[t.f] ?? t.f;
      if (!tr.listify && !flagged.has(f)) out.push(`${rowFlag(f)}:=1`);
      else if (tr.listify && flagged.has(f)) out.push(`${rowFlag(f)}:=0`);
      continue;
    }
    if (t.k !== "sym") continue;
    const name = RENAME_IN[t.name] ?? t.name;
    // Define answers Done: there it's what the name holds now, with a matrix in the input.
    const row =
      hint === "store"
        ? output.k === "mat" && output.rows.length === 1
        : hint === "define" && !tr.listify && (await giac(`type(${name})==DOM_LIST and size(${name})>0 and type(${name}[0])!=DOM_LIST`)).trim() === "true";
    if (row && !flagged.has(name)) out.push(`${rowFlag(name)}:=1`);
    else if (!row && flagged.has(name)) out.push(`${rowFlag(name)}:=0`);
  }
  for (const c of out) await giac(c);
  return out;
}

/**
 * Define fc(m)=∫(f(x),x,0,m) with f a Defined piecewise: working the body
 * out in Giac integrates the piecewise to a symbolic bound, which takes the
 * engine down (wave-1 integrals notes). It's worked out as the integral on
 * its own is (piecewiseIntegral), with the parameters held, and stored.
 */
async function definedIntegral(a: Ast, giac: Giac, settings: Settings): Promise<string | null> {
  const pair = a.k === "define" ? [a.lhs, a.rhs] : a.k === "bin" && a.op === "→" ? [a.b, a.a] : a.k === "bin" && a.op === ":=" ? [a.a, a.b] : null;
  if (!pair) return null;
  const [lhs, rhs] = pair as [Ast, Ast];
  if (!(lhs.k === "call" && lhs.args.length && lhs.args.every((p) => p.k === "sym"))) return null;
  const top = core(rhs);
  if (!(top.k === "call" && (top.f === "∫" || top.f === "integral") && top.args.length === 4)) return null;
  const parts = defineParts(a, { ...settings });
  if (!parts) return null;
  const params = lhs.args.map((p) => (p as { name: string }).name);
  // Held as m_h_, not the usual m_p_: the answer comes back formatted, and format shows m_p_ as m.
  const held = mapAst(rhs, (y) => (y.k === "sym" && params.includes(y.name) ? sym(`${RENAME_IN[y.name] ?? y.name}_h_`) : y));
  const r = await piecewiseIntegral(held, giac, settings);
  return r?.ok ? `${parts.head.replace(/_p_\b/g, "_h_")}:=${toGiac(r.output, settings)}` : null;
}

/** A when(…) or piecewise(…) whose test is an = or ≠ (when(n=0,1,…)). */
function hasEqualityTest(a: Ast): boolean {
  let found = false;
  const equality = (c: Ast | undefined) => {
    mapAst(c ?? sym(""), (y) => {
      if (y.k === "bin" && (y.op === "=" || y.op === "≠")) found = true;
      return y;
    });
  };
  mapAst(a, (x) => {
    if (x.k === "call" && x.f === "when") equality(x.args[0]);
    if (x.k === "call" && x.f === "piecewise") x.args.forEach((c, k) => k % 2 === 1 && equality(c));
    return x;
  });
  return found;
}

/**
 * Whether a definition's body calls a user function that can't be worked out with
 * its argument held: one with an = or ≠ test, or one that calls itself, directly or
 * through other user functions. With s(x)=when(x=0,1,2), working out
 * Define t(x)=s(x)+1 decided s(x_p_) as 2 and stored t(x)=3, so t(0) was 3; and
 * working out a call of a recursive function followed the recursion with the argument
 * unknown (Define q(n)=fib(n)/2 took the engine down).
 */
async function callsUnheldTest(a: Ast, giac: Giac): Promise<boolean> {
  const pair = a.k === "define" ? [a.lhs, a.rhs] : a.k === "bin" && a.op === "→" ? [a.b, a.a] : a.k === "bin" && a.op === ":=" ? [a.a, a.b] : null;
  if (!pair) return false;
  const self = pair[0]!.k === "call" ? pair[0]!.f : undefined;
  const queue = [...userCalls(pair[1]!, self)].map((n) => RENAME_IN[n] ?? n);
  const seen = new Set<string>();
  // A few levels of calls are plenty; each look is one Giac call.
  while (queue.length && seen.size < 20) {
    const name = queue.shift()!;
    if (seen.has(name)) continue;
    seen.add(name);
    // Giac shows a function as (x)->((x=0)? 1 : 2): a when is ?:, a recursive one calls its helper fa_r_.
    const shown = (await giac(name)).trim();
    const arrow = shown.indexOf("->");
    if (arrow < 0) continue;
    const body = shown.slice(arrow + 2);
    if (/_r_\(/.test(body)) return true;
    if (/\?|piecewise\(/.test(body) && /(?<![<>!:=])=(?!=)|==|!=|<>/.test(body)) return true;
    for (const m of body.matchAll(/\b([A-Za-z]\w*)\(/g)) queue.push(m[1]!);
  }
  return false;
}

/**
 * How deep a user's function may call itself before it's an error. The handheld's own limit isn't known; this is past any
 * recurrence an exam asks for (a 30-year monthly loan is 360 calls).
 */
const RECURSION_LIMIT = 1000;

/**
 * Define fa(n)=when(n=0,1,n*fa(n-1)): a function that calls itself. Working
 * the body out first would follow the recursion with n unknown, and Giac's
 * piecewise works out every branch whatever the test says, so neither
 * happens: piecewise becomes a chain of when (which works out only the
 * branch its test picks), and the body goes to a helper that counts its
 * depth, fa_r_(d_,n). Past RECURSION_LIMIT it stops with the handheld's
 * an error ("Too many nested calls"), which is what a function with no base case
 * (Define fb(n)=n*fb(n-1)) gives instead of running forever.
 */
function recursiveDefinition(input: Ast, s: Settings): { helper: string; main: string } | null {
  const pair = input.k === "define" ? [input.lhs, input.rhs] : input.k === "bin" && (input.op === "→" || input.op === ":=") ? (input.op === "→" ? [input.b, input.a] : [input.a, input.b]) : null;
  if (!pair) return null;
  const [lhs, rhs] = pair as [Ast, Ast];
  if (lhs.k !== "call") return null;
  let self = false;
  const body = mapAst(rhs, (x) => {
    if (x.k === "call" && x.f === lhs.f) self = true;
    if (x.k !== "call" || x.f !== "piecewise") return x;
    // Entry order: value, test, value, test, …, [otherwise].
    let chain: Ast = x.args.length % 2 === 1 ? x.args[x.args.length - 1]! : sym("undef");
    for (let k = x.args.length - (x.args.length % 2 === 1 ? 3 : 2); k >= 0; k -= 2) chain = { k: "call", f: "when", args: [x.args[k + 1]!, x.args[k]!, chain] };
    return chain;
  });
  if (!self) return null;
  const parts = defineParts({ k: "define", lhs, rhs: body }, { ...s });
  if (!parts) return null;
  const fn = parts.head.slice(0, parts.head.indexOf("("));
  const params = parts.head.slice(fn.length + 1, -1);
  const back = parts.body
    .replace(/\b([A-Za-z]\w*_q_)\b/g, (m) => parts.names[m] ?? m)
    .replace(new RegExp(`\\b${fn}\\(`, "g"), `${fn}_r_(d_+1,`);
  return {
    helper: `${fn}_r_(d_,${params}):=ifte(d_<${RECURSION_LIMIT},${back},error("Too many nested calls"))`,
    main: `${parts.head}:=${fn}_r_(0,${params})`,
  };
}

/** The handheld's commands that take a whole list, as typed. */
const WHOLE_LIST_IN = /\b(sum|mean|median|stDevSamp|stDevPop|varSamp|varPop|dim|max|min|product|cumulativeSum|mid|left|right|augment|seq|sortA|sortD|countIf|sumIf)\(/;

/** Commands that take a whole list: a function whose body uses one is given the list as it is. */
const WHOLE_LIST = /\b(sum|mean|median|size|dim|max|min|sort|sorta|sortd|cumsum|product|stddevp?|variance|seq|count|mid|left|right|augment|head|tail|revlist|concat|mat2list|list2mat|l1norm|l2norm|norm|dot|dotP|cross|crossP)\(/i;

/**
 * A user's function given a list works element by element on the handheld
 * (Define f(x)=x^2 then f({1,2,3}) is {1,4,9}): the list goes into the body,
 * where list arithmetic is element by element. In Giac a list is a vector and
 * x^2 its dot product (14), so f(L) becomes seq(f(L[k]),k,1,dim(L)). A
 * function whose body takes the whole list (sum, mean …) keeps it.
 */
async function listCalls(a: Ast, giac: Giac): Promise<Ast> {
  const calls: Extract<Ast, { k: "call" }>[] = [];
  mapAst(a, (y) => {
    if (y.k === "call" && y.f !== "index" && !isCommand(y.f) && y.args.length) calls.push(y);
    return y;
  });
  if (!calls.length) return a;
  const { lists } = await containerVars(a, giac);
  const isList = (x: Ast) => x.k === "list" || (x.k === "sym" && lists.has(RENAME_IN[x.name] ?? x.name));
  const names = [...new Set(calls.filter((c) => c.args.some(isList)).map((c) => c.f))];
  if (!names.length) return a;
  const maps = new Set<string>();
  for (const f of names) {
    const body = (await giac(RENAME_IN[f] ?? f)).trim();
    if (/->/.test(body) && !WHOLE_LIST.test(body)) maps.add(f);
  }
  if (!maps.size) return a;
  const k = sym("k_m_");
  return mapAst(a, (y) => {
    if (y.k !== "call" || !maps.has(y.f) || !y.args.some(isList)) return y;
    const first = y.args.find(isList)!;
    const each: Ast = { ...y, args: y.args.map((x) => (isList(x) ? { k: "call", f: "index", args: [x, k] } : x)) };
    return { k: "call", f: "seq", args: [each, k, { k: "num", v: "1" }, { k: "call", f: "dim", args: [first] }] };
  });
}

/** The flag that marks a name as holding a one-row matrix (see Ctx.rows): cas_row_p_. */
const rowFlag = (name: string) => `cas_row_${name}_`;

/**
 * The input's variables that hold lists, and those that hold matrices, in Giac right now.
 * rows: those of the lists that hold a one-row matrix; flagged: every name marked as
 * one, whatever it holds now (so a list stored over it clears the mark).
 */
async function containerVars(
  a: Ast,
  giac: Giac,
): Promise<{ lists: Set<string>; matrices: Set<string>; complexVars: Set<string>; rows: Set<string>; flagged: Set<string>; functions: Set<string>; vectorFns: Set<string> }> {
  const names = new Set<string>();
  mapAst(a, (x) => {
    if (x.k === "sym" && /^[A-Za-z]\w*$/.test(x.name) && !["i", "true", "false", "ans", "Ans", "undef"].includes(x.name))
      names.add(RENAME_IN[x.name] ?? x.name);
    // A function called (r(0)): its answer is a vector if it was defined as one.
    if (x.k === "call" && x.f !== "index" && /^[A-Za-z]\w*$/.test(x.f) && !BUILTINS.has(x.f) && !isCommand(x.f)) names.add(RENAME_IN[x.f] ?? x.f);
    return x;
  });
  if (!names.size) return { lists: names, matrices: new Set(), complexVars: new Set(), rows: new Set(), flagged: new Set(), functions: new Set(), vectorFns: new Set() };
  const list = [...names];
  // 1 list, 2 matrix, 3 complex, 4 one-row matrix; 5 marked as one but holding something else now;
  // 6 a user's function (Giac's own functions are DOM_FUNC too, and print as 'sin');
  // 7 a user's function defined with a vector or matrix (r(t):=[100−10t,10t,0]).
  const row = (n: string) => `${rowFlag(n)}==1`;
  const test = (n: string) =>
    `ifte(type(${n})==DOM_FUNC,ifte(left(string(${n}),1)=="'",0,ifte(${row(n)},7,6)),ifte(type(${n})==DOM_LIST,ifte(size(${n})==0,1,ifte(type(${n}[0])==DOM_LIST,2,ifte(${row(n)},4,1))),ifte(evalf(im(${n}))!=0,3,ifte(${row(n)},5,0))))`;
  const raw = (await giac(`[${list.map(test).join(",")}]`)).trim();
  const flags = raw.replace(/^(list)?\[|\]$/g, "").split(",").map((t) => t.trim());
  return {
    lists: new Set(list.filter((_, k) => flags[k] === "1" || flags[k] === "4")),
    matrices: new Set(list.filter((_, k) => flags[k] === "2")),
    complexVars: new Set(list.filter((_, k) => flags[k] === "3")),
    rows: new Set(list.filter((_, k) => flags[k] === "4")),
    flagged: new Set(list.filter((_, k) => flags[k] === "4" || flags[k] === "5" || flags[k] === "7")),
    functions: new Set(list.filter((_, k) => flags[k] === "6" || flags[k] === "7")),
    vectorFns: new Set(list.filter((_, k) => flags[k] === "7")),
  };
}

/** Where each command that takes a variable takes it: d(Expr,Var), deSolve(ODE,Var,depVar) … */
const VARIABLE_ARGS: Record<string, number[]> = {
  ...Object.fromEntries(
    ("d derivative nDerivative ∫ integral Σ sumSeq Π seq limit lim nInt arcLen zeros fMin fMax " +
      "nfMin nfMax polyRoots cPolyRoots tangentLine normalLine taylor series dominantTerm factor cFactor expand comDenom " +
      "propFrac completeSquare seqGen")
      .split(" ")
      .map((f) => [f, [1]]),
  ),
  impDif: [1, 2],
  deSolve: [1, 2],
};
/** The suffix of a variable renamed so a stored value doesn't reach it (x_v_). */
const FORMAL = "_v_";
/** Commands whose answer doesn't depend on the variable: a definite integral, sum, limit, sequence. */
const BOUND_VARIABLE = new Set(["Σ", "sumSeq", "Π", "seq", "seqGen", "limit", "lim", "nInt", "arcLen"]);

/**
 * A command's variable with a value stored in it (3→x, then d(x²,x)). d() takes the
 * derivative in x and then puts x's value in, so
 * d(x²,x) is 6; nDerivative() does the same. Where the answer doesn't depend on the
 * variable (∫ with limits, Σ, limit, seq) it's renamed out of the way. Any other
 * command evaluates its arguments first, so it's handed a number where a variable
 * should be, and says so rather than answering with x's value worked in. (solve,
 * cSolve, nSolve and cZeros aren't listed: Giac keeps their unknowns as names and
 * answers them correctly.)
 * x(6−x) is a call of the function x on the handheld: with x a variable it's
 * "Invalid implied multiply", and so is x(x+1).
 */
async function storedVariables(a: Ast, giac: Giac): Promise<Ast | string> {
  // A function's parameters are its own: Define g(x)=d(x²,x) is left alone.
  const head = a.k === "define" ? a.lhs : a.k === "bin" && a.op === ":=" ? a.a : a.k === "bin" && a.op === "→" ? a.b : null;
  const defined = head?.k === "call";
  // d(x²,x)|x=2: the | gives x its value.
  const given = new Set<string>();
  if (a.k === "bin" && a.op === "|")
    for (const c of conjuncts(a.b)) if (c.k === "bin" && c.op === "=" && c.a.k === "sym") given.add(c.a.name);
  const varsOf = (x: Ast | undefined): string[] =>
    !x
      ? []
      : x.k === "sym"
        ? [x.name]
        : x.k === "list"
          ? x.items.flatMap(varsOf)
          : x.k === "bin" && x.op === "=" && x.a.k === "sym"
            ? [x.a.name]
            : [];
  const varArgs = (x: Ast & { k: "call" }) => (VARIABLE_ARGS[x.f] ?? []).flatMap((i) => varsOf(x.args[i]));
  const vars = new Set<string>();
  const heads = new Set<string>();
  let selfCall = false;
  const visit = (x: Ast) => {
    if (x.k !== "call") return x;
    if (!defined) for (const v of varArgs(x)) vars.add(v);
    if (/^[A-Za-z]\w*$/.test(x.f) && !isCommand(x.f) && x.f !== "index") {
      heads.add(x.f);
      mapAst({ k: "list", items: x.args }, (y) => {
        if (y.k === "sym" && y.name === x.f) selfCall = true;
        return y;
      });
    }
    return x;
  };
  // The name being defined (Define f(x)=…, 3→a) isn't a call.
  if (head) mapAst(a.k === "define" ? a.rhs : a.k === "bin" && a.op === ":=" ? a.b : (a as { a: Ast }).a, visit);
  else mapAst(a, visit);
  if (selfCall) return "Error: Invalid implied multiply";
  const names = [...new Set([...vars, ...heads])].filter((n) => /^[A-Za-z]\w*$/.test(n));
  if (!names.length) return a;
  const test = (n: string) => `ifte(type(${n})==DOM_IDENT or type(${n})==DOM_FUNC,0,1)`;
  const raw = await giac(`[${names.map((n) => test(RENAME_IN[n] ?? n)).join(",")}]`);
  const flags = raw.replace(/^(list)?\[|\]$/g, "").split(",").map((t) => t.trim());
  const stored = new Set(names.filter((_, k) => flags[k] === "1"));
  // a(2) with a stored: an error, as on the handheld (x(x+1) above stays "Invalid implied multiply").
  if ([...heads].some((h) => stored.has(h))) return "Error: That name holds a value, not a function";
  if (![...vars].some((v) => stored.has(v))) return a;
  const formal = (v: string) => sym(`${v}${FORMAL}`);
  const rename = (x: Ast, v: string) => mapAst(x, (y) => (y.k === "sym" && y.name === v ? formal(v) : y));
  // d(x²,x)|x=2: the | gives x its value, so x is renamed throughout, the | included.
  let entry = a;
  for (const v of given) if (stored.has(v)) entry = rename(entry, v);
  let refused = false;
  const out = mapAst(entry, (x) => {
    if (x.k !== "call") return x;
    const held = varArgs(x).filter((v) => stored.has(v));
    if (!held.length) return x;
    const [e, w, ...rest] = x.args;
    if (held.length > 1 || !e || !w) {
      refused = true;
      return x;
    }
    const v = held[0]!;
    if ((x.f === "d" || x.f === "derivative") && w.k === "sym")
      return { k: "bin", op: "|", a: { ...x, args: [rename(e, v), formal(v), ...rest] }, b: { k: "bin", op: "=", a: formal(v), b: sym(v) } };
    if (x.f === "nDerivative" && w.k === "sym") return { ...x, args: [rename(e, v), { k: "bin", op: "=", a: formal(v), b: sym(v) }, ...rest] };
    // nDerivative(x²,x=2) and the bound commands: there the variable is only a name.
    const bound = BOUND_VARIABLE.has(x.f) || ((x.f === "∫" || x.f === "integral") && x.args.length >= 4) || x.f === "nDerivative";
    if (bound) return { ...x, args: [rename(e, v), rename(w, v), ...rest] };
    refused = true;
    return x;
  });
  return refused ? "Error: Expected a variable name" : out;
}

/** Giac text with no variables and no decimals: a number made of integers, roots, π, ℯ and i. */
function isExactConstant(raw: string): boolean {
  const t = raw.replace(/=[^=]*\d\.\d*[^=]*$/, "");
  if (/\d\.|[[{"=<>]/.test(t)) return false;
  const words = t.match(/[A-Za-z_]\w*/g) ?? [];
  return words.every((w) => ["sqrt", "pi", "e", "i", "exp", "ln", "sin", "cos", "tan", "atan", "asin", "acos"].includes(w));
}

/**
 * fMin and fMax are global on the handheld: the least (greatest) value over
 * the domain, which may be at an end of an interval or at ±∞, with every
 * place it's reached. fMin(x³−6x²+9x+1,x) is x=−∞; with |0≤x≤4 it is
 * x=0 or x=3. Functions with parameters are left to the general path.
 *
 * The domain is the interval the condition gives, cut to where the function
 * is real (its implied domain): fMax(ln(x)/x,x) is x=ℯ, since ln(x)/x only
 * exists for x>0 and falls to −∞ at 0; fMin(√(x−1),x) is x=1. A pole is a
 * place too: fMin(1/x,x) is x=0, where 1/x falls to −∞ from the left.
 */
async function globalExtremum(a: Ast, giac: Giac, settings: Settings): Promise<Ast | null> {
  const [call, cond] = a.k === "bin" && a.op === "|" ? [a.a, a.b] : [a, undefined];
  if (!(call.k === "call" && (call.f === "fMin" || call.f === "fMax") && call.args.length === 2)) return null;
  const [fx, xv] = call.args;
  if (!fx || xv?.k !== "sym") return null;
  const t = (x: Ast) => translate(x, settings).giac;
  const F = t(fx);
  const X = t(xv);
  // The domain from the condition: a≤x≤b, x>a and x<b, in any mix.
  let lo: Bound | null = null;
  let hi: Bound | null = null;
  let loAst: Ast | null = null;
  let hiAst: Ast | null = null;
  const bound = (r: Ast): boolean => {
    if (r.k !== "bin") return false;
    if (r.op === "and") return bound(r.a) && bound(r.b);
    if (!["<", ">", "≤", "≥"].includes(r.op)) return false;
    // A chain a≤x≤b parses as (a≤x)≤b.
    if (r.a.k === "bin" && ["<", "≤"].includes(r.a.op) && r.a.b.k === "sym" && r.a.b.name === xv.name && ["<", "≤"].includes(r.op)) {
      lo = { v: t(r.a.a), closed: r.a.op === "≤" };
      hi = { v: t(r.b), closed: r.op === "≤" };
      [loAst, hiAst] = [r.a.a, r.b];
      return true;
    }
    const isX = (y: Ast) => y.k === "sym" && y.name === xv.name;
    const [other, upper] = isX(r.a) ? [r.b, ["<", "≤"].includes(r.op)] : isX(r.b) ? [r.a, [">", "≥"].includes(r.op)] : [null, false];
    if (!other) return false;
    const end = { v: t(other), closed: r.op === "≤" || r.op === "≥" };
    if (upper) [hi, hiAst] = [end, other];
    else [lo, loAst] = [end, other];
    return true;
  };
  if (cond && !bound(cond)) return null;
  const num = async (e: string): Promise<number> => {
    // A piecewise worked out at a point can print exact=decimal (3/8=0.375): the decimal is the value.
    const r = (await giac(`evalf(${e})`)).trim().replace(/^[^=<>]+=(?=[-+]?[\d.]+(e[-+]?\d+)?$)/, "");
    if (r === "+infinity") return Infinity;
    if (r === "-infinity") return -Infinity;
    // Unsigned infinity (ln(x)/x at 0, √(x−1) at −∞) is no real value: nothing to compare.
    const n = Number(r);
    return Number.isFinite(n) ? n : NaN;
  };
  const sign = call.f === "fMin" ? 1 : -1;
  const L = lo as Bound | null;
  const H = hi as Bound | null;
  const [loN, hiN] = [L ? await num(L.v) : -Infinity, H ? await num(H.v) : Infinity];
  if (Number.isNaN(loN) || Number.isNaN(hiN)) return null;
  // A user's function is worked out first so its domain and pieces show.
  let whole = fx;
  if (containsUserCall(fx)) {
    const ex = await evaluate(print(fx), giac, { settings });
    if (ex.ok) whole = ex.output;
  }
  // A domain with a parameter in it (√(x−a): x≥a) is left to the general path too.
  // Inside a numeric interval it is false: the interval searched, max(0,a)≤x≤5 for
  // fMin(√(x−a),x)|0≤x≤5, then has a parameter end, and the handheld answers false
  // for one (fMax(x*(k−x),x)|0<x<k). Giac throws on these, uncatchably.
  const box = { L, H, loN, hiN };
  const pieces = await realPieces(t(whole), X, box, giac, num);
  if (!pieces && cond && freeNames(whole).some((n) => n !== xv.name)) return sym("false");
  if (!pieces?.length) return null;
  const inside = (x: number) =>
    pieces.some((p) => (x > p.loN && x < p.hiN) || (x === p.loN && !!p.L?.closed) || (x === p.hiN && !!p.H?.closed));
  // A piece of a piecewise that is constant over part of the interval (4 for x>2 in
  // piecewise(-x,x<0,x^2,0≤x≤2,4,x>2) on −3≤x≤3) reaches its value everywhere there,
  // so it is one candidate, an interval. f′=0 all along it, and the points solve
  // finds there are samples of it, not places of their own.
  // (Not with a parameter in f: a branch x/k can't be compared with a flat 0.)
  const flats = cond && freeNames(whole).every((n) => n === xv.name) ? await flatPieces(whole, xv.name, box, settings, num) : [];
  const onFlat = (x: number) => flats.some((f) => x >= f.loN && x <= f.hiN);
  const cands: { at: string; value: number }[] = [];
  // The ends of each piece, open ones too (the handheld reports x=1 for x>1),
  // unless the function isn't real there (x·ln(x) at x=−2). At a pole the value
  // is the one-sided limit from inside: sin(3x)−1/(x−π/6)² on [−π/6,π/6) goes
  // to −∞ at π/6, so its max is x=−π/6, not π/6 (Giac's subst gives unsigned infinity).
  const ends: { at: string; value: number }[] = [];
  for (const p of pieces) {
    // Unbounded sides: the limit at ±∞.
    if (!p.L) ends.push({ at: "-inf", value: await num(`limit(${F},${X},-inf)`) });
    if (!p.H) ends.push({ at: "inf", value: await num(`limit(${F},${X},inf)`) });
    for (const [end, dir] of [[p.L, 1], [p.H, -1]] as const) {
      if (!end) continue;
      let value = await num(`subst(${F},${X},${end.v})`);
      if (!Number.isFinite(value)) value = await num(`limit(${F},${X},${end.v},${dir})`);
      ends.push({ at: end.v, value });
    }
  }
  const answer = async (xs: string[]) => {
    const keyed = await Promise.all(xs.map(async (x) => ({ x, n: x === "-inf" ? -Infinity : x === "inf" ? Infinity : await num(x) })));
    keyed.sort((p, q) => p.n - q.n);
    // One place written two ways (a critical point at an end of the domain) is shown once.
    const same = (p: number, q: number) => p === q || (Number.isFinite(p) && Math.abs(p - q) <= 1e-12 * Math.max(1, Math.abs(p)));
    const once = keyed.filter((k, i) => i === 0 || !same(k.n, keyed[i - 1]!.n));
    const raw = await giac(`[${once.map((k) => `${X}=${k.x}`).join(",")}]`);
    return format(raw, { hint: "solve", vars: [xv.name], digits: settings.digits, listify: true, decimal: hasDecimalIn(a) });
  };
  // A limit of −∞ (fMin) wins outright, parameters or not.
  const unbounded = ends.filter((c) => sign * c.value === -Infinity);
  if (unbounded.length) return answer([...new Set(unbounded.map((c) => c.at))]);
  // Critical points: with a domain, through the calculator's own solve (trig's
  // general solutions are then cut to the interval); without, Giac's.
  let roots: string[];
  if (cond) {
    const sub = await evaluate(`solve(d(${print(fx)},${xv.name})=0,${xv.name})|${print(cond)}`, giac, { settings, values: true });
    if (!sub.ok) return null;
    const vals: Ast[] = [];
    const walk = (x: Ast): void => {
      if (x.k === "bin" && x.op === "or") {
        walk(x.a);
        walk(x.b);
      }
      else if (x.k === "bin" && x.op === "=" && !relational(x.b)) vals.push(x.b);
    };
    if (!(sub.output.k === "sym" && sub.output.name === "false")) walk(sub.output);
    // f′ is 0 throughout (fMax(2,x)|0≤x≤1, abs(x−1)+abs(x+1) on [−1,1]): every place is the
    // greatest and the least, and the handheld answers with the interval itself, 0≤x≤1.
    if (sub.output.k === "sym" && sub.output.name === "true") return flat(xv, L, H, loAst, hiAst);
    if (!(sub.output.k === "sym" && sub.output.name === "false") && !vals.length && !flats.length) return null;
    roots = vals.map((v) => t(v));
  } else {
    // Through evaluate() as well, so a cubic derivative can't reach Giac's exact solver (numericRoots).
    const sub = await evaluate(`solve(d(${print(fx)},${xv.name})=0,${xv.name})`, giac, { settings, values: true });
    if (!sub.ok || /\bn\d/.test(sub.outputText)) return null;
    const vals: Ast[] = [];
    const walk = (x: Ast): void => {
      if (x.k === "bin" && x.op === "or") {
        walk(x.a);
        walk(x.b);
      }
      else if (x.k === "bin" && x.op === "=" && !relational(x.b)) vals.push(x.b);
    };
    if (!(sub.output.k === "sym" && sub.output.name === "false")) walk(sub.output);
    roots = vals.map((v) => t(v));
  }
  for (const r of roots) {
    // solve can give the flat itself as a "root" in x ((1>x) for 2 on x<1): the flat stands for it.
    if (flats.length && new RegExp(`(^|[^\\w])${X.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\w]|$)`).test(r)) continue;
    const x = await num(r);
    // A critical point with a parameter in it ((a+b)/2) is left to the symbolic path.
    if (Number.isNaN(x)) return null;
    if (!inside(x) || onFlat(x)) continue;
    cands.push({ at: r, value: await num(`subst(${F},${X},${r})`) });
  }
  // Corners of abs(…) and the edges of √(…) and ln(…)'s domains, where f′ doesn't exist,
  // and the cusp of a fractional power (x^(2/3) at 0).
  const edges: Ast[] = [];
  const fraction = (e: Ast): boolean => {
    const v = e.k === "num" ? Number(e.v) : e.k === "bin" && e.op === "/" && e.a.k === "num" && e.b.k === "num" ? Number(e.a.v) / Number(e.b.v) : NaN;
    return Number.isFinite(v) && v > 0 && !Number.isInteger(v);
  };
  mapAst(fx, (y) => {
    if (y.k === "call" && ["abs", "√", "ln", "log"].includes(y.f) && y.args[0]) edges.push(y.args[0]);
    if (y.k === "call" && y.f === "root" && y.args[0]) edges.push(y.args[0]);
    if (y.k === "bin" && y.op === "^" && fraction(y.b)) edges.push(y.a);
    return y;
  });
  for (const inner of edges) {
    const sub = await evaluate(`solve(${print(inner)}=0,${xv.name})${cond ? `|${print(cond)}` : ""}`, giac, { settings, values: true });
    if (!sub.ok) continue;
    const vals: Ast[] = [];
    const walk = (x: Ast): void => {
      if (x.k === "bin" && x.op === "or") {
        walk(x.a);
        walk(x.b);
      }
      else if (x.k === "bin" && x.op === "=") vals.push(x.b);
    };
    walk(sub.output);
    for (const v of vals) {
      const at = t(v);
      const x = await num(at);
      // An edge at an open end (ln(x) at 0) is that end, worked out from inside.
      if (Number.isNaN(x) || !inside(x)) continue;
      cands.push({ at, value: await num(`subst(${F},${X},${at})`) });
    }
  }
  // Where the pieces of a piecewise meet (the top of piecewise(x,x<1,2−x,x≥1) is x=1).
  const joins: Ast[] = [];
  const meets = (c: Ast): void => {
    if (c.k !== "bin") return;
    if (c.op === "and" || c.op === "or") return (meets(c.a), meets(c.b));
    if (!["<", ">", "≤", "≥"].includes(c.op)) return;
    if (c.a.k === "bin" && ["<", ">", "≤", "≥"].includes(c.a.op)) return (meets(c.a), meets({ k: "bin", op: c.op, a: c.a.b, b: c.b }));
    if (c.a.k === "sym" && c.a.name === xv.name) joins.push(c.b);
    else if (c.b.k === "sym" && c.b.name === xv.name) joins.push(c.a);
  };
  mapAst(whole, (y) => {
    if (y.k === "call" && y.f === "piecewise") for (let i = 1; i < y.args.length; i += 2) meets(y.args[i]!);
    if (y.k === "bin" && y.op === "|") meets(y.b);
    return y;
  });
  for (const j of joins) {
    const at = t(j);
    const x = await num(at);
    if (Number.isNaN(x) || !inside(x)) continue;
    cands.push({ at, value: await num(`subst(${F},${X},${at})`) });
  }
  cands.push(...ends);
  const real = cands.filter((c) => !Number.isNaN(c.value));
  if (!real.length) return null;
  const best = Math.min(...real.map((c) => sign * c.value), ...flats.map((f) => sign * f.value));
  const tol = Number.isFinite(best) ? 1e-9 * Math.max(1, Math.abs(best)) : 0;
  const wins = (v: number) => (Number.isFinite(best) ? Math.abs(sign * v - best) <= tol : sign * v === best);
  const winners = real.filter((c) => wins(c.value));
  const level = flats.filter((f) => wins(f.value));
  if (!level.length) return answer([...new Set(winners.map((c) => c.at))]);
  // The greatest value is reached on a flat piece: the answer is that interval, closed at an
  // end that is a winning place too. For piecewise(-x,x<0,x^2,0≤x≤2,4,x>2) on −3≤x≤3 that is
  // 2, where x² reaches 4, so 2≤x≤3; points elsewhere stay x=….
  const points: { n: number; e: Ast }[] = [];
  for (const c of winners) {
    const n = c.at === "-inf" ? -Infinity : c.at === "inf" ? Infinity : await num(c.at);
    const f = level.find((p) => n >= p.loN && n <= p.hiN);
    if (f) {
      if (n === f.loN && f.L) f.L = { ...f.L, closed: true };
      if (n === f.hiN && f.H) f.H = { ...f.H, closed: true };
    } else if (!points.some((p) => p.n === n)) points.push({ n, e: { k: "bin", op: "=", a: xv, b: await shown(c.at) } });
  }
  for (const f of level) {
    const end = async (b: Bound | null, n: number) => ({ at: b ? await shown(b.v) : sym(n < 0 ? "-∞" : "∞"), closed: !!b?.closed });
    points.push({ n: f.loN, e: interval(await end(f.L, f.loN), await end(f.H, f.hiN), xv) });
  }
  points.sort((p, q) => p.n - q.n);
  return points.map((p) => p.e).reduce((p, q) => ({ k: "bin", op: "or", a: p, b: q }));
  async function shown(v: string): Promise<Ast> {
    return format(await giac(v), { hint: "plain", digits: settings.digits, decimal: hasDecimalIn(a) });
  }
}

/**
 * The pieces of a piecewise f that don't depend on x, cut to the interval
 * `box`, each with its value: for piecewise(-x,x<0,x^2,0≤x≤2,4,x>2) on
 * −3≤x≤3, 4 on 2<x≤3. Giac keeps the first branch whose condition holds and
 * writes the last as "otherwise" (piecewise(-x,x<0,x^2,0≤x≤2,4)), so each
 * branch's place is its condition less the earlier ones'. Conditions must be
 * intervals in x.
 */
async function flatPieces(f: Ast, x: string, box: Piece, settings: Settings, num: (e: string) => Promise<number>): Promise<(Piece & { value: number })[]> {
  if (!(f.k === "call" && f.f === "piecewise")) return [];
  type End = { n: number; b: Bound | null };
  type Span = { lo: End; hi: End };
  const closed = (e: End) => !!e.b?.closed;
  // [lo,hi] less `cut`, as zero, one or two spans.
  const less = (s: Span, cut: Span): Span[] => {
    const apart = cut.hi.n < s.lo.n || cut.lo.n > s.hi.n || (cut.hi.n === s.lo.n && !(closed(cut.hi) && closed(s.lo))) || (cut.lo.n === s.hi.n && !(closed(cut.lo) && closed(s.hi)));
    if (apart) return [s];
    const out: Span[] = [];
    const flip = (e: End): End => ({ n: e.n, b: e.b && { ...e.b, closed: !e.b.closed } });
    if (s.lo.n < cut.lo.n || (s.lo.n === cut.lo.n && closed(s.lo) && !closed(cut.lo))) out.push({ lo: s.lo, hi: flip(cut.lo) });
    if (cut.hi.n < s.hi.n || (cut.hi.n === s.hi.n && closed(s.hi) && !closed(cut.hi))) out.push({ lo: flip(cut.hi), hi: s.hi });
    return out;
  };
  const whole: Span = { lo: { n: box.loN, b: box.L }, hi: { n: box.hiN, b: box.H } };
  const earlier: Span[] = [];
  const out: (Piece & { value: number })[] = [];
  for (let k = 0; k < f.args.length; k += 2) {
    const [body, when] = [f.args[k]!, f.args[k + 1]];
    let own: Span = whole;
    if (when) {
      const d = domainOf(when, x, settings);
      if (!d) return [];
      const lo = d.lo ? { n: await num(d.lo.v), b: d.lo } : { n: -Infinity, b: null };
      const hi = d.hi ? { n: await num(d.hi.v), b: d.hi } : { n: Infinity, b: null };
      if (Number.isNaN(lo.n) || Number.isNaN(hi.n)) return [];
      own = { lo, hi };
    }
    // The condition cut to the box (the tighter end on each side), less the earlier conditions.
    let spans: Span[] = [
      {
        lo: own.lo.n > whole.lo.n || (own.lo.n === whole.lo.n && !closed(own.lo)) ? own.lo : whole.lo,
        hi: own.hi.n < whole.hi.n || (own.hi.n === whole.hi.n && !closed(own.hi)) ? own.hi : whole.hi,
      },
    ];
    for (const e of earlier) spans = spans.flatMap((sp) => less(sp, e));
    earlier.push(own);
    if (freeNames(body).length) continue;
    const value = await num(translate(body, settings).giac);
    if (!Number.isFinite(value)) continue;
    // A single point (x=2 between x<2 and x>2) is a place like any other, not a piece.
    for (const sp of spans) if (sp.lo.n < sp.hi.n) out.push({ L: sp.lo.b, H: sp.hi.b, loN: sp.lo.n, hiN: sp.hi.n, value });
  }
  return out;
}

/** The variables in an expression, constants (π, ℯ, i, ∞) left out. */
function freeNames(e: Ast): string[] {
  const names = new Set<string>();
  mapAst(e, (y) => {
    if (y.k === "sym" && !CONSTANT_NAMES.has(y.name)) names.add(y.name);
    return y;
  });
  return [...names];
}

/**
 * d(f(x),x)|x=c where f is a piecewise: the handheld gives the derivative
 * only where there is one. d(piecewise(ℯ^x,x<0,1-x,x≥0),x)|x=0 is undef
 * on the handheld (the slopes either side are 1 and −1),
 * while d(piecewise(x^2,x<1,2x-1,x≥1),x)|x=1 is 2 (on the handheld too,
 * slope 2 on both sides). Giac differentiates the branch that holds at c and
 * gave −1. So at a break point f′(c) is undef unless f is continuous there and
 * f′'s one-sided limits agree; then, and away from the break points, the
 * usual path answers. With a parameter in the limits (a·x+b) it can't tell.
 */
async function breakDerivative(a: Ast, giac: Giac, settings: Settings): Promise<EvalResult | null> {
  if (!(a.k === "bin" && a.op === "|" && a.a.k === "call" && a.a.f === "d" && a.a.args.length === 2)) return null;
  const [E, xv] = a.a.args as [Ast, Ast];
  const c = a.b;
  if (!(xv.k === "sym" && c.k === "bin" && c.op === "=" && c.a.k === "sym" && c.a.name === xv.name)) return null;
  const t = (x: Ast) => translate(x, settings).giac;
  const [F, X, C] = [t(E), t(xv), t(c.b)];
  if (!(await giac(F)).includes("piecewise")) return null;
  // Limits only: subst of a piecewise where no case applies throws.
  const raw = (await giac(`evalf([limit(diff(${F},${X}),${X},${C},-1),limit(diff(${F},${X}),${X},${C},1),limit(${F},${X},${C},-1),limit(${F},${X},${C},1)])`)).trim();
  const parts = raw.replace(/^(list)?\[|\]$/g, "").split(",").map((p) => p.trim());
  if (parts.length !== 4 || parts.some((p) => /[a-z]/i.test(p.replace(/^[-+]?infinity$|^undef$/, "")))) return null;
  const [l, r, fl, fr] = parts.map(Number) as [number, number, number, number];
  const same = (p: number, q: number) => Number.isFinite(p) && Number.isFinite(q) && Math.abs(p - q) <= 1e-9 * Math.max(1, Math.abs(p), Math.abs(q));
  if (same(l, r) && same(fl, fr)) return null;
  return { ok: true, input: a, output: sym("undef"), outputText: "undef" };
}

/** The interval a condition gives, written as the handheld writes it: 0≤x≤1, x≥0. */
function flat(x: Ast, L: Bound | null, H: Bound | null, lo: Ast | null, hi: Ast | null): Ast | null {
  const lower: Ast | null = L && lo ? { k: "bin", op: L.closed ? "≤" : "<", a: lo, b: x } : null;
  if (lower && H && hi) return { k: "bin", op: H.closed ? "≤" : "<", a: lower, b: hi };
  if (lower) return { k: "bin", op: L!.closed ? "≥" : ">", a: x, b: lo! };
  if (H && hi) return { k: "bin", op: H.closed ? "≤" : "<", a: x, b: hi };
  return null;
}

type Bound = { v: string; closed: boolean };
type Piece = { L: Bound | null; H: Bound | null; loN: number; hiN: number };

/**
 * The interval `box` cut to where the function W (Giac text) is real, as
 * pieces: Giac's domain() gives x>0 for ln(x)/x, x≠0 (two pieces) for 1/x,
 * [x≤−2, 2≤x<5] for √(x²−4)+ln(5−x). Null when an end has a parameter in it.
 * The box stays whole for a periodic function, whose domain Giac gives over
 * one period only (domain(√(sin(x)),x) is 0≤x≤π).
 * x^(2/3) is real for x<0 on the handheld, so a power with an odd
 * denominator keeps the box whole as well.
 */
async function realPieces(W: string, X: string, box: Piece, giac: Giac, num: (e: string) => Promise<number>): Promise<Piece[] | null> {
  if (/\b(sin|cos|tan|sec|csc|cot)\(/.test(W) || /\^\(-?\d+\/\d*[13579]\)/.test(W)) return [box];
  const raw = (await giac(`domain(${W},${X})`)).trim();
  if (raw === X) return [box];
  const depth0 = (s: string, sep: string): string[] => {
    const out: string[] = [];
    let d = 0;
    let start = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === "(" || c === "[") d++;
      else if (c === ")" || c === "]") d--;
      else if (d === 0 && s.startsWith(sep, i)) {
        out.push(s.slice(start, i));
        start = i + sep.length;
      }
    }
    out.push(s.slice(start));
    return out.map((p) => p.trim());
  };
  // The first bracket closes at the last character: ((x>=-2) and (x<=2)), [x<0,x>0].
  const wrapped = (s: string): boolean => {
    let d = 0;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === "(" || s[i] === "[") d++;
      else if (s[i] === ")" || s[i] === "]") d--;
      if (d === 0) return i > 0 && i === s.length - 1;
    }
    return false;
  };
  const bare = (s: string): string => {
    let r = s.trim();
    while (wrapped(r)) r = r.slice(1, -1).trim();
    return r;
  };
  const pieces: Piece[] = [];
  const name = X.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const xFirst = new RegExp(`^${name}(>=|<=|<>|>|<)(.+)$`);
  const xLast = new RegExp(`^(.+?)(>=|<=|<>|>|<)${name}$`);
  const flip: Record<string, string> = { ">": "<", "<": ">", ">=": "<=", "<=": ">=", "<>": "<>" };
  for (const part of depth0(bare(raw), ",")) {
    let lo = { b: box.L, n: box.loN };
    let hi = { b: box.H, n: box.hiN };
    const holes: { v: string; n: number }[] = [];
    for (const atom of depth0(bare(part), " and ").map(bare)) {
      const m = xFirst.exec(atom);
      const r = m ? null : xLast.exec(atom);
      if (!m && !r) return [box];
      const [op, v] = m ? [m[1]!, m[2]!.trim()] : [flip[r![2]!]!, r![1]!.trim()];
      const n = await num(v);
      if (!Number.isFinite(n)) return null;
      const closed = op === ">=" || op === "<=";
      if (op === "<>") holes.push({ v, n });
      // The tighter end wins; at the same place, the open one.
      else if (op[0] === ">" && (n > lo.n || (n === lo.n && !closed))) lo = { b: { v, closed }, n };
      else if (op[0] === "<" && (n < hi.n || (n === hi.n && !closed))) hi = { b: { v, closed }, n };
    }
    // Split at the holes inside: each side of x≠0 is a piece of its own, open there.
    const cuts = [...new Map(holes.filter((h) => h.n > lo.n && h.n < hi.n).map((h) => [h.n, h])).values()].sort((p, q) => p.n - q.n);
    const stops = [lo, ...cuts.map((h) => ({ b: { v: h.v, closed: false }, n: h.n })), hi];
    for (let i = 0; i + 1 < stops.length; i++) {
      const [s, e] = [stops[i]!, stops[i + 1]!];
      // Closed ends that sit on a hole (x≥0 and x≠0) open.
      const opened = (b: Bound | null, n: number) => (b && holes.some((h) => h.n === n) ? { ...b, closed: false } : b);
      const piece = { L: opened(s.b, s.n), H: opened(e.b, e.n), loN: s.n, hiN: e.n };
      if (piece.loN < piece.hiN || (piece.loN === piece.hiN && piece.L?.closed && piece.H?.closed)) pieces.push(piece);
    }
  }
  return pieces;
}

/** A call to a function the user defined (f(x)), not one of the handheld's. */
function containsUserCall(a: Ast): boolean {
  let found = false;
  mapAst(a, (y) => {
    if (y.k === "call" && !isCommand(y.f)) found = true;
    return y;
  });
  return found;
}

/** A condition rather than a value: solve of a piecewise's derivative can answer x=(0>x). */
function relational(a: Ast): boolean {
  let found = false;
  mapAst(a, (y) => {
    if ((y.k === "bin" && ["<", ">", "≤", "≥", "≠", "=", "and", "or"].includes(y.op)) || y.k === "not") found = true;
    return y;
  });
  return found;
}

function hasDecimalIn(a: Ast): boolean {
  let found = false;
  mapAst(a, (x) => {
    if (x.k === "num" && /[.E]/.test(x.v)) found = true;
    return x;
  });
  return found;
}

async function readCounters(giac: Giac): Promise<{ c: number; n: number }> {
  const raw = (await giac("cas_cnt_")).trim();
  const m = /^\[(\d+),(\d+)\]$/.exec(raw.replace(/\s/g, ""));
  return m ? { c: Number(m[1]), n: Number(m[2]) } : { c: 0, n: 0 };
}

/** The command under a "|". */
function core(a: Ast): Ast {
  return a.k === "bin" && a.op === "|" ? a.a : a;
}

/** The numeric bases of the input's logs ("10" for log(x)), or null when it has no log. */
function logBases(a: Ast): Set<string> | null {
  let found: Set<string> | null = null;
  mapAst(a, (x) => {
    if (x.k === "call" && x.f === "log") {
      found ??= new Set();
      const b = x.args[1];
      if (!b) found.add("10");
      else if (b.k === "num" && /^\d+$/.test(b.v)) found.add(b.v);
    }
    return x;
  });
  return found;
}

/**
 * ln(a)/ln(b) of numbers → log(a,b), and log(a) for base 10, which the
 * handheld writes without its base. Multiples stay outside the log, as the
 * handheld writes log(16,10) as 4·log(2) and 27·ln(2)/(8·ln(3)) as
 * 27·log(2,3)/8. The one exception is a base the input itself used, which
 * canonical() wrote as a multiple: log(7,4) comes back as ln(7)/(2·ln(2))
 * and is put back together as log(7,4), not log(7,2)/2.
 */
function logBase(x: Ast, bases: Set<string>): Ast {
  if (!(x.k === "bin" && x.op === "/")) return x;
  if (x.a.k === "neg") {
    const pos = logBase({ ...x, a: x.a.a }, bases);
    return pos === x ? x : { k: "neg", a: pos };
  }
  const part = (y: Ast): { k: bigint; arg: Ast } | null => {
    if (y.k === "call" && y.f === "ln" && y.args[0] && isRationalNum(y.args[0])) return { k: 1n, arg: y.args[0] };
    if (y.k === "bin" && y.op === "*" && y.a.k === "num" && /^\d+$/.test(y.a.v)) {
      const inner = part(y.b);
      return inner && inner.k === 1n ? { k: BigInt(y.a.v), arg: inner.arg } : null;
    }
    return null;
  };
  const [top, bottom] = [part(x.a), part(x.b)];
  if (!top || !bottom || bottom.arg.k !== "num" || !/^\d+$/.test(bottom.arg.v)) return x;
  let [base, mult, div] = [BigInt(bottom.arg.v), top.k, bottom.k];
  if (base < 2n) return x;
  // The largest power base^j of the input's bases that the multiple allows.
  let best = 1n;
  for (const b of bases) {
    let [p, j] = [base, 1n];
    while (p < BigInt(b)) [p, j] = [p * base, j + 1n];
    if (p === BigInt(b) && div % j === 0n && j > best) best = j;
  }
  [base, div] = [base ** best, div / best];
  const g = gcdOf(mult, div);
  [mult, div] = [mult / g, div / g];
  const log: Ast = { k: "call", f: "log", args: base === 10n ? [top.arg] : [top.arg, { k: "num", v: base.toString() }] };
  const numer: Ast = mult === 1n ? log : { k: "bin", op: "*", a: { k: "num", v: mult.toString() }, b: log };
  return div === 1n ? numer : { k: "bin", op: "/", a: numer, b: { k: "num", v: div.toString() } };
}

const gcdOf = (m: bigint, n: bigint): bigint => (n === 0n ? m : gcdOf(n, m % n));

const isRationalNum = (a: Ast): boolean =>
  (a.k === "num" && /^\d+$/.test(a.v)) || (a.k === "bin" && a.op === "/" && a.a.k === "num" && a.b.k === "num" && /^\d+$/.test(a.a.v + a.b.v));

const ROOT_COMMANDS = new Set(["solve", "cSolve", "zeros", "cZeros", "polyRoots", "cPolyRoots"]);

/**
 * Giac's exact solver aborts on some cubics (2x³+3x²+3=0: "rootof minimal
 * polynomial must be unitary"), and the engine is broken afterwards. The
 * handheld answers those roots in decimals anyway, so a polynomial in one
 * variable with an irreducible factor of degree 3 or more is solved from
 * its decimal form. Kept exact: x³=2 (two terms) and even quartics.
 */
async function numericRoots(a: Ast, giac: Giac, settings: Settings): Promise<Ast> {
  const call = a.k === "bin" && a.op === "|" ? a.a : a;
  if (!(call.k === "call" && ROOT_COMMANDS.has(call.f) && call.args[0])) return a;
  const [e, v] = call.args;
  const name = v?.k === "sym" ? v.name : !v ? "x" : null;
  if (!name || (e.k === "bin" && e.op === "and")) return a;
  if (e.k === "bin" && e.op in INEQ) return a;
  // Already in decimals (this function's own rewrite): leave it, or it would wrap itself forever.
  let decimal = false;
  mapAst(e, (y) => {
    if (y.k === "call" && y.f === "approx") decimal = true;
    return y;
  });
  if (decimal) return a;
  const expr: Ast = e.k === "bin" && e.op === "=" ? { k: "bin", op: "-", a: e.a, b: e.b } : e;
  if (!(await riskyPoly(expr, name, giac, settings))) return a;
  const approx = (x: Ast): Ast => ({ k: "call", f: "approx", args: [x] });
  const numeric: Ast =
    call.f === "polyRoots" || call.f === "cPolyRoots"
      ? { k: "call", f: call.f === "polyRoots" ? "zeros" : "cZeros", args: [approx(expr), sym(name)] }
      : { ...call, args: [e.k === "bin" && e.op === "=" ? { k: "bin", op: "=", a: approx(expr), b: { k: "num", v: "0" } } : approx(e), ...call.args.slice(1)] };
  return a.k === "bin" && a.op === "|" ? { ...a, a: numeric } : numeric;
}

/** solve(p(x) op k, x) where p−k is a polynomial with a factor Giac's exact solver aborts on. */
async function riskyInequality(a: Ast, giac: Giac, settings: Settings): Promise<boolean> {
  const call = a.k === "bin" && a.op === "|" ? a.a : a;
  if (!(call.k === "call" && call.f === "solve" && call.args.length === 2)) return false;
  const [body, v] = call.args;
  if (!body || v?.k !== "sym") return false;
  // Each relation of a compound inequality too: Giac's exact solver aborts on any of them.
  const rels = conjuncts(body);
  if (!rels.some((r) => r.k === "bin" && r.op in INEQ)) return false;
  for (const rel of rels) {
    if (rel.k !== "bin" || !(rel.op in INEQ || rel.op === "=")) return false;
    if (await riskyPoly({ k: "bin", op: "-", a: rel.a, b: rel.b }, v.name, giac, settings)) return true;
  }
  return false;
}

/** A polynomial in one variable with an irreducible factor of degree 3+ that isn't x^n+c or an even quartic. */
async function riskyPoly(expr: Ast, name: string, giac: Giac, settings: Settings): Promise<boolean> {
  const E = translate(expr, settings).giac;
  const X = RENAME_IN[name] ?? name;
  const raw = (
    await giac(
      `ifte(lvar(${E})==[${X}],(L_->[seq([degree(L_[2*k_],${X}),size(select(c_->c_!=0,coeff(L_[2*k_],${X}))),normal(L_[2*k_]-subst(L_[2*k_],${X},-${X}))==0],k_,0,size(L_)/2-1)])(factors(${E})),[])`,
    )
  ).replace(/\s/g, "");
  const facts = [...raw.matchAll(/\[(\d+),(\d+),(true|false|1|0)\]/g)].map((m) => ({ d: Number(m[1]), terms: Number(m[2]), even: m[3] === "true" || m[3] === "1" }));
  // z⁷=1 (two terms in all) stays exact even though z⁶+z⁵+…+1 is irreducible: its roots are ℯ^(2kπi/7).
  const terms = Number((await giac(`size(select(c_->c_!=0,coeff(${E},${X})))`)).trim());
  if (terms === 2) return false;
  // Nor is c·(x−s)ⁿ+k, two terms once shifted: 5000·(1+r/1200)⁶⁰=6500 has the roots
  // 1200·(±1.3^(1/60))−1200, which Giac's exact solver finds and proot, at degree 60, doesn't
  // (it gave r=−77.782 beside 5.25877, and no −2405.26).
  if (facts.some((f) => f.d >= 3)) {
    const shifted = Number(
      (
        await giac(
          // A polynomial only: coeff of a fraction (8t/(240+5t⁴)'s derivative) throws, uncatchably.
          `ifte(lvar(${E})==[${X}],ifte(degree(denom(normal(${E})),${X})==0,(n_->size(select(c_->c_!=0,coeff(normal(subst(${E},${X},${X}-coeff(${E},${X},n_-1)/(n_*coeff(${E},${X},n_)))),${X}))))(degree(${E},${X})),0),0)`,
        )
      ).trim(),
    );
    if (shifted === 2) return false;
  }
  return facts.some((f) => f.d >= 3 && f.terms >= 3 && !(f.d === 4 && f.even));
}

/** Drop solutions whose value breaks the "|" conditions (0≤x≤2π and the like). */
async function inDomain(out: Ast, cond: Ast, v: string, giac: Giac, settings: Settings): Promise<Ast> {
  const ineq = (c: Ast): boolean => c.k === "bin" && (["<", ">", "≤", "≥", "≠"].includes(c.op) || (c.op === "and" && ineq(c.a) && ineq(c.b)));
  if (!ineq(cond)) return out;
  // On a fresh name: x itself still carries the assumption the "|" made, under which 0≤x is just true.
  const C = translate(mapAst(cond, (y) => (y.k === "sym" && y.name === v ? sym("dom_") : y)), settings).giac;
  const X = "dom_";
  const keep = async (s: Ast): Promise<boolean> => {
    if (!(s.k === "bin" && s.op === "=" && s.a.k === "sym" && s.a.name === v)) return true;
    // Only decimals: exact answers came through Giac's own assumption.
    let dec = false;
    mapAst(s.b, (y) => {
      if (y.k === "num" && /[.E]/.test(y.v)) dec = true;
      return y;
    });
    if (!dec) return true;
    // The answer is shown to 6 digits: 12.5664 for 4π sits just past ≤4π, so allow for the rounding.
    const val = translate(s.b, settings).giac;
    // An exact 0 (0. from a numeric solve) was not rounded: no allowance, so 0<t excludes it.
    const zero = Math.abs(Number((await giac(`evalf(${val})`)).trim())) < 1e-12;
    for (const at of zero ? [val] : [val, `(${val})*(1-5e-6)`, `(${val})*(1+5e-6)`, `(${val})-5e-6`, `(${val})+5e-6`]) {
      const r = (await giac(`evalb(evalf(subst(${C},${X}=${at})))`)).trim();
      if (r !== "false" && r !== "0") return true;
    }
    return false;
  };
  const items: Ast[] = [];
  const walk = (x: Ast): void => {
    if (x.k === "bin" && x.op === "or") {
        walk(x.a);
        walk(x.b);
      }
    else items.push(x);
  };
  walk(out);
  const kept: Ast[] = [];
  for (const s of items) if (await keep(s)) kept.push(s);
  if (kept.length === items.length) return out;
  return kept.length ? kept.reduce((acc, x) => ({ k: "bin", op: "or", a: acc, b: x })) : sym("false");
}

async function nSolveRange(a: Ast, giac: Giac, settings: Settings): Promise<string | null> {
  const call = a.k === "bin" && a.op === "|" ? a.a : a;
  if (!(call.k === "call" && call.f === "nSolve" && call.args.length >= 4)) return null;
  const [eq, v, lo, hi] = call.args;
  if (!eq || v?.k !== "sym" || !lo || !hi) return null;
  const [L, R] = eq.k === "bin" && eq.op === "=" ? [eq.a, eq.b] : [eq, { k: "num" as const, v: "0" }];
  const X = RENAME_IN[v.name] ?? v.name;
  const t = (x: Ast) => `subst(${translate(x, settings).giac},${X},x_)`;
  const [a0, b0] = [Number(await giac(`evalf(${translate(lo, settings).giac})`)), Number(await giac(`evalf(${translate(hi, settings).giac})`))];
  if (!Number.isFinite(a0) || !Number.isFinite(b0)) return null;
  const x = await rootIn(giac, `${t(L)}=${t(R)}`, a0, b0);
  return Number.isFinite(x) ? `[${x}]` : null;
}

async function realRootsOnly(a: Ast, raw: string, giac: Giac, settings: Settings): Promise<string> {
  const call = a.k === "bin" && a.op === "|" ? a.a : a;
  if (!(call.k === "call" && call.f === "nSolve" && call.args[0] && call.args[1]?.k === "sym")) return raw;
  const eq = call.args[0];
  const [L, R] = eq.k === "bin" && eq.op === "=" ? [eq.a, eq.b] : [eq, { k: "num" as const, v: "0" }];
  const X = RENAME_IN[call.args[1].name] ?? call.args[1].name;
  const values = splitTop(raw.trim().replace(/^(list)?\[|\]$/g, "")).filter((v) => /\d/.test(v));
  if (!values.length) return raw;
  const kept: string[] = [];
  for (const v of values) {
    // Judged against the terms' size: 300000·1.005ⁿ−500000·(1.005ⁿ−1)=0 is 1E−6 off at its 12-digit root.
    const { gap, size } = await residual(L, R, X, v, giac, settings);
    if (gap <= 1e-7 * size) kept.push(v);
  }
  return `[${kept.join(",")}]`;
}

const NOT_VARIABLES = new Set(["pi", "e", "i", "inf", "infinity", "undef", "true", "false", "and", "or", "not", "xor"]);

/**
 * True if two Giac answers have the same value: compared in decimals
 * (complex values too, lists element by element), with every variable at
 * an arbitrary sample value. Guards each simplification step against a
 * Giac simplifier that gets the value wrong.
 */
/** A + or − outside every bracket, after the first character: Giac text that is a sum. */
function topLevelSum(raw: string): boolean {
  let depth = 0;
  for (let k = 0; k < raw.length; k++) {
    const c = raw[k]!;
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (depth === 0 && k > 0 && (c === "+" || c === "-") && !/[*/^(eE]/.test(raw[k - 1]!)) return true;
  }
  return false;
}

/**
 * Giac's expand stops at the power of a negated term: (1−2x)³ comes back as
 * (−2x)³+3(−2x)²−6x+1, and (100−10t)² as (−10t)²−2000t+10000. Each (−A)ⁿ is
 * written (−1)ⁿ·(A)ⁿ and the answer expanded again.
 */
async function negatedPowers(raw: string, giac: Giac): Promise<string> {
  if (/error/i.test(raw) || !/\(-/.test(raw)) return raw;
  let out = "";
  let changed = false;
  for (let k = 0; k < raw.length; k++) {
    if (raw[k] === "(" && raw[k + 1] === "-" && !/[\w)\]]/.test(raw[k - 1] ?? "")) {
      let depth = 0;
      let end = -1;
      let sum = false;
      for (let j = k; j < raw.length; j++) {
        const c = raw[j]!;
        if (c === "(" || c === "[") depth++;
        else if (c === ")" || c === "]") {
          if (--depth === 0) {
            end = j;
            break;
          }
        } else if (depth === 1 && j > k + 1 && (c === "+" || c === "-") && !/[*/^(eE]/.test(raw[j - 1]!)) sum = true;
      }
      const n = end > 0 ? /^\^(\d+)/.exec(raw.slice(end + 1)) : null;
      if (n && !sum) {
        out += `((-1)^${n[1]}*(${raw.slice(k + 2, end)})^${n[1]})`;
        k = end + n[0].length;
        changed = true;
        continue;
      }
    }
    out += raw[k];
  }
  if (!changed) return raw;
  const again = await giac(`expand(${out})`);
  return !/error|undef/i.test(again) && (await same(giac, raw, again)) ? again : raw;
}

async function same(giac: Giac, a: string, b: string): Promise<boolean> {
  const strip = (t: string) => t.trim().replace(/=[^=]*\d\.\d*[^=]*$/, "");
  const [A, B] = [strip(a), strip(b)];
  if (A === B) return true;
  const names = new Set<string>();
  for (const m of `${A} ${B}`.matchAll(/\b([A-Za-z]\w*)\b(?!\s*\()/g)) if (!NOT_VARIABLES.has(m[1]!)) names.add(m[1]!);
  const subs = [...names].map((n, k) => `${n}=${(0.3719 + 0.6173 * k + 0.0917 * k * k).toFixed(4)}`);
  const at = (e: string) => (subs.length ? `subst(${e},[${subs.join(",")}])` : e);
  // Each side made a decimal first: subtracting exact radicals (9^(1/4)−√3) sends Giac into exact algebra, which ran out of memory.
  const [fa, fb] = [`evalf(${at(A)})`, `evalf(${at(B)})`];
  const r = (await giac(`evalf(max(abs(flatten([(${fa})-(${fb})])))/(1+max(abs(flatten([${fa}])))))`)).trim();
  const v = Number(r.replace(/=.*$/, ""));
  return Number.isFinite(v) && v < 1e-8;
}


const INEQ = { "<": "<", ">": ">", "≤": "<=", "≥": ">=" } as const;

/**
 * solve(relations, x)|domain by signs: the real roots of each relation's
 * two sides, its breaks (zeros of a denominator, edges of √ and ln
 * domains) and the domain's ends split the line; each piece and each point
 * is tested, and the intervals where everything holds are written as the
 * handheld writes them (x<a or b<x<c, x=a for a lone point, true, false).
 */
async function inequalityBySigns(a: Ast, giac: Giac, settings: Settings): Promise<Ast | null> {
  const call = a.k === "bin" && a.op === "|" ? a.a : a;
  const cond = a.k === "bin" && a.op === "|" ? a.b : undefined;
  if (!(call.k === "call" && call.f === "solve" && call.args.length === 2)) return null;
  const [body, v] = call.args;
  if (!body || v?.k !== "sym") return null;
  const rels: Extract<Ast, { k: "bin" }>[] = [];
  const split = (x: Ast): boolean => {
    if (x.k === "bin" && x.op === "and") return split(x.a) && split(x.b);
    if (x.k === "bin" && (x.op in INEQ || x.op === "=" || x.op === "≠")) {
      // A chain 0<x≤1 is two relations.
      if (x.a.k === "bin" && x.a.op in INEQ) {
        rels.push(x.a, { ...x, a: x.a.b });
        return true;
      }
      rels.push(x);
      return true;
    }
    return false;
  };
  if (!split(body) || !rels.some((r) => r.op in INEQ)) return null;
  const name = v.name;
  const dom = cond ? domainOf(cond, name, settings) : null;
  if (cond && !dom) return null;
  const X = RENAME_IN[name] ?? name;
  const sides = rels.map((r) => `[${translate(r.a, settings).giac},${translate(r.b, settings).giac}]`);
  const [lo, hi] = [dom?.lo ? Number((await giac(`evalf(${dom.lo.v})`)).trim()) : -Infinity, dom?.hi ? Number((await giac(`evalf(${dom.hi.v})`)).trim()) : Infinity];
  /**
   * Does every relation (and the domain) hold at x? At a point found as a
   * root of some relations, those count as exactly equal there: the point
   * is a rounded decimal, so x³+4x<1 would otherwise hold at its own root.
   */
  const holds = async (x: number, rootOf: Set<number> = new Set()): Promise<boolean> => {
    if (x < lo - 1e-12 || x > hi + 1e-12 || (Math.abs(x - lo) <= 1e-12 && !dom?.lo?.closed) || (Math.abs(x - hi) <= 1e-12 && !dom?.hi?.closed)) return false;
    for (let k = 0; k < rels.length; k++) {
      const r = (await giac(`evalf(subst(${sides[k]},${X}=${x}))`)).trim();
      if (/\bi\b|undef|inf/.test(r)) return false;
      const [p, q] = r.replace(/^\[|\]$/g, "").split(",").map(Number);
      if (p === undefined || q === undefined || !Number.isFinite(p) || !Number.isFinite(q)) return false;
      const zero = rootOf.has(k) || Math.abs(p - q) <= 1e-9 * Math.max(1, Math.abs(p) + Math.abs(q));
      const op = rels[k]!.op;
      const ok = op === "<" ? p < q && !zero : op === ">" ? p > q && !zero : op === "≤" ? p <= q || zero : op === "≥" ? p >= q || zero : op === "=" ? zero : !zero;
      if (!ok) return false;
    }
    return true;
  };
  // Points where the answer can change.
  const points: { at: Ast; x: number; rootOf: Set<number> }[] = [];
  const add = async (text: string, rel?: number) => {
    const sub = await evaluate(text, giac, { settings, values: true });
    if (!sub.ok) return;
    const walk = (x: Ast): void => {
      if (x.k === "bin" && x.op === "or") {
        walk(x.a);
        walk(x.b);
      } else if (x.k === "bin" && x.op === "=") found.push(x.b);
    };
    const found: Ast[] = [];
    walk(sub.output);
    // Through Giac: numericValue doesn't know sin⁻¹ and the like, and a dropped point drops an interval.
    for (const at of found) {
      const v = Number((await giac(`evalf(${translate(at, settings).giac})`)).trim().replace(/=.*$/, ""));
      points.push({ at, x: v, rootOf: new Set(rel === undefined ? [] : [rel]) });
    }
  };
  const domText = dom?.lo && dom.hi ? `|${print(cond!)}` : "";
  for (const [k, r] of rels.entries()) await add(`solve(${print({ k: "bin", op: "-", a: r.a, b: r.b })}=0,${name})${domText}`, k);
  const breaks: Ast[] = [];
  for (const r of rels)
    mapAst(r, (y) => {
      if (y.k === "bin" && y.op === "/") breaks.push(y.b);
      if (y.k === "call" && ["√", "ln", "log"].includes(y.f) && y.args[0]) breaks.push(y.args[0]);
      // tan's poles, where cos of its argument is 0 (only findable on a bounded domain).
      if (y.k === "call" && y.f === "tan" && y.args[0] && domText) breaks.push({ k: "call", f: "cos", args: [y.args[0]] });
      return y;
    });
  for (const b of breaks) await add(`solve(${print(b)}=0,${name})${domText}`);
  const bound = (e: { v: string } | undefined, at: Ast | undefined, x: number) => (e && at && Number.isFinite(x) ? [{ at, x, rootOf: new Set<number>() }] : []);
  const ends = (c: Ast | undefined): { lo?: Ast; hi?: Ast } => {
    const out: { lo?: Ast; hi?: Ast } = {};
    const isX = (y: Ast) => y.k === "sym" && y.name === name;
    const walk = (r: Ast): void => {
      if (r.k !== "bin") return;
      if (r.op === "and") {
        walk(r.a);
        walk(r.b);
        return;
      }
      if (r.a.k === "bin" && isX(r.a.b)) {
        out.lo = r.a.a;
        out.hi = r.b;
        return;
      }
      if (isX(r.a)) {
        if (["<", "≤"].includes(r.op)) out.hi = r.b;
        else out.lo = r.b;
      } else if (isX(r.b)) {
        if ([">", "≥"].includes(r.op)) out.hi = r.a;
        else out.lo = r.a;
      }
    };
    if (c) walk(c);
    return out;
  };
  const endAst = ends(cond);
  points.push(...bound(dom?.lo, endAst.lo, lo), ...bound(dom?.hi, endAst.hi, hi));
  const pts = points.filter((p) => Number.isFinite(p.x)).sort((p, q) => p.x - q.x);
  // One point per place (merging what each relation knows about it).
  const uniq: typeof pts = [];
  for (const p of pts) {
    const same = uniq.find((u) => Math.abs(u.x - p.x) <= 1e-5 * Math.max(1, Math.abs(p.x)));
    if (same) p.rootOf.forEach((k) => same.rootOf.add(k));
    else uniq.push({ ...p, rootOf: new Set(p.rootOf) });
  }
  const xs = uniq.map((p) => p.x);
  const mids = xs.length ? [xs[0]! - 1, ...xs.slice(1).map((x, k) => (x + xs[k]!) / 2), xs.at(-1)! + 1] : [0.123];
  const seg: boolean[] = [];
  for (const m of mids) seg.push(await holds(m));
  const on: boolean[] = [];
  for (const p of uniq) on.push(await holds(p.x, p.rootOf));
  const X0 = sym(name);
  const parts: Ast[] = [];
  let start: { at: Ast; closed: boolean } | null = seg[0] ? { at: sym("-∞"), closed: false } : null;
  uniq.forEach((p, k) => {
    const [left, right, here] = [seg[k]!, seg[k + 1]!, on[k]!];
    if (left && right && here) return;
    if (left && start) {
      parts.push(interval(start, { at: p.at, closed: here }, X0));
      start = null;
    }
    if (right) start = { at: p.at, closed: here };
    else if (here && !left) parts.push({ k: "bin", op: "=", a: X0, b: p.at });
  });
  if (start) parts.push(interval(start, { at: sym("∞"), closed: false }, X0));
  if (!parts.length) return sym("false");
  return parts.reduce((acc, x) => ({ k: "bin", op: "or", a: acc, b: x }));
}

/**
 * An end of an inequality's answer where its two sides cross takes the
 * inequality's own strictness: 10000·1.04ⁿ>20000 is n>17.6729876852 on the
 * handheld, and Giac answers n≥ when the coefficients are decimals. An end
 * the sides don't cross at (x≥0 for √x>−1, where √x stops) stays as it is.
 */
async function boundaryEnds(a: Ast, answer: Ast, giac: Giac, settings: Settings): Promise<Ast> {
  const call = a.k === "bin" && a.op === "|" ? a.a : a;
  if (!(call.k === "call" && call.f === "solve" && call.args[1]?.k === "sym" && call.args[0]?.k === "bin" && call.args[0].op in INEQ)) return answer;
  const rel = call.args[0];
  const name = call.args[1].name;
  const X = RENAME_IN[name] ?? name;
  const strict = rel.op === "<" || rel.op === ">";
  const G = `(${translate(rel.a, settings).giac})-(${translate(rel.b, settings).giac})`;
  const isX = (e: Ast) => e.k === "sym" && e.name === name;
  const ORDER = ["<", ">", "≤", "≥"];
  const ends: Ast[] = [];
  mapAst(answer, (y) => {
    if (y.k !== "bin" || !ORDER.includes(y.op)) return y;
    if (isX(y.a) || (y.a.k === "bin" && ORDER.includes(y.a.op) && isX(y.a.b))) ends.push(y.b);
    else if (isX(y.b)) ends.push(y.a);
    return y;
  });
  const crossed = new Map<string, boolean>();
  for (const e of ends) {
    const x = numericValue(e);
    if (!Number.isFinite(x)) continue;
    // Either side of the end by the answer's own rounding.
    const d = 10 ** (1 - settings.digits) * Math.max(1, Math.abs(x));
    const [p, q, m] = (await giac(`evalf([subst(${G},${X}=${x - d}),subst(${G},${X}=${x + d}),subst(${G},${X}=${x})])`)).trim().replace(/^\[|\]$/g, "").split(",").map(Number);
    // A pole changes sign too ((x−1)/(x+2) at −2): the sides must meet at the end itself.
    const meet = m !== undefined && Number.isFinite(m) && Math.abs(m) <= Math.max(Math.abs(p ?? NaN), Math.abs(q ?? NaN));
    crossed.set(print(e), meet && p !== undefined && q !== undefined && Number.isFinite(p) && Number.isFinite(q) && p * q < 0);
  }
  if (![...crossed.values()].some(Boolean)) return answer;
  const take = (op: string) => (op === "<" || op === "≤" ? (strict ? "<" : "≤") : strict ? ">" : "≥");
  return mapAst(answer, (y) => {
    if (y.k !== "bin" || !ORDER.includes(y.op)) return y;
    const end = isX(y.a) || (y.a.k === "bin" && ORDER.includes(y.a.op) && isX(y.a.b)) ? y.b : isX(y.b) ? y.a : null;
    return end && crossed.get(print(end)) ? { ...y, op: take(y.op) as "<" } : y;
  });
}

/**
 * Does Giac's answer to an inequality agree with the inequality? Sampled
 * across the domain (or −50…50); an answer that can't be read as
 * intervals counts as disagreeing.
 */
async function inequalityAgrees(a: Ast, answer: Ast, giac: Giac, settings: Settings): Promise<boolean> {
  const call = a.k === "bin" && a.op === "|" ? a.a : a;
  const cond = a.k === "bin" && a.op === "|" ? a.b : undefined;
  if (!(call.k === "call" && call.args[1]?.k === "sym" && call.args[0])) return true;
  const name = call.args[1].name;
  const dom = cond ? domainOf(cond, name, settings) : null;
  const [lo, hi] = [dom?.lo ? Number((await giac(`evalf(${dom.lo.v})`)).trim()) : -50, dom?.hi ? Number((await giac(`evalf(${dom.hi.v})`)).trim()) : 50];
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return true;
  const at = (e: Ast, x: number): number => numericValue(mapAst(e, (y) => (y.k === "sym" && y.name === name ? { k: "num", v: String(x) } : y)));
  const meets = (e: Ast, x: number): boolean | null => {
    if (e.k === "sym") return e.name === "true" ? true : e.name === "false" ? false : null;
    if (e.k !== "bin") return null;
    if (e.op === "or" || e.op === "and") {
      const [p, q] = [meets(e.a, x), meets(e.b, x)];
      if (p === null || q === null) return null;
      return e.op === "or" ? p || q : p && q;
    }
    const REL: Record<string, (p: number, q: number) => boolean> = { "<": (p, q) => p < q, ">": (p, q) => p > q, "≤": (p, q) => p <= q, "≥": (p, q) => p >= q, "=": (p, q) => Math.abs(p - q) < 1e-9, "≠": (p, q) => Math.abs(p - q) >= 1e-9 };
    const f = REL[e.op];
    if (!f) return null;
    if (e.a.k === "bin" && REL[e.a.op]) {
      const left = meets(e.a, x);
      const [p, q] = [at(e.a.b, x), at(e.b, x)];
      return left === null || Number.isNaN(p) || Number.isNaN(q) ? null : left && f(p, q);
    }
    const [p, q] = [at(e.a, x), at(e.b, x)];
    return Number.isNaN(p) || Number.isNaN(q) ? null : f(p, q);
  };
  const body = call.args[0];
  const sides: string[] = [];
  const rels: Extract<Ast, { k: "bin" }>[] = [];
  const collect = (x: Ast): void => {
    if (x.k === "bin" && x.op === "and") {
      collect(x.a);
      collect(x.b);
    } else if (x.k === "bin") rels.push(x);
  };
  collect(body);
  for (const r of rels) sides.push(`[${translate(r.a, settings).giac},${translate(r.b, settings).giac}]`);
  const X = RENAME_IN[name] ?? name;
  // A lone point in the answer (x=40) is tested on its own: sampling never lands on it.
  const lone: number[] = [];
  const points = (e: Ast): void => {
    if (e.k === "bin" && e.op === "or") {
      points(e.a);
      points(e.b);
    } else if (e.k === "bin" && e.op === "=" && e.a.k === "sym" && e.a.name === name) lone.push(numericValue(e.b));
  };
  points(answer);
  for (const x of lone) {
    if (!Number.isFinite(x)) continue;
    for (let k = 0; k < rels.length; k++) {
      const r = (await giac(`evalf(subst(${sides[k]},${X}=${x}))`)).trim();
      const [p, q] = r.replace(/^\[|\]$/g, "").split(",").map(Number);
      if (p === undefined || q === undefined || !Number.isFinite(p) || !Number.isFinite(q)) return false;
      const zero = Math.abs(p - q) <= 1e-6 * Math.max(1, Math.abs(p) + Math.abs(q));
      const op = rels[k]!.op;
      const ok = op === "<" ? p < q && !zero : op === ">" ? p > q && !zero : op === "≤" ? p <= q || zero : op === "≥" ? p >= q || zero : true;
      if (!ok) return false;
    }
  }
  for (let j = 0; j <= 200; j++) {
    const x = lo + ((hi - lo) * (j + 0.37)) / 201;
    const truth: (boolean | null)[] = [];
    for (let k = 0; k < rels.length; k++) {
      const r = (await giac(`evalf(subst(${sides[k]},${X}=${x}))`)).trim();
      const [p, q] = r.replace(/^\[|\]$/g, "").split(",").map(Number);
      if (/\bi\b|undef/.test(r) || p === undefined || q === undefined || !Number.isFinite(p) || !Number.isFinite(q)) {
        truth.push(false);
        continue;
      }
      // Too close to call (an end point): skip this sample.
      if (Math.abs(p - q) <= 1e-6 * Math.max(1, Math.abs(p) + Math.abs(q))) truth.push(null);
      else {
        const op = rels[k]!.op;
        truth.push(op === "<" || op === "≤" ? p < q : op === ">" || op === "≥" ? p > q : op === "≠" ? true : false);
      }
    }
    if (truth.includes(null)) continue;
    const want = truth.every(Boolean);
    const got = meets(answer, x);
    if (got === null || got !== want) return false;
  }
  return true;
}

function interval(lo: { at: Ast; closed: boolean }, hi: { at: Ast; closed: boolean }, x: Ast): Ast {
  const inf = (e: Ast) => e.k === "sym" && (e.name === "∞" || e.name === "-∞");
  if (inf(lo.at) && inf(hi.at)) return sym("true");
  if (inf(lo.at)) return { k: "bin", op: hi.closed ? "≤" : "<", a: x, b: hi.at };
  if (inf(hi.at)) return { k: "bin", op: lo.closed ? "≥" : ">", a: x, b: lo.at };
  return { k: "bin", op: hi.closed ? "≤" : "<", a: { k: "bin", op: lo.closed ? "≤" : "<", a: lo.at, b: x }, b: hi.at };
}

/**
 * solve(E1 and E2,{x,y}) where one equation gives one variable outright
 * (y=ℯ^x): substitute it into the other, solve that in one variable (which
 * copes with what Giac's system solver doesn't), then work out the other.
 */
async function systemBySubstitution(a: Ast, giac: Giac, opts: { settings: Settings }): Promise<EvalResult | null> {
  if (!(a.k === "call" && a.f === "solve" && a.args.length === 2)) return null;
  const [eqs, vs] = a.args;
  const parts: Ast[] = [];
  const walk = (x: Ast): void => {
    if (x.k === "bin" && x.op === "and") {
      walk(x.a);
      walk(x.b);
    } else parts.push(x);
  };
  if (eqs) walk(eqs);
  const names = vs?.k === "list" ? vs.items.map((v) => (v.k === "sym" ? v.name : "")) : [];
  if (parts.length !== 2 || names.length !== 2 || names.some((n) => !n)) return null;
  const has = (x: Ast, n: string) => {
    let found = false;
    mapAst(x, (y) => {
      if (y.k === "sym" && y.name === n) found = true;
      return y;
    });
    return found;
  };
  for (const [k, e] of parts.entries()) {
    if (!(e.k === "bin" && e.op === "=")) continue;
    for (const v of names) {
      const [lhs, rhs] = [e.a, e.b];
      const expr = lhs.k === "sym" && lhs.name === v && !has(rhs, v) ? rhs : rhs.k === "sym" && rhs.name === v && !has(lhs, v) ? lhs : null;
      if (!expr) continue;
      const other = names.find((n) => n !== v)!;
      const rest = parts[1 - k]!;
      const substituted = mapAst(rest, (y) => (y.k === "sym" && y.name === v ? expr : y));
      const sub = await evaluate(`solve(${print(substituted)},${other})`, giac, { settings: opts.settings, values: true });
      if (!sub.ok) return null;
      const vals: Ast[] = [];
      const pick = (x: Ast): void => {
        if (x.k === "bin" && x.op === "or") {
          pick(x.a);
          pick(x.b);
        } else if (x.k === "bin" && x.op === "=") vals.push(x.b);
      };
      if (!(sub.output.k === "sym" && sub.output.name === "false")) pick(sub.output);
      if (!vals.length) return { ok: true, input: a, output: sym("false"), outputText: "false" };
      const sols: Ast[] = [];
      for (const val of vals) {
        const w = await evaluate(`${print(expr)}|${other}=${print(val)}`, giac, { settings: opts.settings });
        if (!w.ok) return null;
        const pair: Record<string, Ast> = { [other]: val, [v]: w.output };
        sols.push({ k: "bin", op: "and", a: { k: "bin", op: "=", a: sym(names[0]!), b: pair[names[0]!]! }, b: { k: "bin", op: "=", a: sym(names[1]!), b: pair[names[1]!]! } });
      }
      const output = sols.reduce((acc, x) => ({ k: "bin", op: "or", a: acc, b: x }));
      return { ok: true, input: a, output, outputText: print(output) };
    }
  }
  return null;
}

const REAL_COMMANDS = new Set(["solve", "zeros", "polyRoots", "nSolve", "fMin", "fMax", "nfMin", "nfMax"]);

/**
 * euler(Expr, Var, depVar, {Var0, VarMax}, depVar0, VarStep[, eulerStep]):
 * Euler's method, as the handheld does it. A system takes lists of
 * expressions, dependent variables and starting values. The answer is a
 * matrix: the Var values on the first row, each dependent variable's on the
 * rows below, at every VarStep (each worked in eulerStep smaller steps).
 */
async function eulerMethod(input: Ast, call: Extract<Ast, { k: "call" }>, giac: Giac, settings: Settings): Promise<EvalResult> {
  const fail = (error: string): EvalResult => ({ ok: false, input, error });
  const [exprA, varA, depA, rangeA, startA, stepA, subA] = call.args;
  if (!exprA || varA?.k !== "sym" || !depA || rangeA?.k !== "list" || rangeA.items.length !== 2 || !startA || !stepA) return fail("Error: Argument error");
  const exprs = exprA.k === "list" ? exprA.items : [exprA];
  const deps = depA.k === "list" ? depA.items : [depA];
  if (deps.some((d) => d.k !== "sym") || deps.length !== exprs.length) return fail("Error: Dimension error");
  const num = async (a: Ast) => Number((await giac(`evalf(${translate(a, settings).giac})`)).trim());
  const [x0, x1] = [await num(rangeA.items[0]!), await num(rangeA.items[1]!)];
  const starts = startA.k === "list" ? startA.items : [startA];
  const ys0 = await Promise.all(starts.map(num));
  const h = await num(stepA);
  const sub = subA ? await num(subA) : 1;
  if (![x0, x1, h, sub, ...ys0].every(Number.isFinite) || ys0.length !== deps.length || !(h > 0) || !(sub >= 1)) return fail("Error: Argument error");
  const steps = Math.round((x1 - x0) / h);
  if (steps < 0 || steps > 5000) return fail("Error: Argument error");
  const X = RENAME_IN[varA.name] ?? varA.name;
  const Ys = deps.map((d) => (d.k === "sym" ? (RENAME_IN[d.name] ?? d.name) : ""));
  const F = `[${exprs.map((e) => translate(e, settings).giac).join(",")}]`;
  const xs = [x0];
  const rows = ys0.map((y) => [y]);
  let [x, ys] = [x0, ys0];
  for (let k = 0; k < steps; k++) {
    for (let j = 0; j < sub; j++) {
      const raw = (await giac(`evalf(subst(${F},[${X}=${x},${Ys.map((n, i) => `${n}=${ys[i]}`).join(",")}]))`)).trim();
      const slopes = raw.replace(/^\[|\]$/g, "").split(",").map(Number);
      if (slopes.length !== ys.length || slopes.some((v) => !Number.isFinite(v))) return fail("Error: Domain error");
      ys = ys.map((y, i) => y + (h / sub) * slopes[i]!);
      x += h / sub;
    }
    xs.push(x0 + (k + 1) * h);
    ys.forEach((y, i) => rows[i]!.push(y));
  }
  const cell = (v: number): Ast => shownDecimal(v, settings.digits);
  const output: Ast = { k: "mat", rows: [xs.map(cell), ...rows.map((r) => r.map(cell))] };
  return { ok: true, input, output, outputText: print(output) };
}

async function polishRoots(a: Ast, raw: string, giac: Giac, settings: Settings): Promise<string> {
  const call = a.k === "bin" && a.op === "|" ? a.a : a;
  if (!(call.k === "call" && call.f === "solve" && call.args[0]?.k === "bin" && call.args[0].op === "=" && call.args[1]?.k === "sym")) return raw;
  const eq = call.args[0];
  const X = RENAME_IN[call.args[1].name] ?? call.args[1].name;
  const L = translate(eq.a, settings).giac;
  const R = translate(eq.b, settings).giac;
  const items = splitTop(raw.trim().replace(/^(list)?\[|\]$/g, ""));
  if (!items.length || items.some((v) => !/^[-+]?[\d.]+(e[-+]?\d+)?$/.test(v.trim()))) return raw;
  // Other unknowns (a in a·1.05ᵗ=2a): a root that is a plain number holds whatever they
  // are, so it's polished and checked with each at a sample value (fsolve can't work with a name).
  const subs = await sampleValues(`(${L})-(${R})`, X, giac);
  const put = (e: string) => (subs.length ? `subst(${e},[${subs.join(",")}])` : e);
  const out: number[] = [];
  for (const v of items) {
    const r = Number((await giac(`fsolve((${put(L)})-(${put(R)})=0,${X}=${v})`)).trim().replace(/^(list)?\[|\]$/g, "").split(",")[0]);
    if (!Number.isFinite(r)) continue;
    const { gap, size } = await residual(eq.a, eq.b, X, String(r), giac, settings, subs);
    if (!(gap <= 1e-9 * size)) continue;
    if (!out.some((o) => Math.abs(o - r) <= 1e-9 * Math.max(1, Math.abs(r)))) out.push(r);
  }
  return `[${out.sort((p, q) => p - q).join(",")}]`;
}

/**
 * The names other than X left in a Giac expression once it's worked out
 * (stored variables and functions resolved), each given a sample value
 * ("a=0.3719"), as same() samples them.
 */
async function sampleValues(expr: string, X: string, giac: Giac): Promise<string[]> {
  const names = (await giac(`lname(${expr})`)).trim().replace(/^(list)?\[|\]$/g, "").split(",").map((n) => n.trim()).filter((n) => /^[A-Za-z]\w*$/.test(n) && n !== X);
  return names.map((n, k) => `${n}=${(0.3719 + 0.6173 * k + 0.0917 * k * k).toFixed(4)}`);
}

/**
 * How far L=R is from holding at x (gap = |L−R|), and the size of the terms it
 * is made of, for judging the gap (size = |t₁|+|t₂|+… over both sides'
 * summands, at least 1). The sides' own values are no measure when the
 * equation is written as …=0: 5000·1.004ⁿ−75000·(1.004ⁿ−1)=0 has terms near
 * 5000 that cancel to 1E−8 at its root (written to 12 digits), which is
 * rounding, not a miss; the same equation divided by 1000 passed. subs puts
 * sample values in for other names (sampleValues).
 */
async function residual(L: Ast, R: Ast, X: string, x: string, giac: Giac, settings: Settings, subs: string[] = []): Promise<{ gap: number; size: number }> {
  const terms: Ast[] = [];
  const split = (e: Ast): void => {
    if (e.k === "bin" && (e.op === "+" || e.op === "-")) {
      split(e.a);
      split(e.b);
    } else if (e.k === "neg") split(e.a);
    else terms.push(e);
  };
  split(L);
  split(R);
  const t = (e: Ast) => translate(e, settings).giac;
  const size = terms.map((e) => `abs(${t(e)})`).join("+");
  const at = [...subs, `${X}=${x}`].join(",");
  const raw = (await giac(`evalf(subst([(${t(L)})-(${t(R)}),${t(L)},${t(R)},${size}],[${at}]))`)).trim();
  const [d, l, r, s] = raw.replace(/^(list)?\[|\]$/g, "").split(",").map(Number);
  if (d === undefined || !Number.isFinite(d)) return { gap: NaN, size: 1 };
  // Terms that can't be sized (an undef piece) fall back on the sides.
  const sides = Math.abs(l ?? NaN) + Math.abs(r ?? NaN);
  const measure = Number.isFinite(s) ? s! : Number.isFinite(sides) ? sides : 0;
  return { gap: Math.abs(d), size: Math.max(1, measure) };
}

/** The interval a "|" condition puts the variable in: a≤x≤b, x>a and x<b … (null if it's something else). */
function domainOf(cond: Ast, name: string, settings: Settings): { lo?: { v: string; closed: boolean }; hi?: { v: string; closed: boolean } } | null {
  const out: { lo?: { v: string; closed: boolean }; hi?: { v: string; closed: boolean } } = {};
  const t = (x: Ast) => translate(x, settings).giac;
  const isX = (y: Ast) => y.k === "sym" && y.name === name;
  const walk = (r: Ast): boolean => {
    if (r.k !== "bin") return false;
    if (r.op === "and") return walk(r.a) && walk(r.b);
    if (!["<", ">", "≤", "≥"].includes(r.op)) return false;
    if (r.a.k === "bin" && ["<", "≤"].includes(r.a.op) && isX(r.a.b) && ["<", "≤"].includes(r.op)) {
      out.lo = { v: t(r.a.a), closed: r.a.op === "≤" };
      out.hi = { v: t(r.b), closed: r.op === "≤" };
      return true;
    }
    const [other, upper] = isX(r.a) ? [r.b, ["<", "≤"].includes(r.op)] : isX(r.b) ? [r.a, [">", "≥"].includes(r.op)] : [null, false];
    if (!other) return false;
    const end = { v: t(other), closed: r.op === "≤" || r.op === "≥" };
    if (upper) out.hi = end;
    else out.lo = end;
    return true;
  };
  return walk(cond) ? out : null;
}

/**
 * solve and zeros answer real solutions once each: non-real values (√ of a
 * negative after a substitution), repeats (x=0 three times, 3π/2 beside
 * 4.71239) and general solutions that are never real (cos(sin(2x))=0) go.
 * On a bounded domain, when Giac finds nothing or leaves general solutions,
 * the interval is searched numerically for every root.
 */
async function cleanSolutions(output: Ast, a: Ast, giac: Giac, settings: Settings): Promise<Ast> {
  const call = a.k === "bin" && a.op === "|" ? a.a : a;
  const cond = a.k === "bin" && a.op === "|" ? a.b : undefined;
  if (!(call.k === "call" && call.args[0] && call.args[1]?.k === "sym")) return output;
  const name = call.args[1].name;
  const asList = call.f === "zeros";
  const items: Ast[] = [];
  const walk = (x: Ast): void => {
    if (x.k === "bin" && x.op === "or") {
      walk(x.a);
      walk(x.b);
    } else if (!(x.k === "sym" && x.name === "false")) items.push(x);
  };
  if (asList) {
    if (output.k !== "list") return output;
    items.push(...output.items);
  } else walk(output);
  const valueOf = (x: Ast) => (asList ? x : x.k === "bin" && x.op === "=" && x.a.k === "sym" && x.a.name === name ? x.b : null);
  if (items.some((x) => !valueOf(x))) return output;
  const free = (v: Ast) => {
    let general = false;
    let other = false;
    mapAst(v, (y) => {
      if (y.k === "sym" && /^n\d+$/.test(y.name)) general = true;
      else if (y.k === "sym" && !["π", "ℯ", "i", "∞"].includes(y.name)) other = true;
      return y;
    });
    return { general, other };
  };
  const kept: { item: Ast; value: number | null; exact: boolean }[] = [];
  let general = false;
  for (const item of items) {
    const v = valueOf(item)!;
    // undef is no solution: Giac's numeric search gives [undef] when it finds none (x·ℯ^(−x)=0.5).
    if (v.k === "sym" && v.name === "undef") continue;
    const f = free(v);
    if (f.other) {
      kept.push({ item, value: null, exact: true });
      continue;
    }
    const G = translate(v, settings).giac;
    if (f.general) {
      // Real for some whole n? Otherwise it's no solution at all.
      let real = false;
      for (const n of [0, 1, -1, 2, -2]) {
        const ns = [...new Set(print(v).match(/\bn\d+\b/g) ?? [])];
        const r = (await giac(`evalf(subst(${G},[${ns.map((m) => `${m}=${n}`).join(",")}]))`)).trim();
        if (!/\bi\b|undef|error/i.test(r)) real = true;
      }
      if (real) {
        general = true;
        kept.push({ item, value: null, exact: true });
      }
      continue;
    }
    const r = (await giac(`evalf(${G})`)).trim().replace(/=.*$/, "");
    if (/\bi\b|undef|error/i.test(r)) continue;
    // zeros keeps a removable hole as a root ((x²−1)/(x−1) at 1, sin(x)/x at 0); solve doesn't.
    if (asList) {
      // The expression as typed: translate's normal() would cancel the hole first.
      const typed = translate(call.args[0], settings);
      const at = (await giac(`evalf(subst(${typed.unwrapped ?? typed.giac},${RENAME_IN[name] ?? name},${G}))`)).trim();
      if (/undef|infinity/.test(at)) continue;
    }
    const num = Number(r);
    const exact = !/\d\.\d*|\d\.(?!\d)/.test(print(v));
    if (!Number.isFinite(num)) {
      kept.push({ item, value: null, exact: true });
      continue;
    }
    // Shown decimals carry 6 digits, so a decimal twin of an exact root is that close.
    const twin = kept.findIndex((k) => k.value !== null && Math.abs(k.value - num) <= (exact && k.exact ? 1e-9 : 1e-5) * Math.max(1, Math.abs(num)));
    if (twin >= 0) {
      // Keep the exact one of the two.
      if (exact && !kept[twin]!.exact) kept[twin] = { item, value: num, exact };
      continue;
    }
    kept.push({ item, value: num, exact });
  }
  // A bounded domain Giac couldn't do: search it.
  const dom = cond ? domainOf(cond, name, settings) : null;
  // Several equations in one variable: the roots of the first that satisfy the rest.
  const eqs: Ast[] = [];
  const split = (x: Ast): void => {
    if (x.k === "bin" && x.op === "and") {
      split(x.a);
      split(x.b);
    } else eqs.push(x);
  };
  split(call.args[0]);
  const eq = eqs[0]!;
  // Also when Giac's answers there are decimals (a numeric solve, which can miss a root at an end).
  const numeric = kept.some((k) => k.value !== null && !k.exact);
  if (dom?.lo && dom.hi && (general || !kept.length || numeric) && eqs.every((e) => e.k === "bin" && e.op === "=")) {
    const [lo, hi] = [Number((await giac(`evalf(${dom.lo.v})`)).trim()), Number((await giac(`evalf(${dom.hi.v})`)).trim())];
    const X = RENAME_IN[name] ?? name;
    const at = (x: Ast) => `subst(${translate(x, settings).giac},${X},x_)`;
    if (Number.isFinite(lo) && Number.isFinite(hi) && hi > lo) {
      const [ea, eb] = [(eq as Extract<Ast, { k: "bin" }>).a, (eq as Extract<Ast, { k: "bin" }>).b];
      const all = await rootsIn(giac, `${at(ea)}=${at(eb)}`, lo, hi);
      const roots: number[] = [];
      for (const x of all) {
        let ok = true;
        for (const e of eqs.slice(1)) {
          const b = e as Extract<Ast, { k: "bin" }>;
          const [l, r] = (await giac(`evalf(subst([${translate(b.a, settings).giac},${translate(b.b, settings).giac}],${X}=${x}))`)).replace(/^\[|\]$/g, "").split(",").map(Number);
          if (!(l !== undefined && r !== undefined && Math.abs(l - r) <= 1e-6 * Math.max(1, Math.abs(l) + Math.abs(r)))) ok = false;
        }
        if (ok) roots.push(x);
      }
      const inside = roots.filter((x) => (dom.lo!.closed ? x >= lo - 1e-12 : x > lo + 1e-12) && (dom.hi!.closed ? x <= hi + 1e-12 : x < hi - 1e-12));
      const fresh = kept.filter((k) => k.value !== null);
      for (const x of inside) {
        // Giac's own decimals are shown to 6 digits: a search root that close is the same root.
        if (fresh.some((k) => Math.abs(k.value! - x) <= 1e-5 * Math.max(1, Math.abs(x)))) continue;
        const val = shownDecimal(x, settings.digits);
        fresh.push({ item: asList ? val : { k: "bin", op: "=", a: sym(name), b: val }, value: x, exact: false });
      }
      fresh.sort((p, q) => p.value! - q.value!);
      kept.splice(0, kept.length, ...fresh);
    }
  }
  if (kept.length === items.length && kept.every((k, i) => k.item === items[i])) return output;
  if (asList) return { k: "list", items: kept.map((k) => k.item) };
  if (!kept.length) return sym("false");
  return kept.map((k) => k.item).reduce((acc, x) => ({ k: "bin", op: "or", a: acc, b: x }));
}

const SOLVERS = new Set(["solve", "cSolve", "zeros", "cZeros", "nSolve", "fMin", "fMax", "nfMin", "nfMax", "polyRoots", "cPolyRoots"]);

/**
 * solve(…,x)|k=2 and n>0: the equalities for other variables are put into
 * the command's first argument before it runs (so the equation is solved
 * with k=2, not solved for every k and substituted afterwards); conditions
 * on the variable itself stay as its domain.
 */
async function substituteFirst(a: Ast, giac: Giac, opts: { settings: Settings }): Promise<Ast | null> {
  if (!(a.k === "bin" && a.op === "|" && a.a.k === "call" && SOLVERS.has(a.a.f) && a.a.args[0])) return null;
  const call = a.a;
  const target = call.args[1];
  const names = new Set<string>();
  const collect = (t: Ast | undefined): void => {
    if (!t) return;
    if (t.k === "sym") names.add(t.name);
    else if (t.k === "list") t.items.forEach(collect);
    else if (t.k === "bin" && t.op === "=" && t.a.k === "sym") names.add(t.a.name);
  };
  collect(target);
  if (!names.size) names.add("x");
  const conds = conjuncts(a.b);
  const subs = conds.filter((c) => c.k === "bin" && c.op === "=" && c.a.k === "sym" && !names.has(c.a.name));
  if (!subs.length) return null;
  const rest = conds.filter((c) => !subs.includes(c));
  const join = (xs: Ast[]): Ast => xs.reduce((p, q) => ({ k: "bin", op: "and", a: p, b: q }));
  // Each relation of the first argument worked out with the substitution.
  const parts = conjuncts(call.args[0]!);
  const done: Ast[] = [];
  for (const part of parts) {
    const r = await evaluate(print({ k: "bin", op: "|", a: part, b: join(subs) }), giac, { settings: opts.settings });
    if (!r.ok) return null;
    done.push(r.output);
  }
  const first = join(done);
  const next: Ast = { ...call, args: [first, ...call.args.slice(1)] };
  return rest.length ? { k: "bin", op: "|", a: next, b: join(rest) } : next;
}

/**
 * deSolve takes a first-order equation with one condition at most, and a
 * second-order one with two (initial or boundary conditions). More conditions than the order is an
 * Argument Error on the handheld, whether or not they agree:
 * deSolve(y'=y and y(0)=1 and y(0)=2,x,y) gives it. Giac answers
 * false. Fewer is fine: y''=y and y(0)=1 keeps a constant.
 */
function overDetermined(a: Ast): boolean {
  if (!(a.k === "call" && a.f === "deSolve" && a.args[0])) return false;
  const [ode, ...conds] = conjuncts(a.args[0]);
  const depth = (z: Ast): number => (z.k === "post" && z.op === "'" ? 1 + depth(z.a) : 0);
  let order = 0;
  mapAst(ode!, (z) => {
    order = Math.max(order, depth(z));
    return z;
  });
  return order > 0 && conds.length > order;
}

/**
 * deSolve of a first-order equation that separates, y′=p(x)·q(y), as the
 * handheld answers it: implicitly, ∫1/q dy=∫p dx+c, or with a condition y(a)=b,
 * F(y)−F(b)=G(x)−G(a) (y′=ℯ^(x−y) and y(0)=1: ℯ^y−ℯ=ℯ^x−1). A polynomial
 * factor of q is made monic, its leading coefficient going to the x side
 * (v′=−(1+v²) and v(0)=1: tan⁻¹(v)−π/4=−t). Used only where Giac's answer
 * fails: it gives none when it can't isolate y (y′=1/(1+y²)); it writes the
 * constant as ℯ^c1, never 0 or negative, so y(0)=1 couldn't be met; and it
 * solves for the constant on every branch, leaving tan(x−n1·π).
 */
async function separable(input: Ast, giac: Giac, settings: Settings, approx: boolean, powerOnly = false): Promise<string | null> {
  if (!(input.k === "call" && input.f === "deSolve" && input.args[0])) return null;
  const [xv, yv] = [input.args[1] ?? sym("x"), input.args[2] ?? sym("y")];
  if (xv.k !== "sym" || yv.k !== "sym") return null;
  const G = (a: Ast) => {
    const tr = translate(a, settings);
    return tr.unwrapped ?? tr.giac;
  };
  const primes = (a: Ast) => {
    let n = 0;
    mapAst(a, (z) => {
      if (z.k === "post" && z.op === "'") n++;
      return z;
    });
    return n;
  };
  const parts = conjuncts(input.args[0]);
  const odes = parts.filter((p) => primes(p) > 0);
  const conds = parts.filter((p) => primes(p) === 0);
  const ode = odes[0];
  if (odes.length !== 1 || conds.length > 1 || !(ode?.k === "bin" && ode.op === "=")) return null;
  const cond = conds[0];
  if (cond && !(cond.k === "bin" && cond.op === "=" && cond.a.k === "call" && cond.a.f === yv.name && cond.a.args.length === 1)) return null;
  // y′ as a plain unknown; y″ or y′ of anything else isn't first order in y.
  const flat = mapAst(ode, (z) => (z.k === "post" && z.op === "'" && z.a.k === "sym" && z.a.name === yv.name ? sym("yp_") : z));
  if (primes(flat) || flat.k !== "bin") return null;
  const [x, y] = [G(xv), G(yv)];
  const E = G({ k: "bin", op: "-", a: flat.a, b: flat.b });
  const coef = (await giac(`normal(diff(${E},yp_))`)).trim();
  if (/yp_|error|undef/i.test(coef) || coef === "0") return null;
  // The equation as y′=f, f split into factors in x (and numbers) and factors in y.
  const [g, m, n] = ["L_[2*j_]", "L_[2*j_+1]", "size(L_)/2-1"];
  const lead = `when(has(${g},${y}) and diff(${g},${y},degree(${g},${y})+1)==0,lcoeff(${g},${y}),1)`;
  // ℯ^(2x) was split into the factor ℯ^x twice: put back as ℯ^(2x), not (ℯ^x)².
  const pow = (b: string) => `when(sommet(${b})=='exp',exp((${m})*op(${b})),(${b})^(${m}))`;
  const P = `product(seq(${pow(`when(has(${g},${y}),${lead},${g})`)},j_,0,${n}))`;
  const Q = `product(seq(${pow(`when(has(${g},${y}),${g}/${lead},1)`)},j_,0,${n}))`;
  const mixed = `sum(seq(when(has(${g},${y}) and has(${g},${x}),1,0),j_,0,${n}))`;
  const split = `(L_->[${P},${Q},${mixed}])(factors(expexpand(-subst(${E},yp_=0)/(${coef}))))`;
  const check = (await giac(`(s_->[s_[2],has(s_[1],${y})])(${split})`)).replace(/\s/g, "");
  if (!/^\[0,(1|true)\]$/.test(check)) return null;
  // q(y)=yⁿ with n>2: y′=x²·y³ and y(1)=3 is 1/18−1/(2·y²)=x³/3−1/3 on the handheld
  // (VCE Specialist 2025 Exam 2), where Giac gives y=√(6)·√(…)/(…).
  // With n=2, −1 or 1/2 the handheld solves for y^(1−n) instead (v′=−0.1·v² is
  // v=10./(t+0.5), y′=x/y is y²=x²+4), which Giac's explicit answer is closer to.
  if (powerOnly) {
    const n = Number((await giac(`evalf(normal(${y}*diff((${split})[1],${y})/((${split})[1])))`)).trim());
    if (!(n > 2)) return null;
  }
  const Fy = (await giac(`regroup(integrate(1/((${split})[1]),${y}))`)).trim();
  const Gx = (await giac(`regroup(integrate((${split})[0],${x}))`)).trim();
  const bad = (t: string) => /integrate\(|undef|infinity|error|^"|\[/i.test(t);
  if (bad(Fy) || bad(Gx)) return null;
  let [left, right] = [Fy, `${Gx}+c_0`];
  if (cond?.k === "bin" && cond.a.k === "call") {
    const [a, b] = [G(cond.a.args[0]!), G(cond.b)];
    left = (await giac(`${Fy}-subst(${Fy},${y}=${b})`)).trim();
    right = (await giac(`${Gx}-subst(${Gx},${x}=${a})`)).trim();
    if (bad(left) || bad(right)) return null;
  }
  if (approx) [left, right] = [await giac(`evalf(${left})`), await giac(`evalf(${right})`)];
  return `${left}=${right}`;
}

function conjuncts(a: Ast): Ast[] {
  return a.k === "bin" && a.op === "and" ? [...conjuncts(a.a), ...conjuncts(a.b)] : [a];
}

const COMPARISONS = new Set(["<", ">", "≤", "≥"]);
const CONSTANT_NAMES = new Set(["π", "ℯ", "i", "∞"]);

/**
 * A "|" bound with another variable in it (solve(…,y)|y>1−k, fMax(…)|0<u<k)
 * isn't a constraint the handheld applies: it takes a variable compared with a
 * constant only (a condition-ignored warning). fMin and fMax answer false;
 * solve answers without the bound, each solution carrying it as a condition
 * (and one it rules out dropped). Giac throws on these, uncatchably.
 */
async function parameterBounds(a: Ast, giac: Giac, opts: { settings: Settings }): Promise<EvalResult | null> {
  if (!(a.k === "bin" && a.op === "|" && a.a.k === "call" && a.a.args[0])) return null;
  const call = a.a;
  if (!["solve", "zeros", "fMin", "fMax"].includes(call.f)) return null;
  const names = new Set<string>();
  const collect = (t: Ast | undefined): void => {
    if (!t) return;
    if (t.k === "sym") names.add(t.name);
    else if (t.k === "list") t.items.forEach(collect);
    else if (t.k === "bin" && t.op === "=" && t.a.k === "sym") names.add(t.a.name);
  };
  collect(call.args[1]);
  if (!names.size) names.add("x");
  // A chain a<x<b is two comparisons, each judged on its own.
  const simple = conjuncts(a.b).flatMap((c): Ast[] =>
    c.k === "bin" && COMPARISONS.has(c.op) && c.a.k === "bin" && COMPARISONS.has(c.a.op)
      ? [c.a, { k: "bin", op: c.op, a: c.a.b, b: c.b }]
      : [c],
  );
  const symbols = (x: Ast) => {
    const s = new Set<string>();
    mapAst(x, (y) => {
      if (y.k === "sym") s.add(y.name);
      return y;
    });
    return s;
  };
  const withParam: Ast[] = [];
  const paramOnly: Ast[] = [];
  const stored = new Set<string>();
  const isStored = async (n: string) => Number.isFinite(Number((await giac(`evalf(${translate(sym(n), opts.settings).giac})`)).trim()));
  for (const c of simple) {
    if (!(c.k === "bin" && COMPARISONS.has(c.op))) continue;
    const vs = symbols(c);
    if (![...names].some((n) => vs.has(n))) {
      // A bound on parameters alone (…|y>0, …|k>0) filters nothing: the handheld
      // solves as usual and every solution carries it (x=-2 and y>0 or x=2 and y>0).
      if (call.f === "solve" && names.size === 1) {
        let free = false;
        for (const n of vs) if (!CONSTANT_NAMES.has(n) && !(await isStored(n))) free = true;
        if (free) paramOnly.push(c);
      }
      continue;
    }
    const others = [...vs].filter((n) => !names.has(n) && !CONSTANT_NAMES.has(n));
    let free = false;
    // A stored number is a constant (2→k then …|x<k).
    for (const n of others) {
      if (await isStored(n)) stored.add(n);
      else free = true;
    }
    if (free) withParam.push(c);
  }
  // Stored numbers go into the bound before Giac sees it: its assumption x<k
  // with k:=2 answers list[1] (fMax gave x=0 or x=k, solve an error).
  if (!withParam.length && stored.size) {
    const values = new Map<string, Ast>();
    for (const n of stored) {
      const r = await evaluate(n, giac, { settings: opts.settings });
      if (!r.ok) return null;
      values.set(n, r.output);
    }
    const cond = mapAst(a.b, (y) => (y.k === "sym" && values.has(y.name) ? values.get(y.name)! : y));
    return evaluate(print({ ...a, b: cond }), giac, { settings: opts.settings });
  }
  if (!withParam.length && !paramOnly.length) return null;
  // The handheld's answers, with its ⚠: false and an accuracy warning for fMin
  // and fMax, and for solve and zeros a condition-ignored warning. A bound on
  // parameters alone (…|y>0) is already in the form that warning asks for, and every
  // solution carries it, so it gets none.
  if (withParam.length && (call.f === "fMin" || call.f === "fMax")) return { ok: true, input: a, output: sym("false"), outputText: "false", warning: warning("accuracy") };
  const ignored = withParam.length ? warning("conditionIgnored") : undefined;
  const rest = simple.filter((c) => !withParam.includes(c) && !paramOnly.includes(c));
  const join = (xs: Ast[]): Ast => xs.reduce((p, q) => ({ k: "bin", op: "and", a: p, b: q }));
  const bare: Ast = rest.length ? { k: "bin", op: "|", a: call, b: join(rest) } : call;
  const r = await evaluate(print(bare), giac, { settings: opts.settings });
  if (!r.ok || call.f !== "solve" || names.size !== 1) return r.ok ? { ...r, input: a, warning: ignored } : r;
  const v = [...names][0]!;
  const branches: Ast[] = [];
  const walk = (x: Ast): void => {
    if (x.k === "bin" && x.op === "or") {
      walk(x.a);
      walk(x.b);
    } else branches.push(x);
  };
  walk(r.output);
  const carried = (out: Ast): EvalResult => {
    if (paramOnly.length && !(out.k === "sym" && (out.name === "false" || out.name === "true"))) {
      const each: Ast[] = [];
      const split = (x: Ast): void => (x.k === "bin" && x.op === "or" ? (split(x.a), split(x.b)) : void each.push(x));
      split(out);
      out = each.map((b) => carry(b, paramOnly)).reduce((p, q) => ({ k: "bin", op: "or", a: p, b: q }));
    }
    return { ok: true, input: a, output: out, outputText: print(out), warning: ignored };
  };
  if (!withParam.length) return carried(r.output);
  // A solution can carry the conditions of undoing the unknown (y=√(x) and x≥0): the bound
  // is judged on its value and goes before them, y=√(x) and √(x)-k>0 and x≥0 for solve(y^2=x,y)|y>k.
  const solved = branches.map(conjuncts);
  if (!solved.every(([e]) => e?.k === "bin" && e.op === "=" && e.a.k === "sym" && e.a.name === v)) return { ...r, input: a, warning: ignored };
  const kept: Ast[] = [];
  for (const [e, ...after] of solved) {
    const at = (e as Extract<Ast, { k: "bin" }>).b;
    let out: Ast | null = e!;
    for (const c of withParam as Extract<Ast, { k: "bin" }>[]) {
      const d = await evaluate(`(${print(c.a)})-(${print(c.b)})|${v}=${print(at)}`, giac, { settings: opts.settings });
      if (!d.ok) continue;
      const n = numericValue(d.output);
      if (Number.isFinite(n)) {
        const holds = c.op === "<" ? n < 0 : c.op === ">" ? n > 0 : c.op === "≤" ? n <= 0 : n >= 0;
        if (!holds) out = null;
        if (!out) break;
        continue;
      }
      out = { k: "bin", op: "and", a: out!, b: { k: "bin", op: c.op, a: d.output, b: { k: "num", v: "0" } } };
    }
    if (out) kept.push(after.reduce<Ast>((p, q) => ({ k: "bin", op: "and", a: p, b: q }), out));
  }
  return carried(kept.length ? kept.reduce((p, q) => ({ k: "bin", op: "or", a: p, b: q })) : sym("false"));
}

/**
 * One solution with the parameter bounds appended. A bound the solution
 * already carries in a weaker form goes: x=√(a) and a≥0 with |a>0 is
 * x=√(a) and a>0, and one it carries as it is isn't
 * repeated (solve(y=ℯ^x,x)|y>0 is x=ln(y) and y>0).
 */
function carry(branch: Ast, conds: Ast[]): Ast {
  const parts = conjuncts(branch);
  const weaker: Record<string, string> = { ">": "≥", "<": "≤" };
  for (const c of conds) {
    if (c.k !== "bin" || parts.some((d) => print(d) === print(c))) continue;
    const k = parts.findIndex((d) => d.k === "bin" && d.op === weaker[c.op] && print(d.a) === print(c.a) && print(d.b) === print(c.b));
    if (k >= 0) parts.splice(k, 1, c);
    else parts.push(c);
  }
  return parts.reduce((p, q) => ({ k: "bin", op: "and", a: p, b: q }));
}

/**
 * The conditions the handheld puts on a solution it gets by undoing the
 * unknown's one occurrence layer by layer (solve(x=2ℯ^(3y)−1,y) is
 * y=ln((x+1)/2)/3 and x>−1). Each layer is undone against the other side W:
 * ℯ^u=W and b^u=W need W>0, √(u)=W and u^n=W with n even need W≥0; adding a
 * term, multiplying by a factor, ln, log and odd powers need nothing. A
 * condition that holds for every value goes, and one linear in its only free
 * name is solved for it ((x+1)/2>0 is x>−1). An unknown in a denominator, in
 * a function the handheld doesn't undo (sin, abs) or in more than one place
 * gives no conditions (the quadratic formula, common denominators).
 * Two solutions from an even power come minus root first: x=−√(y) or x=√(y).
 */
async function isolationConditions(output: Ast, call: Extract<Ast, { k: "call" }>, giac: Giac, settings: Settings): Promise<Ast> {
  const eq = call.args[0];
  const v = call.args[1]?.k === "sym" ? call.args[1].name : undefined;
  if (!v || !eq || !(eq.k === "bin" && eq.op === "=") || /\d\./.test(print(output))) return output;
  const branches: Ast[] = [];
  const split = (x: Ast): void => (x.k === "bin" && x.op === "or" ? (split(x.a), split(x.b)) : void branches.push(x));
  split(output);
  if (!branches.every((b) => b.k === "bin" && b.op === "=" && b.a.k === "sym" && b.a.name === v)) return output;
  // Defined functions written out: x=f(y) with f(x)=2ℯ^(x−1)−3.
  const side = async (x: Ast) => {
    const r = await evaluate(print(x), giac, { settings });
    return r.ok ? r.output : null;
  };
  const [l, r] = [await side(eq.a), await side(eq.b)];
  if (!l || !r) return output;
  const count = (x: Ast) => {
    let n = 0;
    mapAst(x, (y) => {
      if (y.k === "sym" && y.name === v) n++;
      return y;
    });
    return n;
  };
  if (count(l) + count(r) !== 1) return output;
  let [s, w] = count(l) ? [l, r] : [r, l];
  const conds: Extract<Ast, { k: "bin" }>[] = [];
  let even = false;
  const num = (n: string): Ast => ({ k: "num", v: n });
  for (let guard = 0; guard < 40 && !(s.k === "sym" && s.name === v); guard++) {
    if (s.k === "neg") [s, w] = [s.a, { k: "neg", a: w }];
    else if (s.k === "bin" && (s.op === "+" || s.op === "-")) {
      const inA = count(s.a) > 0;
      if (s.op === "+") [s, w] = inA ? [s.a, { k: "bin", op: "-", a: w, b: s.b }] : [s.b, { k: "bin", op: "-", a: w, b: s.a }];
      else [s, w] = inA ? [s.a, { k: "bin", op: "+", a: w, b: s.b }] : [s.b, { k: "bin", op: "-", a: s.a, b: w }];
    } else if (s.k === "bin" && s.op === "*") [s, w] = count(s.a) ? [s.a, { k: "bin", op: "/", a: w, b: s.b }] : [s.b, { k: "bin", op: "/", a: w, b: s.a }];
    else if (s.k === "bin" && s.op === "/") {
      if (!count(s.a)) return output;
      [s, w] = [s.a, { k: "bin", op: "*", a: w, b: s.b }];
    } else if (s.k === "bin" && s.op === "^" && !count(s.b)) {
      // u^n: an even n needs W≥0, an odd one nothing; ^(1/2) is √.
      const n = Number((await giac(`evalf(${translate(s.b, settings).giac})`)).trim());
      if (!Number.isFinite(n) || n === 0) return output;
      const whole = Math.abs(n - Math.round(n)) < 1e-12;
      if (whole && Math.round(n) % 2 === 0) {
        conds.push({ k: "bin", op: "≥", a: w, b: num("0") });
        even = true;
      } else if (!whole && Math.abs(1 / n - Math.round(1 / n)) < 1e-12 && Math.round(1 / n) % 2 === 0) {
        conds.push({ k: "bin", op: "≥", a: w, b: num("0") });
      } else if (!whole && !(Math.abs(1 / n - Math.round(1 / n)) < 1e-12)) return output;
      [s, w] = [s.a, { k: "bin", op: "^", a: w, b: { k: "bin", op: "/", a: num("1"), b: s.b } }];
    } else if (s.k === "bin" && s.op === "^" && !count(s.a)) {
      // ℯ^u or b^u.
      conds.push({ k: "bin", op: ">", a: w, b: num("0") });
      [s, w] = [s.b, { k: "call", f: "ln", args: [w] }];
    } else if (s.k === "call" && s.f === "√" && s.args.length === 1) {
      conds.push({ k: "bin", op: "≥", a: w, b: num("0") });
      [s, w] = [s.args[0]!, { k: "bin", op: "^", a: w, b: num("2") }];
    } else if (s.k === "call" && (s.f === "ln" || s.f === "log") && s.args.length === 1) [s, w] = [s.args[0]!, { k: "bin", op: "^", a: sym("ℯ"), b: w }];
    else return output;
  }
  if (!(s.k === "sym" && s.name === v)) return output;
  const shown: Ast[] = [];
  for (const c of conds) {
    const free = new Set<string>();
    mapAst(c.a, (y) => {
      if (y.k === "sym" && !CONSTANT_NAMES.has(y.name)) free.add(y.name);
      return y;
    });
    if (!free.size) {
      // A condition on numbers only: true goes; false would mean no solution, which Giac already says.
      continue;
    }
    if (free.size !== 1) return output;
    const p = [...free][0]!;
    const solved = await evaluate(`solve(${print(c)},${p})`, giac, { settings });
    if (!(solved.ok && solved.output.k === "bin" && COMPARISONS.has(solved.output.op) && solved.output.a.k === "sym" && solved.output.a.name === p && !mentions(solved.output.b, p))) return output;
    shown.push(solved.output);
  }
  let out = branches;
  if (even && out.length === 2) {
    // Minus root first: the smaller solution wherever the condition holds.
    const at = async (b: Ast) => {
      for (const t of [3.7, 11.3, 0.37, 1.9]) {
        const free = new Set<string>();
        mapAst(b, (y) => {
          if (y.k === "sym" && y.name !== v && !CONSTANT_NAMES.has(y.name)) free.add(y.name);
          return y;
        });
        const subs = [...free].map((n) => `${translate(sym(n), settings).giac}=${t}`).join(",");
        const g = translate((b as Extract<Ast, { k: "bin" }>).b, settings).giac;
        const x = Number((await giac(`evalf(${subs ? `subst(${g},[${subs}])` : g})`)).trim());
        if (Number.isFinite(x)) return x;
      }
      return NaN;
    };
    const [p, q] = [await at(out[0]!), await at(out[1]!)];
    if (Number.isFinite(p) && Number.isFinite(q) && q < p) out = [out[1]!, out[0]!];
  }
  if (shown.length) out = out.map((b) => carry(b, shown));
  return out.reduce((p, q) => ({ k: "bin", op: "or", a: p, b: q }));
}

/** Commands whose stored value should be the answer as shown. */
const SHOWN_STORE = new Set(["nSolve", "zeros", "cZeros", "polyRoots", "cPolyRoots", "nfMin", "nfMax", "round", "median"]);

/**
 * nSolve in the handheld's forms, numerically:
 *   nSolve(eq, x)              a root near 0 (left to the general path)
 *   nSolve(eq, x=guess)        Newton from the guess
 *   nSolve(eq, x, lo)          the first root from lo upwards
 *   nSolve(eq, x[=guess], lo, hi)  a root in [lo, hi], nearest the guess or the first
 *   nSolve(e1 and e2, {x, y}) and {x=1, y=2}: a system, from guesses
 * Every root is checked against the equation. Null leaves it to the general path.
 */
async function nSolveForms(call: Extract<Ast, { k: "call" }>, giac: Giac, settings: Settings): Promise<{ ok: true; output: Ast; outputText: string } | { ok: false; error: string } | null> {
  const [eq, v, loA, hiA] = call.args;
  if (!eq || !v) return null;
  const t = (x: Ast) => translate(x, settings).giac;
  const num = async (x: Ast) => Number((await giac(`evalf(${t(x)})`)).trim());
  const none = { ok: true as const, output: { k: "str" as const, v: "No solution found" }, outputText: '"No solution found"' };
  const diff = (e: Ast) => (e.k === "bin" && e.op === "=" ? `(${t(e.a)})-(${t(e.b)})` : t(e));
  const show = (x: number): Ast => shownDecimal(x, settings.digits);
  // A system.
  if (eq.k === "bin" && eq.op === "and") {
    const eqs = conjuncts(eq);
    const vars = v.k === "list" ? v.items : [v];
    const names = vars.map((x) => (x.k === "sym" ? x.name : x.k === "bin" && x.op === "=" && x.a.k === "sym" ? x.a.name : ""));
    if (names.some((n) => !n) || names.length !== eqs.length) return { ok: false, error: "Error: Argument error" };
    const given = await Promise.all(vars.map(async (x) => (x.k === "bin" && x.op === "=" ? await num(x.b) : null)));
    const G = `[${eqs.map(diff).join(",")}]`;
    const V = `[${names.map((n) => RENAME_IN[n] ?? n).join(",")}]`;
    const starts = [[...given], ...[0.5, 1, -1, 2, 0.1, 3, -2, 5].map((s) => given.map((g) => g ?? s))];
    for (const start of starts) {
      if (start.some((x) => x === null)) continue;
      const raw = (await giac(`fsolve(${G},${V},[${start.join(",")}])`)).trim();
      const vals = raw.replace(/^(list)?\[|\]$/g, "").split(",").map(Number);
      if (vals.length !== names.length || vals.some((x) => !Number.isFinite(x))) continue;
      const res = (await giac(`evalf(subst(${G},${V}=[${vals.join(",")}]))`)).replace(/^\[|\]$/g, "").split(",").map(Number);
      if (res.some((r) => !(Math.abs(r) <= 1e-8 * Math.max(1, ...vals.map(Math.abs))))) continue;
      const parts: Ast[] = names.map((n, k) => ({ k: "bin", op: "=", a: sym(n), b: show(vals[k]!) }));
      const output = parts.reduce((p, q) => ({ k: "bin", op: "and", a: p, b: q }));
      return { ok: true, output, outputText: print(output) };
    }
    return none;
  }
  const name = v.k === "sym" ? v.name : v.k === "bin" && v.op === "=" && v.a.k === "sym" ? v.a.name : null;
  if (!name) return null;
  const guess = v.k === "bin" ? await num(v.b) : null;
  const X0 = RENAME_IN[name] ?? name;
  // A root to rounding: the gap beside the terms' size (residual), or beside x, whose 12 digits leave more as it grows.
  const [eL, eR]: [Ast, Ast] = eq.k === "bin" && eq.op === "=" ? [eq.a, eq.b] : [eq, { k: "num", v: "0" }];
  const check = async (x: number) => {
    const { gap, size } = await residual(eL, eR, X0, String(x), giac, settings);
    return gap <= 1e-8 * Math.max(Math.abs(x), size);
  };
  if (!loA && guess === null) {
    // No guess and no bounds: Giac's own solver first, then a search outwards from 0, as the handheld looks.
    const G0 = diff(eq);
    const first = Number((await giac(`fsolve(${G0}=0,${X0})`)).trim().replace(/^(list)?\[|\]$/g, "").split(",")[0]);
    if (Number.isFinite(first) && (await check(first))) return null;
    for (const span of [10, 100, 1000]) {
      const roots = await rootsIn(giac, `subst(${G0},${X0},x_)=0`, -span, span);
      if (roots.length) {
        const best = roots.reduce((p, q) => (Math.abs(q) < Math.abs(p) ? q : p));
        return { ok: true, output: show(best), outputText: print(show(best)) };
      }
    }
    return null;
  }
  const X = X0;
  const G = diff(eq);
  const at = `subst(${G},${X},x_)=0`;
  if (loA) {
    const lo = await num(loA);
    if (!Number.isFinite(lo)) return { ok: false, error: "Error: Argument error" };
    if (hiA) {
      const hi = await num(hiA);
      if (!Number.isFinite(hi) || hi <= lo) return { ok: false, error: "Error: Argument error" };
      const roots = await rootsIn(giac, at, lo, hi);
      if (!roots.length) return none;
      const best = guess === null ? roots[0]! : roots.reduce((p, q) => (Math.abs(q - guess) < Math.abs(p - guess) ? q : p));
      return { ok: true, output: show(best), outputText: print(show(best)) };
    }
    // A lower bound only: the first root above it, looking further and further out.
    for (const span of [1, 10, 100, 1000]) {
      const roots = await rootsIn(giac, at, lo, lo + span);
      if (roots.length) return { ok: true, output: show(roots[0]!), outputText: print(show(roots[0]!)) };
    }
    return none;
  }
  const raw = Number((await giac(`fsolve(${G}=0,${X}=${guess})`)).trim().replace(/^(list)?\[|\]$/g, "").split(",")[0]);
  if (Number.isFinite(raw) && (await check(raw))) return { ok: true, output: show(raw), outputText: print(show(raw)) };
  return none;
}

/** Keep the system solutions (x=… and y=…) that meet the | conditions; values near 0 count as 0. */
async function systemInDomain(out: Ast, cond: Ast, giac: Giac, settings: Settings): Promise<Ast> {
  const ineq = (c: Ast): boolean => c.k === "bin" && (["<", ">", "≤", "≥", "≠"].includes(c.op) || (c.op === "and" && ineq(c.a) && ineq(c.b)));
  if (!ineq(cond)) return out;
  const rows: Ast[] = [];
  const walk = (x: Ast): void => {
    if (x.k === "bin" && x.op === "or") {
      walk(x.a);
      walk(x.b);
    } else rows.push(x);
  };
  walk(out);
  const kept: Ast[] = [];
  for (const row of rows) {
    const pairs: [string, Ast][] = [];
    const eqs = (x: Ast): void => {
      if (x.k === "bin" && x.op === "and") {
        eqs(x.a);
        eqs(x.b);
      } else if (x.k === "bin" && x.op === "=" && x.a.k === "sym") pairs.push([x.a.name, x.b]);
    };
    eqs(row);
    if (!pairs.length) {
      kept.push(row);
      continue;
    }
    const held = mapAst(cond, (y) => (y.k === "sym" && pairs.some(([n]) => n === y.name) ? sym(`${RENAME_IN[y.name] ?? y.name}_d_`) : y));
    const subs = await Promise.all(
      pairs.map(async ([n, v]) => {
        const val = Number((await giac(`evalf(${translate(v, settings).giac})`)).trim());
        // A decimal that is zero to rounding is zero.
        const snapped = Number.isFinite(val) && Math.abs(val) < 1e-9 ? "0" : translate(v, settings).giac;
        return `${RENAME_IN[n] ?? n}_d_=${snapped}`;
      }),
    );
    const r = (await giac(`evalb(evalf(subst(${translate(held, settings).giac},[${subs.join(",")}])))`)).trim();
    if (r !== "false" && r !== "0") kept.push(row);
  }
  if (kept.length === rows.length) return out;
  return kept.length ? kept.reduce((a, b) => ({ k: "bin", op: "or", a, b })) : sym("false");
}

function top0Name(a: Ast): string | undefined {
  const c = a.k === "bin" && a.op === "|" ? a.a : a;
  return c.k === "call" ? c.f : undefined;
}

function nonAnalytic(a: Ast): boolean {
  const c = a.k === "bin" && a.op === "|" ? a.a : a;
  if (!(c.k === "call" && (c.f === "cSolve" || c.f === "cZeros") && c.args[0] && c.args[1]?.k === "sym")) return false;
  const v = c.args[1].name;
  let found = false;
  mapAst(c.args[0], (y) => {
    if (y.k === "call" && ["abs", "conj", "real", "imag", "angle"].includes(y.f) && y.args.some((x) => {
      let has = false;
      mapAst(x, (z) => {
        if (z.k === "sym" && z.name === v) has = true;
        return z;
      });
      return has;
    }))
      found = true;
    return y;
  });
  return found;
}

type Linear = { name: string; c: number; d: number };

/**
 * solve(∫(f(x),x,0,2*m)=1/2,m): a bound that is c·m+d, not m itself, with m
 * nowhere else. Giac throws on it as it does on m, so the equation is solved
 * for the bound u=c·m+d instead (a condition a≤m≤b becoming one on u), and
 * piecewiseBoundSolve maps each answer back to m.
 */
async function scaledBound(a: Ast, giac: Giac, settings: Settings): Promise<{ a: Ast; back: Linear } | null> {
  const call = (a.k === "bin" && a.op === "|" ? a.a : a) as Extract<Ast, { k: "call" }>;
  const eq = call.args[0]!;
  const name = (call.args[1] as Extract<Ast, { k: "sym" }>).name;
  const t = (x: Ast) => translate(x, settings).giac;
  const bounds: Ast[] = [];
  mapAst(eq, (y) => {
    if (y.k === "call" && (y.f === "∫" || y.f === "integral") && y.args.length === 4)
      for (const b of [y.args[2]!, y.args[3]!]) if (mentionsName(b, name) && !(b.k === "sym" && b.name === name)) bounds.push(b);
    return y;
  });
  if (!bounds.length || new Set(bounds.map((b) => print(b))).size !== 1) return null;
  const B = bounds[0]!;
  const u = "ubnd";
  if (mentionsName(eq, u)) return null;
  const swapped = mapAst(eq, (y) => (print(y) === print(B) ? sym(u) : y));
  if (mentionsName(swapped, name)) return null;
  const M = RENAME_IN[name] ?? name;
  const [c, d, rest] = (await giac(`evalf([diff(${t(B)},${M}),subst(${t(B)},${M},0),normal(diff(${t(B)},${M},2))])`)).trim().replace(/^(list)?\[|\]$/g, "").split(",").map(Number);
  if (!(Number.isFinite(c) && c !== 0 && Number.isFinite(d) && rest === 0)) return null;
  // The other conditions: values for other names stay; a range for m becomes one for u.
  const conds = a.k === "bin" && a.op === "|" ? conjuncts(a.b) : [];
  const other = conds.filter((x) => !mentionsName(x, name));
  const ranged = conds.filter((x) => mentionsName(x, name));
  const out: Ast[] = [...other];
  if (ranged.length) {
    const dom = domainOf(ranged.reduce((p, q) => ({ k: "bin", op: "and", a: p, b: q })), name, settings);
    if (!dom) return null;
    const ends: ({ n: number; closed: boolean } | undefined)[] = [];
    for (const e of [dom.lo, dom.hi]) ends.push(e && { n: Number((await giac(`evalf(${e.v})`)).trim()) * c! + d!, closed: e.closed });
    for (const e of ends) if (e && !Number.isFinite(e.n)) return null;
    let [lo, hi] = ends;
    if (c! < 0) [lo, hi] = [hi, lo];
    const num = (n: number): Ast => (n < 0 ? { k: "neg", a: { k: "num", v: String(-n) } } : { k: "num", v: String(n) });
    if (lo) out.push({ k: "bin", op: lo.closed ? "≥" : ">", a: sym(u), b: num(lo.n) });
    if (hi) out.push({ k: "bin", op: hi.closed ? "≤" : "<", a: sym(u), b: num(hi.n) });
  }
  const solve: Ast = { ...call, args: [swapped, sym(u)] };
  const next: Ast = out.length ? { k: "bin", op: "|", a: solve, b: out.reduce((p, q) => ({ k: "bin", op: "and", a: p, b: q })) } : solve;
  return { a: next, back: { name, c: c!, d: d! } };
}

/**
 * solve with the unknown as a bound of ∫ of a piecewise: the median of a
 * Defined pdf, solve(∫(f(x),x,0,m)=0.5,m). Giac throws, uncatchably, on ∫ of
 * a piecewise to a symbolic bound (and, with a break point at π, even when
 * told which side of it the bound is). So the unknown's range is cut at the
 * break points, and on each part the integral is split where it can be
 * worked: ∫(f,x,0,m) = ∫(f,x,0,c) + ∫(piece,x,c,m), with c the part's end
 * and the piece f's branch inside the part. The handheld finds these roots
 * numerically, so they are decimals even from exact input
 * (m=1.57079632679 for ½·sin(x)'s median, not π/2).
 */
async function piecewiseBoundSolve(a: Ast, giac: Giac, settings: Settings, back?: Linear): Promise<EvalResult | null> {
  const call = a.k === "bin" && a.op === "|" ? a.a : a;
  if (!(call.k === "call" && call.f === "solve" && call.args.length === 2 && call.args[0]!.k === "bin" && call.args[0]!.op === "=" && call.args[1]!.k === "sym")) return null;
  if (!back) {
    const scaled = await scaledBound(a, giac, settings);
    if (scaled) return piecewiseBoundSolve(scaled.a, giac, settings, scaled.back);
  }
  const eq = call.args[0] as Extract<Ast, { k: "bin" }>;
  const name = call.args[1].name;
  const X = RENAME_IN[name] ?? name;
  const t = (x: Ast) => translate(x, settings).giac;
  const mentions = (e: Ast, v: string) => {
    let found = false;
    mapAst(e, (y) => {
      if (y.k === "sym" && y.name === v) found = true;
      return y;
    });
    return found;
  };
  const target = (y: Ast): y is Extract<Ast, { k: "call" }> =>
    y.k === "call" && (y.f === "∫" || y.f === "integral") && y.args.length === 4 && y.args[1]!.k === "sym" && [y.args[2]!, y.args[3]!].filter((b) => b.k === "sym" && b.name === name).length === 1;
  const integrals: Extract<Ast, { k: "call" }>[] = [];
  mapAst(eq, (y) => {
    if (target(y)) integrals.push(y);
    return y;
  });
  if (!integrals.length) return null;
  // The other bound a number (∫ from k to m has two unknown ends).
  const others = integrals.map((I) => (I.args[3]!.k === "sym" && I.args[3]!.name === name ? I.args[2]! : I.args[3]!));
  if (others.some((o) => mentions(o, name))) return null;
  const conds = a.k === "bin" && a.op === "|" ? conjuncts(a.b) : [];
  const subs = conds.filter((c): c is Extract<Ast, { k: "bin" }> => c.k === "bin" && c.op === "=" && c.a.k === "sym" && c.a.name !== name);
  const rest = conds.filter((c) => !subs.includes(c as Extract<Ast, { k: "bin" }>));
  const dom = rest.length ? domainOf(rest.reduce((p, q) => ({ k: "bin", op: "and", a: p, b: q })), name, settings) : {};
  if (!dom) return null;
  const put = (e: string) => (subs.length ? `subst(${e},[${subs.map((c) => `${t(c.a)}=${t(c.b)}`).join(",")}])` : e);
  const fixed = (await giac(put(`evalf([${others.map(t).join(",")}])`))).trim().replace(/^(list)?\[|\]$/g, "").split(",");
  if (fixed.length !== others.length || !fixed.every((f) => Number.isFinite(Number(f)) || /^[-+]?infinity$/.test(f.trim()))) return null;
  // Each integrand worked out (f(x) is f's body), and where its conditions change: 0≤x≤4 breaks at 0 and 4.
  const RELATIONS = ["<", ">", "≤", "≥", "=", "≠"];
  const bodies: (Ast | null)[] = [];
  const breaks: Ast[] = [];
  for (const I of integrals) {
    const v = (I.args[1] as Extract<Ast, { k: "sym" }>).name;
    const raw = (await giac(put(t(I.args[0]!)))).trim();
    if (!raw.includes("piecewise")) {
      bodies.push(null);
      continue;
    }
    let body: Ast;
    try {
      body = format(raw, { hint: "plain", digits: settings.digits });
    } catch {
      return null;
    }
    let plain = true;
    const links = (r: Ast): Ast[] => (r.k === "bin" && RELATIONS.includes(r.op) ? [...links(r.a), r.b] : [r]);
    mapAst(body, (y) => {
      if (y.k !== "bin" || !RELATIONS.includes(y.op)) return y;
      const ts = links(y);
      for (let k = 0; k + 1 < ts.length; k++) {
        const [p, q] = [ts[k]!, ts[k + 1]!];
        if (p.k === "sym" && p.name === v && !mentions(q, v)) breaks.push(q);
        else if (q.k === "sym" && q.name === v && !mentions(p, v)) breaks.push(p);
        else if (mentions(p, v) || mentions(q, v)) plain = false;
      }
      return y;
    });
    if (!plain) return null;
    bodies.push(body);
  }
  if (!breaks.length) return null;
  const at = (await giac(`evalf([${breaks.map(t).join(",")}])`)).trim().replace(/^(list)?\[|\]$/g, "").split(",").map(Number);
  if (at.length !== breaks.length || !at.every(Number.isFinite)) return null;
  const points = breaks
    .map((b, k) => ({ b, n: at[k]! }))
    .sort((p, q) => p.n - q.n)
    .filter((p, k, all) => k === 0 || p.n - all[k - 1]!.n > 1e-12 * Math.max(1, Math.abs(p.n)));
  const [dlo, dhi] = [dom.lo ? Number((await giac(`evalf(${dom.lo.v})`)).trim()) : -Infinity, dom.hi ? Number((await giac(`evalf(${dom.hi.v})`)).trim()) : Infinity];
  if (Number.isNaN(dlo) || Number.isNaN(dhi)) return null;
  const roots: number[] = [];
  // A part where the equation always holds (∫ of a pdf to m≥4 is 1) is all solution.
  const spans: { lo: number; hi: number }[] = [];
  for (let j = 0; j <= points.length; j++) {
    const [lo, hi] = [points[j - 1], points[j]];
    const [L, H] = [Math.max(lo?.n ?? -Infinity, dlo), Math.min(hi?.n ?? Infinity, dhi)];
    if (L > H) continue;
    const mid = lo && hi ? (lo.n + hi.n) / 2 : lo ? lo.n + 1 : hi!.n - 1;
    const end = (lo ?? hi)!.b;
    // Each piecewise's branch inside this part, by its conditions at the part's middle.
    const pieces: Ast[] = [];
    for (let i = 0; i < integrals.length; i++) {
      const body = bodies[i];
      if (!body) continue;
      const V = RENAME_IN[(integrals[i]!.args[1] as Extract<Ast, { k: "sym" }>).name] ?? (integrals[i]!.args[1] as Extract<Ast, { k: "sym" }>).name;
      const calls: Extract<Ast, { k: "call" }>[] = [];
      mapAst(body, (y) => {
        if (y.k === "call" && y.f === "piecewise") calls.push(y);
        return y;
      });
      const chosen: number[] = [];
      for (const pw of calls) {
        let pick = pw.args.length % 2 ? pw.args.length - 1 : -1;
        for (let k = 0; k + 1 < pw.args.length; k += 2) {
          const r = (await giac(`ifte(subst(${t(pw.args[k + 1]!)},${V}=${mid}),1,0)`)).trim();
          if (r !== "0" && r !== "1") return null;
          if (r === "1") {
            pick = k;
            break;
          }
        }
        // No branch holds and no otherwise: f is undef there.
        if (pick < 0) return null;
        chosen.push(pick);
      }
      let n = 0;
      pieces[i] = mapAst(body, (y) => (y.k === "call" && y.f === "piecewise" ? y.args[chosen[n++]!]! : y));
    }
    let i = 0;
    const split = mapAst(eq, (y) => {
      if (!target(y)) return y;
      const k = i++;
      const [body, piece] = [bodies[k], pieces[k]];
      if (!body || !piece) return y;
      const [v, from, to] = [y.args[1]!, y.args[2]!, y.args[3]!];
      const upper = to.k === "sym" && to.name === name;
      const whole: Ast = { k: "call", f: "∫", args: upper ? [body, v, from, end] : [body, v, end, to] };
      const part: Ast = { k: "call", f: "∫", args: upper ? [piece, v, end, to] : [piece, v, from, end] };
      return { k: "bin", op: "+", a: whole, b: part };
    }) as Extract<Ast, { k: "bin" }>;
    const d = (await giac(`normal(${put(`(${t(split.a)})-(${t(split.b)})`)})`)).trim().replace(/(?<![<>!=])=\s*[-+]?\d*\.\d*(?:e[-+]?\d+)?\s*$/i, "");
    if (!d || /integrate|undef|rror|piecewise/.test(d)) return null;
    if (d === "0") {
      spans.push({ lo: L, hi: H });
      continue;
    }
    let found: number[];
    if (Number.isFinite(L) && Number.isFinite(H)) found = await rootsIn(giac, `subst(${d},${X},x_)=0`, L, H);
    else {
      found = splitTop((await giac(`evalf(solve(${d}=0,${X}))`)).trim().replace(/^(list)?\[|\]$/g, ""))
        .filter((s) => s.trim())
        .map(Number);
      if (!found.every(Number.isFinite)) return null;
    }
    for (const r of found) {
      const tol = 1e-9 * Math.max(1, Math.abs(r));
      if (r < L - tol || r > H + tol) continue;
      if ((dom.lo && !dom.lo.closed && r <= dlo) || (dom.hi && !dom.hi.closed && r >= dhi)) continue;
      if (!roots.some((o) => Math.abs(o - r) <= tol)) roots.push(r);
    }
  }
  const show = (x: number): Ast => {
    if (!Number.isFinite(x)) return sym(x < 0 ? "-∞" : "∞");
    const s = formatFloat(x, settings.digits);
    return s.startsWith("-") ? { k: "neg", a: { k: "num", v: s.slice(1) } } : { k: "num", v: s };
  };
  // Parts that meet join up; a root inside one goes.
  spans.sort((p, q) => p.lo - q.lo);
  const joined: { lo: number; hi: number }[] = [];
  for (const sp of spans) {
    const last = joined[joined.length - 1];
    if (last && sp.lo <= last.hi + 1e-12) last.hi = Math.max(last.hi, sp.hi);
    else joined.push({ ...sp });
  }
  // Back from the bound u=c·m+d to the unknown m: m=(u−d)/c, the ends swapping when c<0.
  const un = (u: number) => (back ? (u - back.d) / back.c : u);
  const shown = back ? back.name : name;
  const answers: { at: number; e: Ast }[] = roots
    .filter((r) => !joined.some((sp) => r >= sp.lo - 1e-9 * Math.max(1, Math.abs(r)) && r <= sp.hi + 1e-9 * Math.max(1, Math.abs(r))))
    .map((r) => ({ at: un(r), e: { k: "bin", op: "=", a: sym(shown), b: show(un(r)) } }));
  for (const sp of joined) {
    const closed = (end: number, edge: number, open?: boolean) => !(end === edge && open);
    let [lo, hi] = [{ at: un(sp.lo), closed: closed(sp.lo, dlo, dom.lo && !dom.lo.closed) }, { at: un(sp.hi), closed: closed(sp.hi, dhi, dom.hi && !dom.hi.closed) }];
    if (lo.at > hi.at) [lo, hi] = [hi, lo];
    answers.push({ at: lo.at, e: interval({ at: show(lo.at), closed: lo.closed }, { at: show(hi.at), closed: hi.closed }, sym(shown)) });
  }
  answers.sort((p, q) => p.at - q.at);
  const output: Ast = answers.length ? answers.map((x) => x.e).reduce((p, q) => ({ k: "bin", op: "or", a: p, b: q })) : sym("false");
  return { ok: true, input: a, output, outputText: print(output) };
}

/**
 * solve(p(x)=q(x),x) and zeros(p,x) for a polynomial whose roots Giac's
 * exact solver aborts on: all roots from proot (the companion matrix's
 * eigenvalues, which doesn't miss any the way a numeric solve of the whole
 * polynomial can), the real ones polished by Newton's method, and the
 * domain of a "|" applied.
 */
async function polyRootsNumeric(a: Ast, giac: Giac, settings: Settings): Promise<EvalResult | null> {
  const call = a.k === "bin" && a.op === "|" ? a.a : a;
  const cond = a.k === "bin" && a.op === "|" ? a.b : undefined;
  if (!(call.k === "call" && ["solve", "zeros", "polyRoots"].includes(call.f) && call.args[0])) return null;
  const [e, v] = call.args;
  const name = v?.k === "sym" ? v.name : !v ? "x" : null;
  if (!name || (e!.k === "bin" && (e!.op === "and" || e!.op in INEQ || e!.op === "≠"))) return null;
  const expr: Ast = e!.k === "bin" && e!.op === "=" ? { k: "bin", op: "-", a: e!.a, b: e!.b } : e!;
  let decimal = false;
  mapAst(expr, (y) => {
    if (y.k === "call" && y.f === "approx") decimal = true;
    return y;
  });
  if (decimal || !(await riskyPoly(expr, name, giac, settings))) return null;
  const E = translate(expr, settings).giac;
  const X = RENAME_IN[name] ?? name;
  const raw = (await giac(`proot(symb2poly(evalf(${E}),${X}))`)).trim().replace(/^(list)?\[|\]$/g, "");
  const roots: number[] = [];
  for (const r of splitTop(raw)) {
    const z = (await giac(`[evalf(re(${r})),evalf(im(${r}))]`)).replace(/^\[|\]$/g, "").split(",").map(Number);
    if (z.length !== 2 || !z.every(Number.isFinite) || Math.abs(z[1]!) > 1e-7 * Math.max(1, Math.abs(z[0]!))) continue;
    const polished = Number((await giac(`fsolve(${E}=0,${X}=${z[0]})`)).trim().replace(/^(list)?\[|\]$/g, "").split(",")[0]);
    const x = Number.isFinite(polished) && Math.abs(polished - z[0]!) < 1e-3 * Math.max(1, Math.abs(z[0]!)) ? polished : z[0]!;
    if (!roots.some((o) => Math.abs(o - x) <= 1e-9 * Math.max(1, Math.abs(x)))) roots.push(x);
  }
  roots.sort((p, q) => p - q);
  const show = (x: number): Ast => shownDecimal(x, settings.digits);
  let kept = roots;
  if (cond) {
    const dom = domainOf(cond, name, settings);
    if (!dom) return null;
    const [lo, hi] = [dom.lo ? Number((await giac(`evalf(${dom.lo.v})`)).trim()) : -Infinity, dom.hi ? Number((await giac(`evalf(${dom.hi.v})`)).trim()) : Infinity];
    kept = roots.filter((x) => (dom.lo?.closed ? x >= lo - 1e-12 : x > lo + 1e-12) && (dom.hi?.closed ? x <= hi + 1e-12 : x < hi - 1e-12));
  }
  let output: Ast;
  if (call.f === "solve") output = kept.length ? kept.map((x): Ast => ({ k: "bin", op: "=", a: sym(name), b: show(x) })).reduce((p, q) => ({ k: "bin", op: "or", a: p, b: q })) : sym("false");
  else output = { k: "list", items: kept.map(show) };
  return { ok: true, input: a, output, outputText: print(output) };
}

/**
 * ∫ of a fraction whose denominator is a polynomial Giac's exact algebra
 * aborts on (1/(x³−3x−4)): a definite integral is worked numerically, and
 * an indefinite one is left as it is rather than taking the engine down.
 */
/**
 * A definite integral across a pole is undef on the handheld; Giac gives the
 * principal value (∫(1/x,x,−1,1) and ∫(tan(x),x,0,π) were 0). Each singular
 * point of the integrand in [a,b] is checked: if the antiderivative runs off
 * to infinity there from inside the interval, the integral diverges.
 * A removable point (sin(x)/x at 0) has finite limits and passes.
 */
async function divergentIntegral(a: Ast, giac: Giac, settings: Settings): Promise<EvalResult | null> {
  if (!(a.k === "call" && (a.f === "∫" || a.f === "integral") && a.args.length >= 4 && a.args[1]?.k === "sym")) return null;
  const tr = (x: Ast) => translate(x, settings).giac;
  const F = tr(a.args[0]!);
  const X = RENAME_IN[a.args[1].name] ?? a.args[1].name;
  const ends = [Number((await giac(`evalf(${tr(a.args[2]!)})`)).trim()), Number((await giac(`evalf(${tr(a.args[3]!)})`)).trim())];
  if (!ends.every(Number.isFinite)) return null;
  const [lo, hi] = [Math.min(...ends), Math.max(...ends)];
  const exact = (await giac(`singular(${F},${X})`)).trim();
  if (!/^(list)?\[.*\]$/.test(exact) || exact.replace(/^(list)?\[|\]$/g, "") === "") return null;
  const points = splitTop(exact.replace(/^(list)?\[|\]$/g, ""));
  const inside: string[] = [];
  for (const p of points) {
    const n = Number((await giac(`evalf(${p})`)).trim());
    if (Number.isFinite(n) && n >= lo && n <= hi) inside.push(p);
  }
  if (!inside.length) return null;
  // Where Giac already says ±∞ (∫(1/x^2,x,−1,1)) its answer stands; only a finite principal value is wrong.
  const whole = (await giac(`integrate(${F},${X},${tr(a.args[2]!)},${tr(a.args[3]!)})`)).trim();
  if (/infinity/.test(whole)) return null;
  const G = (await giac(`integrate(${F},${X})`)).trim();
  if (/error|integrate\(|undef/i.test(G)) return null;
  for (const p of inside) {
    const n = Number((await giac(`evalf(${p})`)).trim());
    for (const dir of [...(n > lo ? [-1] : []), ...(n < hi ? [1] : [])]) {
      const lim = (await giac(`limit(${G},${X},${p},${dir})`)).trim();
      if (/infinity|undef/.test(lim)) return { ok: true, input: a, output: sym("undef"), outputText: "undef" };
    }
  }
  return null;
}

async function riskyIntegral(a: Ast, giac: Giac, settings: Settings): Promise<EvalResult | null> {
  if (!(a.k === "call" && (a.f === "∫" || a.f === "integral") && a.args[0] && a.args[1]?.k === "sym")) return null;
  const v = a.args[1].name;
  const dens: Ast[] = [];
  mapAst(a.args[0], (y) => {
    if (y.k === "bin" && y.op === "/") dens.push(y.b);
    if (y.k === "bin" && y.op === "^" && (y.b.k === "neg" || (y.b.k === "num" && y.b.v.startsWith("-")))) dens.push(y.a);
    return y;
  });
  let risky = false;
  for (const d of dens) if (await riskyPoly(d, v, giac, settings)) risky = true;
  if (!risky) return null;
  if (a.args.length >= 4) {
    const r = (await giac(`romberg(${translate(a.args[0], settings).giac},${RENAME_IN[v] ?? v},${translate(a.args[2]!, settings).giac},${translate(a.args[3]!, settings).giac})`)).trim();
    const n = Number(r);
    if (!Number.isFinite(n)) return { ok: false, input: a, error: "Error: Invalid input" };
    const output = shownDecimal(n, settings.digits);
    return { ok: true, input: a, output, outputText: print(output) };
  }
  return { ok: true, input: a, output: a, outputText: print(a) };
}

/** An antiderivative the handheld can't write: it has no erf, Si, Ci, Ei or Fresnel functions. */
const SPECIAL = /\b(erfc?|Si|Ci|Ei|Shi|Chi|Fresnel[CS]?)\(/;

function mentionsName(e: Ast, v: string): boolean {
  let found = false;
  mapAst(e, (y) => {
    if (y.k === "sym" && y.name === v) found = true;
    return y;
  });
  return found;
}

const product = (fs: Ast[]): Ast | null => (fs.length ? fs.reduce((p, q) => ({ k: "bin", op: "*", a: p, b: q })) : null);

/** Commands that do calculus on what they're given: an inert ∫ inside one isn't a plain value. */
const CALCULUS = new Set(["d", "derivative", "∫", "integral", "limit", "lim", "solve", "cSolve", "zeros", "cZeros", "nSolve", "fMin", "fMax", "nfMin", "nfMax", "Σ", "sumSeq", "Π", "taylor", "series", "nInt", "arcLen", "deSolve", "tangentLine", "normalLine", "nDerivative", "dominantTerm"]);

/**
 * A non-elementary ∫ inside a larger expression, ∫(ℯ^(-x^2),x)/2. The
 * handheld has no erf, Si or Ei, so such an integral is left as one whatever
 * surrounds it; Giac gave √(π)/4*erf(x). Each is worked out on its own as
 * nonElementaryIntegral does, held as a name while the arithmetic around it
 * is done, and put back. Only through arithmetic and functions: under d,
 * limit, solve and the like it is the integral itself that is worked on.
 */
async function inertInside(a: Ast, giac: Giac, opts: { settings: Settings; ans?: Ast; approx?: boolean }): Promise<EvalResult | null> {
  if (a.k === "call" && (a.f === "∫" || a.f === "integral")) return null;
  const integrals: Ast[] = [];
  // A Define or a store would keep the stand-in name, not the integral.
  let blocked = a.k === "define" || (a.k === "bin" && ["|", "→", ":=", ":"].includes(a.op));
  mapAst(a, (y) => {
    if (y.k === "call" && (y.f === "∫" || y.f === "integral")) {
      if (y.args.some(holdsIntegral)) blocked = true;
      else if (!integrals.some((i) => print(i) === print(y))) integrals.push(y);
    } else if (y.k === "call" && CALCULUS.has(y.f)) blocked = true;
    return y;
  });
  if (blocked || !integrals.length) return null;
  const held: { name: string; e: Ast; out: Ast }[] = [];
  for (const I of integrals) {
    const r = await nonElementaryIntegral(I, giac, opts.settings);
    const name = `inrt${String.fromCharCode(97 + held.length)}`;
    if (r?.ok && !mentionsName(a, name)) held.push({ name, e: I, out: r.output });
  }
  if (!held.length) return null;
  const swapped = mapAst(a, (y) => held.find((h) => print(h.e) === print(y)) ? sym(held.find((h) => print(h.e) === print(y))!.name) : y);
  const r = await evaluate(print(swapped), giac, opts);
  if (!r.ok) return null;
  const output = mapAst(r.output, (y) => (y.k === "sym" && held.some((h) => h.name === y.name) ? held.find((h) => h.name === y.name)!.out : y));
  return { ok: true, input: a, output, outputText: print(output) };
}

/**
 * ∫ of a function with no elementary antiderivative, indefinite or to a
 * symbolic bound. The handheld has no erf or Si, so it leaves each such term
 * as an integral, its constant factors pulled out, and works the rest:
 * ∫(b·ℯ^(−x²)+a/(x²+a²),x) is b·∫(ℯ^(−x²),x)+tan⁻¹(x/a),
 * and ∫(ℯ^(−x²),x) is itself. With number bounds it is a
 * decimal, as before. Giac's erf of a complex argument (∫ of sin(t²) to x)
 * was a non-real error.
 */
async function nonElementaryIntegral(a: Ast, giac: Giac, settings: Settings): Promise<EvalResult | null> {
  if (!(a.k === "call" && (a.f === "∫" || a.f === "integral") && (a.args.length === 2 || a.args.length === 4) && a.args[1]?.k === "sym")) return null;
  const t = (x: Ast) => translate(x, settings).giac;
  const v = a.args[1].name;
  const X = RENAME_IN[v] ?? v;
  const bounds = a.args.slice(2);
  if (bounds.length) {
    const ends = (await giac(`evalf([${bounds.map(t).join(",")}])`)).trim().replace(/^(list)?\[|\]$/g, "").split(",");
    if (ends.every((n) => Number.isFinite(Number(n)) || /^[-+]?infinity$/.test(n.trim()))) return null;
  }
  const F = (await giac(toGiac(a.args[0]!, settings))).trim();
  if (/piecewise|error|undef|integrate/i.test(F)) return null;
  if (!SPECIAL.test((await giac(`integrate(${F},${X})`)).trim())) return null;
  let body: Ast;
  try {
    body = format(F, { hint: "plain", digits: settings.digits });
  } catch {
    return null;
  }
  const terms: { neg: boolean; e: Ast }[] = [];
  const collect = (e: Ast, neg: boolean) => {
    if (e.k === "bin" && (e.op === "+" || e.op === "-")) {
      collect(e.a, neg);
      collect(e.b, e.op === "-" ? !neg : neg);
    } else if (e.k === "neg") collect(e.a, !neg);
    else terms.push({ neg, e });
  };
  collect(body, false);
  const tail = bounds.length ? `,${bounds.map(t).join(",")}` : "";
  const parts: { neg: boolean; e: Ast }[] = [];
  for (const term of terms) {
    let neg = term.neg;
    const [num, den]: [Ast[], Ast[]] = [[], []];
    const split = (e: Ast, up: boolean) => {
      if (e.k === "bin" && e.op === "*") {
        split(e.a, up);
        split(e.b, up);
      } else if (e.k === "bin" && e.op === "/") {
        split(e.a, up);
        split(e.b, !up);
      } else if (e.k === "neg") {
        neg = !neg;
        split(e.a, up);
      } else (up ? num : den).push(e);
    };
    split(term.e, true);
    const has = (e: Ast) => mentionsName(e, v);
    const hn: Ast = product(num.filter(has)) ?? { k: "num", v: "1" };
    const hd = product(den.filter(has));
    const h: Ast = hd ? { k: "bin", op: "/", a: hn, b: hd } : hn;
    const G = (await giac(`integrate(${toGiac(h, settings)},${X}${tail})`)).trim();
    if (/error/i.test(G)) return null;
    if (SPECIAL.test(G) || /integrate\(/.test(G)) {
      const [cn, cd] = [product(num.filter((f) => !has(f))), product(den.filter((f) => !has(f)))];
      const I: Ast = { k: "call", f: "∫", args: [h, a.args[1], ...bounds] };
      // b·∫(…) and ∫(…)/2, as the handheld writes a constant multiple.
      const up: Ast = cn ? { k: "bin", op: "*", a: cn, b: I } : I;
      parts.push({ neg, e: cd ? { k: "bin", op: "/", a: up, b: cd } : up });
      continue;
    }
    let raw = (await giac(`regroup(integrate(${toGiac(term.e, settings)},${X}${tail}))`)).trim();
    if (/error|undef|integrate/i.test(raw)) return null;
    // a/(x²+a²) comes back 2·a·tan⁻¹(x/a)/(2·a).
    const n = (await giac(`normal(${raw})`)).trim();
    if (!/error|undef/i.test(n) && n.length < raw.length) raw = n;
    let e: Ast;
    try {
      e = format(raw, { hint: "plain", digits: settings.digits });
    } catch {
      return null;
    }
    parts.push(e.k === "neg" ? { neg: !term.neg, e: e.a } : { neg: term.neg, e });
  }
  const output = parts.slice(1).reduce<Ast>((p, q) => ({ k: "bin", op: q.neg ? "-" : "+", a: p, b: q.e }), parts[0]!.neg ? { k: "neg", a: parts[0]!.e } : parts[0]!.e);
  return { ok: true, input: a, output, outputText: print(output) };
}

function holdsIntegral(e: Ast): boolean {
  let found = false;
  mapAst(e, (y) => {
    if (y.k === "call" && (y.f === "∫" || y.f === "integral")) found = true;
    return y;
  });
  return found;
}

/**
 * d of an integral to a bound in x whose integrand has no elementary
 * antiderivative. The handheld keeps such an integral as it is
 * (nonElementaryIntegral) and differentiates it by the fundamental theorem:
 * d(∫(sin(t²),t,0,x),x) is sin(x²), d(∫(ℯ^(t²),t,0,x),x) is ℯ^(x²)
 * as on the handheld. Giac worked the integral first, to erf of
 * a complex argument, and the derivative came back as a non-real error. Sums and
 * constant multiples are taken term by term; anything else is left to Giac.
 */
async function leibniz(a: Ast, giac: Giac, settings: Settings): Promise<Ast | null> {
  const call = core(a);
  if (!(call.k === "call" && (call.f === "d" || call.f === "derivative") && call.args.length === 2 && call.args[1]!.k === "sym")) return null;
  const wrt = call.args[1];
  const x = wrt.name;
  let used = false;
  const D = async (e: Ast): Promise<Ast> => {
    const left: Ast = { k: "call", f: call.f, args: [e, wrt] };
    if (!mentionsName(e, x)) return left;
    if (e.k === "bin" && (e.op === "+" || e.op === "-")) return { k: "bin", op: e.op, a: await D(e.a), b: await D(e.b) };
    if (e.k === "neg") return { k: "neg", a: await D(e.a) };
    if (e.k === "bin" && e.op === "*" && !mentionsName(e.a, x)) return { k: "bin", op: "*", a: e.a, b: await D(e.b) };
    if (e.k === "bin" && (e.op === "*" || e.op === "/") && !mentionsName(e.b, x)) return { k: "bin", op: e.op, a: await D(e.a), b: e.b };
    // Through a product, quotient, power or function of an integral (x·∫(…), sin(∫(…))): the
    // product and chain rules, the other parts' derivatives worked out at once, so what's left
    // to evaluate is plain arithmetic around the integral (inertInside keeps it as it is).
    if (holdsIntegral(e) && !(e.k === "call" && (e.f === "∫" || e.f === "integral"))) {
      const Dn = async (u: Ast): Promise<Ast | null> => {
        if (holdsIntegral(u)) return D(u);
        const r = await evaluate(print({ k: "call", f: call.f, args: [u, wrt] }), giac, { settings });
        return r.ok ? r.output : null;
      };
      const op = (o: "*" | "/" | "-" | "^") => (p: Ast, q: Ast): Ast => ({ k: "bin", op: o, a: p, b: q });
      const [mul, div, sub, pow] = [op("*"), op("/"), op("-"), op("^")];
      const two: Ast = { k: "num", v: "2" };
      const one: Ast = { k: "num", v: "1" };
      if (e.k === "bin" && (e.op === "*" || e.op === "/")) {
        const [da, db] = [await Dn(e.a), await Dn(e.b)];
        if (!da || !db) return left;
        return e.op === "*" ? { k: "bin", op: "+", a: mul(da, e.b), b: mul(e.a, db) } : div(sub(mul(da, e.b), mul(e.a, db)), pow(e.b, two));
      }
      if (e.k === "bin" && e.op === "^" && !mentionsName(e.b, x)) {
        const da = await Dn(e.a);
        return da ? mul(mul(e.b, pow(e.a, sub(e.b, one))), da) : left;
      }
      if (e.k === "bin" && e.op === "^" && e.a.k === "sym" && e.a.name === "ℯ") {
        const db = await Dn(e.b);
        return db ? mul(e, db) : left;
      }
      const outer: Record<string, (u: Ast) => Ast> = {
        sin: (u) => ({ k: "call", f: "cos", args: [u] }),
        cos: (u) => ({ k: "neg", a: { k: "call", f: "sin", args: [u] } }),
        tan: (u) => div(one, pow({ k: "call", f: "cos", args: [u] }, two)),
        ln: (u) => div(one, u),
        "√": (u) => div(one, mul(two, { k: "call", f: "√", args: [u] })),
      };
      if (e.k === "call" && e.args.length === 1 && outer[e.f]) {
        const du = await Dn(e.args[0]!);
        return du ? mul(outer[e.f]!(e.args[0]!), du) : left;
      }
      return left;
    }
    if (!(e.k === "call" && (e.f === "∫" || e.f === "integral") && e.args.length === 4 && e.args[1]!.k === "sym")) return left;
    const [g, lo, hi] = [e.args[0]!, e.args[2]!, e.args[3]!];
    const v = e.args[1].name;
    if (v === x || mentionsName(g, x)) return left;
    const F = (await giac(toGiac(g, settings))).trim();
    if (/piecewise|error/i.test(F) || !SPECIAL.test((await giac(`integrate(${F},${RENAME_IN[v] ?? v})`)).trim())) return left;
    // g(b)·b′ at a bound b in x: just g(x) at x itself. b′ is worked out here: a d(…) left in
    // the answer would send the integral beside it (x·∫(sin(t^2),t,0,x^2)) back to Giac as erf.
    const at = async (b: Ast): Promise<Ast> => {
      const gb = mapAst(g, (y) => (y.k === "sym" && y.name === v ? b : y));
      if (b.k === "sym" && b.name === x) return gb;
      const db: Ast = { k: "call", f: call.f, args: [b, wrt] };
      const r = await evaluate(print(db), giac, { settings });
      return { k: "bin", op: "*", a: gb, b: r.ok ? r.output : db };
    };
    const [up, down] = [mentionsName(hi, x), mentionsName(lo, x)];
    used = true;
    return up && down ? { k: "bin", op: "-", a: await at(hi), b: await at(lo) } : up ? await at(hi) : { k: "neg", a: await at(lo) };
  };
  const out = await D(call.args[0]!);
  if (!used) return null;
  return a.k === "bin" && a.op === "|" ? { ...a, a: out } : out;
}

/**
 * solve with the unknown as a bound of ∫: a root past a pole of the
 * integrand goes, since the integral doesn't exist there. ∫(1/t,t,1,k) is
 * ln|k| to Giac, so ln|k|=2 gave k=−ℯ² beside k=ℯ², but ∫ from 1 to −ℯ² runs
 * through t=0 and diverges (∫(1/x,x,−1,1) is undef on the handheld). The
 * handheld itself keeps k=−ℯ².
 */
async function rootsPastPoles(out: Ast, a: Ast, giac: Giac, settings: Settings): Promise<Ast> {
  const call = core(a);
  if (!(call.k === "call" && call.f === "solve" && call.args.length === 2 && call.args[1]!.k === "sym")) return out;
  const name = call.args[1].name;
  const found: Extract<Ast, { k: "call" }>[] = [];
  mapAst(call.args[0]!, (y) => {
    if (y.k === "call" && (y.f === "∫" || y.f === "integral") && y.args.length === 4 && y.args[1]!.k === "sym" && !mentionsName(y.args[0]!, name) && [y.args[2]!, y.args[3]!].filter((b) => mentionsName(b, name)).length === 1) found.push(y);
    return y;
  });
  const integrals: Extract<Ast, { k: "call" }>[] = [];
  // Not a piecewise: Giac's singular points of one can take the engine down.
  for (const I of found) if (!/piecewise|error/i.test(await giac(toGiac(I.args[0]!, settings)))) integrals.push(I);
  if (!integrals.length) return out;
  const items: Ast[] = [];
  const walk = (x: Ast): void => {
    if (x.k === "bin" && x.op === "or") {
      walk(x.a);
      walk(x.b);
    } else items.push(x);
  };
  walk(out);
  const kept: Ast[] = [];
  for (const s of items) {
    let ok = true;
    if (s.k === "bin" && s.op === "=" && s.a.k === "sym" && s.a.name === name && !mentionsName(s.b, name))
      for (const I of integrals) {
        const at = mapAst(I, (y) => (y.k === "sym" && y.name === name ? s.b : y));
        const r = await divergentIntegral(at, giac, settings);
        if (r?.ok && r.outputText === "undef") ok = false;
      }
    if (ok) kept.push(s);
  }
  if (kept.length === items.length) return out;
  return kept.length ? kept.reduce((p, q) => ({ k: "bin", op: "or", a: p, b: q })) : sym("false");
}

/**
 * ∫(f(x),x,0,2*m) of a piecewise: a bound c·m+d rather than m. Worked out
 * to a plain bound u, as piecewiseIntegral does, then u=c·m+d put back: each
 * value with u replaced, and each part's ends (u<0, 0≤u<4, u≥4) moved to m's
 * (m<0, 0≤m<2, m≥2), swapping sides when c<0. Giac throws on it otherwise.
 */
async function scaledIntegral(whole: Ast, a: Extract<Ast, { k: "call" }>, giac: Giac, settings: Settings): Promise<EvalResult | null> {
  const t = (x: Ast) => toGiac(x, settings);
  const v = (a.args[1] as Extract<Ast, { k: "sym" }>).name;
  const [from, to] = [a.args[2]!, a.args[3]!];
  const names = (e: Ast) => freeNames(e).filter((n) => n !== v);
  const which = [from, to].findIndex((b) => b.k !== "sym" && names(b).length === 1);
  if (which < 0 || names([from, to][1 - which]!).length) return null;
  const B = [from, to][which]!;
  const name = names(B)[0]!;
  if (mentionsName(a.args[0]!, name) || mentionsName(a.args[0]!, "ubnd")) return null;
  const M = RENAME_IN[name] ?? name;
  // A fraction prints as exact=decimal (1/2=0.5 for m/2): the exact side is the number.
  const exact = async (e: string) => (await giac(e)).trim().replace(/=[-+]?[\d.]+(e[-+]?\d+)?$/, "");
  const [c, d] = [await exact(`normal(diff(${t(B)},${M}))`), await exact(`normal(subst(${t(B)},${M},0))`)];
  const cn = Number((await giac(`evalf(${c})`)).trim());
  if (!Number.isFinite(cn) || cn === 0 || !Number.isFinite(Number((await giac(`evalf(${d})`)).trim()))) return null;
  // A number, not the text "0": with a decimal coefficient (0.5*m) Giac's zero is 0.0.
  if (Number((await giac(`normal((${t(B)})-(${c})*${M}-(${d}))`)).trim()) !== 0) return null;
  const args = [...a.args];
  args[which + 2] = sym("ubnd");
  const plain: Ast = { ...a, args };
  const inner = await piecewiseIntegral(whole.k === "bin" && whole.op === "|" ? { ...whole, a: plain } : plain, giac, settings);
  if (!inner?.ok || !(inner.output.k === "call" && inner.output.f === "piecewise")) return null;
  const parts = inner.output.args;
  const out: Ast[] = [];
  const back = async (e: string) => format((await giac(`normal(((${e})-(${d}))/(${c}))`)).trim(), { hint: "plain", digits: settings.digits });
  for (let k = 0; k + 1 < parts.length; k += 2) {
    const value = (await giac(`normal(subst(${t(parts[k]!)},ubnd,${t(B)}))`)).trim();
    if (/error|undef/i.test(value)) return null;
    const dom = domainOf(parts[k + 1]!, "ubnd", settings);
    if (!dom) return null;
    let lo = dom.lo ? { at: await back(dom.lo.v), closed: dom.lo.closed } : { at: sym("-∞"), closed: false };
    let hi = dom.hi ? { at: await back(dom.hi.v), closed: dom.hi.closed } : { at: sym("∞"), closed: false };
    if (cn < 0) [lo, hi] = [hi.at.k === "sym" && hi.at.name === "∞" ? { at: sym("-∞"), closed: false } : hi, lo.at.k === "sym" && lo.at.name === "-∞" ? { at: sym("∞"), closed: false } : lo];
    out.push(format(value, { hint: "plain", digits: settings.digits }), interval(lo, hi, sym(name)));
  }
  const output: Ast = { k: "call", f: "piecewise", args: out };
  return { ok: true, input: whole, output, outputText: print(output) };
}

/**
 * ∫ of a piecewise to a symbolic bound, ∫(f(x),x,0,m) for a Defined pdf:
 * Giac throws on it, uncatchably, and the engine went down. So the bound's
 * range is cut at the break points and the integral worked on each part as
 * ∫(f,x,a,c) + ∫(piece,x,c,m), c the part's end and the piece f's branch
 * there (picked by its conditions at the part's middle), as
 * piecewiseBoundSolve does. The answer is a piecewise in the bound: for
 * 3/32·x·(4−x) on 0≤x≤4 it is 0 for m<0, the cubic for 0≤m<4 and 1 for m≥4.
 */
async function piecewiseIntegral(a: Ast, giac: Giac, settings: Settings): Promise<EvalResult | null> {
  const whole = a;
  a = core(a);
  if (!(a.k === "call" && (a.f === "∫" || a.f === "integral") && a.args.length === 4 && a.args[1]?.k === "sym")) return null;
  const scaled = await scaledIntegral(whole, a, giac, settings);
  if (scaled) return scaled;
  const v = a.args[1].name;
  const V = RENAME_IN[v] ?? v;
  const t = (x: Ast) => toGiac(x, settings);
  // A "|" supplies values for other names: ∫(h(x),x,0,m)|a=1/2.
  const conds = whole.k === "bin" && whole.op === "|" ? conjuncts(whole.b) : [];
  if (!conds.every((c) => c.k === "bin" && c.op === "=" && c.a.k === "sym")) return null;
  const put = (e: string) => (conds.length ? `subst(${e},[${conds.map((c) => `${t((c as Extract<Ast, { k: "bin" }>).a)}=${t((c as Extract<Ast, { k: "bin" }>).b)}`).join(",")}])` : e);
  const [from, to] = [a.args[2]!, a.args[3]!];
  const number = async (e: Ast) => {
    const n = (await giac(`evalf(${t(e)})`)).trim();
    return Number.isFinite(Number(n)) || /^[-+]?infinity$/.test(n);
  };
  const named = (e: Ast) => e.k === "sym" && e.name !== v;
  const upper = named(to) && !(await number(to)) && (await number(from));
  if (!upper && !(named(from) && !(await number(from)) && (await number(to)))) return null;
  const bound = (upper ? to : from) as Extract<Ast, { k: "sym" }>;
  const M = RENAME_IN[bound.name] ?? bound.name;
  const raw = (await giac(put(t(a.args[0]!)))).trim();
  if (!raw.includes("piecewise") || mentionsName(a.args[0]!, bound.name)) return null;
  let body: Ast;
  try {
    body = format(raw, { hint: "plain", digits: settings.digits });
  } catch {
    return null;
  }
  // Where the conditions change: 0≤x≤4 breaks at 0 and 4.
  const RELATIONS = ["<", ">", "≤", "≥", "=", "≠"];
  const links = (r: Ast): Ast[] => (r.k === "bin" && RELATIONS.includes(r.op) ? [...links(r.a), r.b] : [r]);
  const breaks: Ast[] = [];
  let plain = true;
  mapAst(body, (y) => {
    if (y.k !== "bin" || !RELATIONS.includes(y.op)) return y;
    const ts = links(y);
    for (let k = 0; k + 1 < ts.length; k++) {
      const [p, q] = [ts[k]!, ts[k + 1]!];
      if (p.k === "sym" && p.name === v && !mentionsName(q, v)) breaks.push(q);
      else if (q.k === "sym" && q.name === v && !mentionsName(p, v)) breaks.push(p);
      else if (mentionsName(p, v) || mentionsName(q, v)) plain = false;
    }
    return y;
  });
  if (!plain || !breaks.length) return null;
  const at = (await giac(`evalf([${breaks.map(t).join(",")}])`)).trim().replace(/^(list)?\[|\]$/g, "").split(",").map(Number);
  if (at.length !== breaks.length || !at.every(Number.isFinite)) return null;
  const points = breaks
    .map((b, k) => ({ b, n: at[k]! }))
    .sort((p, q) => p.n - q.n)
    .filter((p, k, all) => k === 0 || p.n - all[k - 1]!.n > 1e-12 * Math.max(1, Math.abs(p.n)));
  const calls: Extract<Ast, { k: "call" }>[] = [];
  mapAst(body, (y) => {
    if (y.k === "call" && y.f === "piecewise") calls.push(y);
    return y;
  });
  const args: Ast[] = [];
  for (let j = 0; j <= points.length; j++) {
    const [lo, hi] = [points[j - 1], points[j]];
    const mid = lo && hi ? (lo.n + hi.n) / 2 : lo ? lo.n + 1 : hi!.n - 1;
    const chosen: number[] = [];
    for (const pw of calls) {
      let pick = pw.args.length % 2 ? pw.args.length - 1 : -1;
      for (let k = 0; k + 1 < pw.args.length; k += 2) {
        const r = (await giac(`ifte(subst(${t(pw.args[k + 1]!)},${V}=${mid}),1,0)`)).trim();
        if (r !== "0" && r !== "1") return null;
        if (r === "1") {
          pick = k;
          break;
        }
      }
      // No branch holds and no otherwise: f is undef there.
      if (pick < 0) return null;
      chosen.push(pick);
    }
    let n = 0;
    const piece = mapAst(body, (y) => (y.k === "call" && y.f === "piecewise" ? y.args[chosen[n++]!]! : y));
    const end = t((lo ?? hi)!.b);
    const [F, P] = [raw, t(piece)];
    const sum = upper ? `integrate(${F},${V},${t(from)},${end})+integrate(${P},${V},${end},${M})` : `integrate(${P},${V},${M},${end})+integrate(${F},${V},${end},${t(to)})`;
    const value = (await giac(`normal(${sum})`)).trim();
    if (/error|undef|integrate|piecewise/i.test(value)) return null;
    let e: Ast;
    try {
      e = format(value, { hint: "plain", digits: settings.digits });
    } catch {
      return null;
    }
    // m<0, 0≤m<4, m≥4: each value once, the integral being continuous in m.
    args.push(e, interval(lo ? { at: lo.b, closed: true } : { at: sym("-∞"), closed: false }, hi ? { at: hi.b, closed: false } : { at: sym("∞"), closed: false }, bound));
  }
  const output: Ast = { k: "call", f: "piecewise", args };
  return { ok: true, input: whole, output, outputText: print(output) };
}

/**
 * ∫(f(x),x,0,m)|m=1 for a piecewise f: Giac works the integral to m before
 * it puts m=1 in, and that takes it down (piecewiseIntegral), so the value
 * goes into the bound first.
 */
function boundsFirst(a: Ast, piecewise: boolean): Ast | null {
  if (!(a.k === "bin" && a.op === "|" && piecewise)) return null;
  const I = a.a;
  if (!(I.k === "call" && (I.f === "∫" || I.f === "integral") && I.args.length === 4)) return null;
  const conds = conjuncts(a.b);
  const name = (c: Ast) => (c.k === "bin" && c.op === "=" && c.a.k === "sym" ? c.a.name : null);
  const used = conds.filter((c) => {
    const n = name(c);
    return n !== null && [I.args[2]!, I.args[3]!].some((b) => mentionsName(b, n));
  }) as Extract<Ast, { k: "bin" }>[];
  if (!used.length) return null;
  const put = (e: Ast) =>
    mapAst(e, (y) => {
      const c = y.k === "sym" ? used.find((u) => name(u) === y.name) : undefined;
      return c ? c.b : y;
    });
  const J: Ast = { ...I, args: [I.args[0]!, I.args[1]!, put(I.args[2]!), put(I.args[3]!)] };
  const rest = conds.filter((c) => !used.includes(c as Extract<Ast, { k: "bin" }>));
  return rest.length ? { k: "bin", op: "|", a: J, b: rest.reduce((p, q) => ({ k: "bin", op: "and", a: p, b: q })) } : J;
}
