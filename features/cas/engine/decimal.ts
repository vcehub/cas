// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 VCE Hub. Part of the /cas calculator: https://github.com/vcehub/cas
import { mapAst, parse, sym, type Ast } from "../math/ast";
import { isConstant } from "./format";
import { giacName, toGiac, type Ctx } from "./translate";

/**
 * The handheld's arithmetic is decimal: every number and every result is held
 * to 14 significant digits (the screen shows 12), so 1000.1−1000 is 0.1,
 * 3.0000000000001−3 is 1.E−13, and 10.^15+1 rounds back to 1.E15 before the
 * 10.^15 comes off it ((10.^15+1)−10.^15 is 0.). Giac's binary doubles carry
 * about 14½ digits and no decimal places exactly, so the same subtraction
 * there is 0.0999999999985, and its doubles stop at 1E308.
 *
 * A number worked out here is c×10^e, rounded to 14 digits after each step,
 * half away from zero. + − × ÷ are done exactly and then rounded, as the
 * handheld does; a power, a function (ln, √, ℯ^) or a distribution is asked
 * of Giac at 50 digits and rounded to 14, so it is right to the last place,
 * where the handheld's own are now and then a digit out. The exponent goes
 * to ±999, as the handheld's does: 10.^400 is 1.E400, ℯ^(−1000.) is
 * 5.07595889755E−435.
 */
type Dec = { c: bigint; e: number };

type Giac = (cmd: string) => Promise<string>;

const HELD = 14;
const WORKING = 50;
/** The handheld's range: 1E−999 to 9.99…E999. */
const RANGE = 999;

const pow10 = (n: number): bigint => 10n ** BigInt(n);
const digitCount = (c: bigint): number => (c < 0n ? -c : c).toString().length;

/** n significant digits, half away from zero, trailing zeros taken into e. */
function rounded(d: Dec, n = HELD): Dec {
  if (d.c === 0n) return { c: 0n, e: 0 };
  const negative = d.c < 0n;
  let c = negative ? -d.c : d.c;
  let e = d.e;
  const drop = c.toString().length - n;
  if (drop > 0) {
    const unit = pow10(drop);
    const rest = c % unit;
    c = c / unit + (rest * 2n >= unit ? 1n : 0n);
    e += drop;
  }
  while (c % 10n === 0n) {
    c /= 10n;
    e += 1;
  }
  return { c: negative ? -c : c, e };
}

/** The power of ten of the leading digit: 3 for 1234.5, −4 for 0.00012. */
const magnitude = (d: Dec): number => d.e + digitCount(d.c) - 1;

const inRange = (d: Dec): boolean => d.c === 0n || Math.abs(magnitude(d)) <= RANGE;

/** A decimal as Giac or the handheld writes one: 12, -2.5, 1.E-400, 0.62209605742717841235e-15. */
export function parseDecimal(text: string): Dec | null {
  const m = /^(-?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text.trim());
  if (!m || !(m[2] || m[3])) return null;
  const fraction = m[3] ?? "";
  const c = BigInt((m[2] || "0") + fraction);
  return rounded({ c: m[1] ? -c : c, e: Number(m[4] ?? 0) - fraction.length }, WORKING);
}

function add(a: Dec, b: Dec): Dec {
  const e = Math.min(a.e, b.e);
  return rounded({ c: a.c * pow10(a.e - e) + b.c * pow10(b.e - e), e });
}

const times = (a: Dec, b: Dec): Dec => rounded({ c: a.c * b.c, e: a.e + b.e });

function divide(a: Dec, b: Dec): Dec | null {
  if (b.c === 0n) return null;
  // Enough digits for 14 and a rounding digit; a remainder is kept as a last 1 so a tie isn't made up.
  const k = Math.max(0, HELD + 2 + digitCount(b.c) - digitCount(a.c));
  const [n, m] = [(a.c < 0n ? -a.c : a.c) * pow10(k), b.c < 0n ? -b.c : b.c];
  const q = (n / m) * 10n + (n % m === 0n ? 0n : 1n);
  return rounded({ c: a.c < 0n !== b.c < 0n ? -q : q, e: a.e - b.e - k - 1 });
}

/**
 * Float n: n significant digits, trailing zeros dropped, a whole number keeps
 * its point (5.), and scientific form past n digits or below 0.001, as
 * formatFloat writes a double.
 */
