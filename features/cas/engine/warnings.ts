// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 VCE Hub. Part of the /cas calculator: https://github.com/vcehub/cas
import { mapAst, type Ast } from "../math/ast";
import { giacName, toGiac, type Ctx } from "./translate";

/**
 * The handheld's ⚠ warnings: the answer stands, and a triangle beside the
 * entry opens the message. Each is keyed by what it warns of, and each
 * message is in our own words.
 * One line per string; "" is the blank line between paragraphs.
 */
export const WARNINGS = {
  accuracy: ["The accuracy of this result is in doubt.", "", "Where you can, check it on a graph."],
  moreSolutions: [
    "There may be more solutions. Give a range for the variable, a starting guess, or both.",
    "For example:",
    "◆ solve(equation, x=guess)|low<x<high",
    "◆ solve(equation, x)|low<x<high",
    "◆ solve(equation, x=guess)",
    "Where you can, check the answer on a graph.",
  ],
  widerDomain: ["The result may hold for more values than the input does."],
  freeParameter: ["The input has a parameter with no value.", "", "The result may not hold for every value of it."],
  identityMatrix: ["The number was multiplied by the identity matrix first."],
  conditionIgnored: [
    "The condition may have been ignored. Write it as a variable, a comparison and a number (x<3), or join several with and: x<3 and x>−12.",
  ],
} satisfies Record<string, string[]>;

export type WarningCode = keyof typeof WARNINGS;
export type Warning = { code: WarningCode; text: string[] };

export const warning = (code: WarningCode): Warning => ({ code, text: WARNINGS[code] });

type Giac = (cmd: string) => Promise<string>;

const has = (a: Ast, test: (x: Ast) => boolean): boolean => {
  let found = false;
  mapAst(a, (x) => {
    if (!found && test(x)) found = true;
    return x;
  });
  return found;
};
const symbols = (a: Ast): string[] => {
  const names = new Set<string>();
  mapAst(a, (x) => {
    if (x.k === "sym" && /^[A-Za-z]\w*$/.test(x.name)) names.add(x.name);
    return x;
  });
  return [...names];
};
/** Giac's text for part of an input, its names renamed as translate() does. */
const giacText = (a: Ast, s: Ctx) => toGiac(mapAst(a, (x) => (x.k === "sym" ? { k: "sym", name: giacName(x.name) } : x)), s);
/** Work that stores something isn't done twice. */
const stores = (a: Ast) => has(a, (x) => x.k === "define" || (x.k === "bin" && x.op === "→"));

/**
 * The warnings an answer carries for what its input asked, raised after the
 * answer is worked out (a bound with a parameter in it raises its own, in
 * parameterBounds). The handheld can raise several;
 * the first that applies is kept.
 */
export async function inputWarning(a: Ast, output: Ast, giac: Giac, s: Ctx & { approx?: boolean }): Promise<Warning | undefined> {
  if (a.k === "define") return undefined;
  const worked = given(a);
  if (await scalarOnMatrix(worked, giac, s)) return warning("identityMatrix");
  const symbolic = await symbolicMatrix(worked, giac, s);
  if (symbolic) return warning(symbolic);
  if (numericRoots(a, output, s)) return warning("moreSolutions");
  return undefined;
}

/**
 * expr|a=0 with the values put in, as the handheld works it: substituting a
 * value with | avoids the 1/a warning, so a
 * name given a value isn't free.
 */
function given(a: Ast): Ast {
  if (!(a.k === "bin" && a.op === "|")) return a;
  const values = new Map<string, Ast>();
  const walk = (c: Ast): void => {
    if (c.k === "bin" && c.op === "and") [c.a, c.b].forEach(walk);
    else if (c.k === "bin" && c.op === "=" && c.a.k === "sym") values.set(c.a.name, c.b);
  };
  walk(a.b);
  return values.size ? mapAst(a.a, (x) => (x.k === "sym" && values.has(x.name) ? values.get(x.name)! : x)) : a;
}

/**
 * Identity matrix: a scalar added to or taken from a square matrix, either way round,
 * goes on the diagonal: [[1,2][3,4]]+1 is [[2,2][3,5]].
 * A matrix that isn't square is a Dimension error instead (translate.ts).
 */
async function scalarOnMatrix(a: Ast, giac: Giac, s: Ctx): Promise<boolean> {
  const pairs: [Ast, Ast][] = [];
  mapAst(a, (x) => {
    if (x.k === "bin" && (x.op === "+" || x.op === "-")) pairs.push([x.a, x.b], [x.b, x.a]);
    return x;
  });
  const literal = (x: Ast) => x.k === "mat" || x.k === "list";
  // The matrix side has a matrix in it somewhere; the scalar side has no list or matrix written in it.
  const maybe = pairs.filter(([m, c]) => has(m, (x) => x.k === "mat" || x.k === "sym" || (x.k === "call" && x.f === "identity")) && !has(c, literal) && !stores(m) && !stores(c));
  if (!maybe.length) return false;
  // Which of the names hold a list or a matrix.
  const names = symbols(a).map(giacName);
  const flags = names.length
    ? (await giac(`[${names.map((n) => `ifte(type(${n})==DOM_LIST,1,0)`).join(",")}]`)).replace(/^(list)?\[|\]$/g, "").split(",").map((t) => t.trim())
    : [];
  const containers = new Set(names.filter((_, k) => flags[k] === "1"));
  const container = (x: Ast) => x.k === "sym" && containers.has(giacName(x.name));
  const ctx = { ...s, matrices: containers };
  for (const [m, c] of maybe) {
    if (has(c, container)) continue;
    if (!has(m, (x) => x.k === "mat" || container(x) || (x.k === "call" && x.f === "identity"))) continue;
    // A function on the other side can give a matrix: identity(3)−x·M is two matrices.
    if (has(c, (x) => x.k === "call") && (await giac(`ifte(type(${giacText(c, ctx)})==DOM_LIST,1,0)`)).trim() !== "0") continue;
    if (m.k === "mat") {
      if (m.rows.length === m.rows[0]?.length) return true;
      continue;
    }
    const dim = (await giac(`dim(${giacText(m, ctx)})`)).trim();
    const square = /^\[(\d+),(\d+)\]$/.exec(dim);
    if (square && square[1] === square[2]) return true;
  }
  return false;
}