export function decimalText(d: Dec, digits: number): string {
  const r = rounded(d, digits);
  if (r.c === 0n) return "0.";
  const sign = r.c < 0n ? "-" : "";
  const s = (r.c < 0n ? -r.c : r.c).toString();
  const p = magnitude(r);
  if (p >= digits || p < -3) return `${sign}${s[0]}.${s.slice(1)}E${p}`;
  if (r.e >= 0) return `${sign}${s}${"0".repeat(r.e)}.`;
  const point = s.length + r.e;
  return point > 0 ? `${sign}${s.slice(0, point)}.${s.slice(point)}` : `${sign}0.${"0".repeat(-point)}${s}`;
}

/** As Giac reads it at 50 digits: 10000000001e-10. */
const giacText = (d: Dec): string => (d.c < 0n ? `(${d.c}e${d.e})` : `${d.c}e${d.e}`);

/** One-argument functions worked here: the argument to 14 digits, the value from Giac at 50. */
const FUNCTIONS = new Set(["ln", "log", "√", "exp"]);
/**
 * The distributions, decimal whatever their arguments: binomCdf(100,0.5,0,10)
 * is 1.53164508772E−17, which Giac's doubles have, but normCdf(8,∞,0,1) comes
 * from 1+erf(−4√2), which needs more than 16 digits to leave 6.22096057427E−16.
 */
const DISTRIBUTIONS = new Set(["normPdf", "normCdf", "binomPdf", "binomCdf", "poissPdf", "poissCdf", "geomPdf", "geomCdf"]);

const isInfinity = (a: Ast): boolean => (a.k === "sym" && a.name === "∞") || (a.k === "neg" && isInfinity(a.a));

/**
 * Only numbers, + − × ÷ ^ !, and the functions above, with a decimal, a
 * distribution or approx( ) in it, or the whole entry approximate
 * (Approximate mode, ctrl+enter): those make every number a decimal as it
 * is met, so approx(10^20+1−10^20) is 0. like 1E20+1−1E20.
 */
function decimalExpression(a: Ast, whole: boolean): "no" | "yes" | "variables" {
  let approximate = whole;
  let variables = false;
  const ok = (x: Ast): boolean => {
    switch (x.k) {
      case "sym":
        // A stored value (1000.1→a, then a−1000): decimal or not is known once it's looked up.
        variables = true;
        return !CONSTANT.has(x.name) && /^[A-Za-zα-ωΑ-Ω]\w*$/.test(x.name);
      case "num":
        if (x.full || /[.E]/.test(x.v)) approximate = true;
        return true;
      case "neg":
        return ok(x.a);
      case "post":
        return x.op === "!" && ok(x.a);
      case "bin":
        if (x.op === "^" && x.a.k === "sym" && x.a.name === "ℯ") return ok(x.b);
        return ["+", "-", "*", "/", "^"].includes(x.op) && ok(x.a) && ok(x.b);
      case "call":
        if (x.f === "approx" && x.args.length === 1) {
          approximate = true;
          return ok(x.args[0]!);
        }
        if (DISTRIBUTIONS.has(x.f)) {
          approximate = true;
          return x.args.length > 0 && x.args.every((y) => isInfinity(y) || ok(y));
        }
        return FUNCTIONS.has(x.f) && (x.args.length === 1 || (x.f === "log" && x.args.length === 2)) && x.args.every(ok);
      default:
        return false;
    }
  };
  return !ok(a) ? "no" : approximate ? "yes" : variables ? "variables" : "no";
}

/** Left to the usual route: π and ℯ as numbers, i, and ∞ outside a distribution. */
const CONSTANT = new Set(["π", "ℯ", "i", "∞"]);

/**
 * A user's names as Giac holds them, as translate sends them: a variable e
 * is e_, not Giac's ℯ, and restart is restart_, not the command that clears
 * every variable.
 */
const giacNames = (a: Ast): Ast => mapAst(a, (x) => (x.k === "sym" && giacName(x.name) !== x.name ? sym(giacName(x.name)) : x));

/**
 * The decimal Giac writes after an exact constant (1/3=0.333…,
 * sqrt(2)=1.41…). A stored equation (x=3) looks the same but is no number.
 */
function constantDecimal(held: string): string | null {
  const m = /^([^=]+)=([^=]+)$/.exec(held);
  if (!m) return null;
  try {
    return isConstant(parse(m[1]!, { giac: true })) ? m[2]! : null;
  } catch {
    return null;
  }
}

/**
 * A number typed with a decimal point, worked out as the handheld does
 * (see Dec), and written to Display Digits. null when the input is anything
 * else, or when a step has no real value (√(−2.), ln(0.), 1/0.), which the
 * usual route answers.
 */
export async function decimalArithmetic(a: Ast, giac: Giac, s: Ctx & { digits: number }, approximate: boolean): Promise<Ast | null> {
  const kind = decimalExpression(a, approximate);
  if (kind === "no") return null;
  let decimal = kind === "yes";
  const ctx: Ctx = { angle: s.angle, mode: s.mode };
  const fromGiac = async (cmd: string): Promise<Dec | null> => {
    const d = parseDecimal(await giac(`evalf(${cmd})`));
    return d && inRange(d) ? rounded(d) : null;
  };
  /**
   * Giac checks a distribution's parameters only in doubles: binomPdf(10,1.5,3)
   * is undef there and −3.1640625 at 50 digits, binomPdf(10,0.5,3.5) an
   * argument error and 0.162811849876. So the doubles say whether there is an
   * answer, as on the usual route; a list (binomPdf(10,0.5)) is none here
   * either. Giac's long-float binomial also works each term afresh, at a cost
   * that grows with n (binomCdf(20000,0.5,0,10000) takes 16 s): past about a
   * million, n times the terms, the usual route's doubles answer it.
   */
  const distribution = async (x: Ast & { k: "call" }): Promise<Dec | null> => {
    const cmd = toGiac(giacNames(x), ctx);
    await giac("Digits:=12");
    const checked = parseDecimal(await giac(`evalf(${cmd})`));
    await giac(`Digits:=${WORKING}`);
    if (!checked) return null;
    if (x.f === "binomPdf" || x.f === "binomCdf") {
      const arg = async (i: number, otherwise: number): Promise<number> => {
        const y = x.args[i];
        if (!y || isInfinity(y)) return otherwise;
        const d = await value(y);
        return d ? Number(`${d.c}e${d.e}`) : NaN;
      };
      const n = await arg(0, NaN);
      const [lo, hi] = x.f === "binomPdf" ? [0, 0] : x.args.length === 3 ? [0, await arg(2, n)] : [await arg(2, 0), await arg(3, n)];
      if (!(n * Math.max(1, Math.min(hi, n) - Math.max(lo, 0) + 1) <= 1e6)) return null;
    }
    return fromGiac(cmd);
  };
  const value = async (x: Ast): Promise<Dec | null> => {
    switch (x.k) {
      case "sym": {
        // At 50 digits Giac writes a stored decimal to 14 (1000.1) and an exact constant as 1/3=0.33…
        const held = (await giac(toGiac(giacNames(x), ctx))).trim();
        const exact = constantDecimal(held);
        const d = parseDecimal(exact ?? held);
        if (exact === null && /[.e]/i.test(held)) decimal = true;
        return d && inRange(d) ? rounded(d) : null;
      }
      case "num": {
        const d = parseDecimal((x.full ?? x.v).replace(/\.$/, ""));
        return d && inRange(d) ? rounded(d) : null;
      }
      case "neg": {
        const d = await value(x.a);
        return d && { c: -d.c, e: d.e };
      }
      case "post": {
        const d = await value(x.a);
        return d && fromGiac(`(${giacText(d)})!`);
      }
      case "bin": {
        if (x.op === "^" && x.a.k === "sym" && x.a.name === "ℯ") {
          const d = await value(x.b);
          return d && fromGiac(`exp(${giacText(d)})`);
        }
        const [p, q] = [await value(x.a), await value(x.b)];
        // 0^0 is undef and 0^−1 a division by zero: the usual route says so.
        if (!p || !q || (x.op === "^" && p.c === 0n && q.c <= 0n)) return null;
        const r = x.op === "+" ? add(p, q) : x.op === "-" ? add(p, { c: -q.c, e: q.e }) : x.op === "*" ? times(p, q) : x.op === "/" ? divide(p, q) : await fromGiac(`(${giacText(p)})^(${giacText(q)})`);
        return r && inRange(r) ? r : null;
      }
      case "call": {
        if (x.f === "approx") return value(x.args[0]!);
        if (DISTRIBUTIONS.has(x.f)) return distribution(x);
        const args: Ast[] = [];
        for (const y of x.args) {
          const d = await value(y);
          if (!d) return null;
          args.push({ k: "num", v: giacText(d) });
        }
        return fromGiac(toGiac({ ...x, args }, ctx));
      }
      default:
        return null;
    }
  };
  await giac(`Digits:=${WORKING}`);
  let d: Dec | null;
  try {
    d = await value(a);
  } finally {
    await giac("Digits:=12");
  }
  if (!d || !decimal) return null;
  const shown = decimalText(d, s.digits);
  const held = decimalText(d, HELD);
  const n: Ast = { k: "num", v: shown.replace(/^-/, ""), ...(held !== shown ? { full: held.replace(/^-/, "") } : {}) };
  return shown.startsWith("-") ? { k: "neg", a: n } : n;
}