/**
 * det or charPoly with a variable in play is worked by elimination with a
 * pivot that has the variable in it, cancelled afterwards, so the answer is
 * defined where a pivot was 0: the wider-domain warning (det(identity(3)−x·M) and
 * charPoly(M,x)). rref and ref of a matrix with an
 * undefined name in it divide by it (1/a fails at a=0; rref([[a,b][c,d]]) shows the ⚠ too).
 */
async function symbolicMatrix(a: Ast, giac: Giac, s: Ctx): Promise<WarningCode | null> {
  const calls: Extract<Ast, { k: "call" }>[] = [];
  mapAst(a, (x) => {
    if (x.k === "call" && ["det", "charPoly", "rref", "ref"].includes(x.f) && x.args[0] && !stores(x)) calls.push(x);
    return x;
  });
  for (const c of calls) {
    const m = giacText(c.args[0]!, s);
    const free = (x: Ast) => `size(lname(${giacText(x, s)}))`;
    if (c.f === "rref" || c.f === "ref") {
      if ((await giac(free(c.args[0]!))).trim() !== "0") return "freeParameter";
      continue;
    }
    const variable = c.f === "charPoly" ? c.args[1] : c.args[0];
    if (!variable) continue;
    const [rows, names] = (await giac(`[rowdim(${m}),${free(variable)}]`)).replace(/^(list)?\[|\]$/g, "").split(",").map((t) => Number(t.trim()));
    if (rows! >= 2 && names! > 0) return "widerDomain";
  }
  return null;
}

/**
 * More solutions: solve or zeros of an equation that isn't a polynomial in the
 * variable, whose roots had to be searched for numerically (decimals in an
 * exact entry): solve((x−a)·ℯ^x=−x·(x−a),x) is x=a or x=−0.56714329041
 * on the handheld. A polynomial has a known number of roots, so it doesn't warn.
 * Only an entry with no bound on the variable and no guess: the message asks
 * for those, and whether one with them still warns isn't known.
 */
function numericRoots(a: Ast, output: Ast, s: Ctx & { approx?: boolean }): boolean {
  const bounded = a.k === "bin" && a.op === "|";
  const call = bounded ? a.a : a;
  if (!(call.k === "call" && (call.f === "solve" || call.f === "zeros") && call.args.length === 2)) return false;
  const [eq, v] = call.args as [Ast, Ast];
  if (v.k !== "sym") return false;
  if (s.approx || s.mode === "approx") return false;
  if (has(call, (x) => x.k === "num" && /[.E]/.test(x.v))) return false;
  if (!has(output, (x) => x.k === "num" && /[.E]/.test(x.v))) return false;
  if (bounded && has(a.b, (x) => x.k === "bin" && ["<", ">", "≤", "≥"].includes(x.op) && has(x, (y) => y.k === "sym" && y.name === v.name))) return false;
  if (has(eq, (x) => x.k === "bin" && ["<", ">", "≤", "≥", "≠", "and", "or"].includes(x.op))) return false;
  return polynomial(eq, v.name) === false;
}

const ELEMENTARY = new Set(["sin", "cos", "tan", "sec", "csc", "cot", "sin⁻¹", "cos⁻¹", "tan⁻¹", "sinh", "cosh", "tanh", "ln", "log", "exp", "√", "root", "abs"]);

/**
 * Whether an equation is a polynomial in v (a ratio of them counts: its
 * numerator is one), read from the input alone. null when that can't be told
 * without working it out: a user's function or an integral of v. (Giac's own
 * test meant evaluating it, and normal() of an integral of a piecewise
 * crashed the session.)
 */
function polynomial(e: Ast, v: string): boolean | null {
  const free = (x: Ast) => !has(x, (y) => y.k === "sym" && y.name === v);
  if (free(e)) return true;
  const all = (parts: (boolean | null)[]) => (parts.includes(null) ? null : parts.every(Boolean));
  switch (e.k) {
    case "sym":
      return true;
    case "neg":
      return polynomial(e.a, v);
    case "bin": {
      if (["+", "-", "*", "/", "="].includes(e.op)) return all([polynomial(e.a, v), polynomial(e.b, v)]);
      if (e.op !== "^") return null;
      // x^3 and x^−1 are; x^(1/2), 2^x and ℯ^x aren't.
      const whole = (x: Ast): boolean => (x.k === "num" && /^\d+$/.test(x.v)) || (x.k === "neg" && whole(x.a));
      return whole(e.b) ? polynomial(e.a, v) : false;
    }
    case "call":
      return ELEMENTARY.has(e.f) ? false : null;
    default:
      return null;
  }
}
