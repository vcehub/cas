// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 VCE Hub. Part of the /cas calculator: https://github.com/vcehub/cas
import { mapAst, num, type Ast } from "../math/ast";
import { numericValue } from "./format";
import { print } from "../math/print";

/**
 * Rewrites an answer into the handheld's normal form, where Giac's differs:
 * terms in order of the main variables' degree (x before y before z, then
 * a, b, c …, highest power first, constants last), "a−b" rather than
 * "a+−b", "x/2" rather than "1/2·x", and no "·1". A series (taylor) is
 * listed lowest power first.
 */
export function canonical(input: Ast, opts: { ascending?: boolean } = {}): Ast {
  const out = mapAst(input, (a) => minusOut(fractionSigns(orderSum(orderProduct(reorderMade(tidy(a))), false))));
  // Only the series itself runs lowest power first; its brackets stay as they are: (x−1)².
  return opts.ascending ? orderSum(out, true) : out;
}

/**
 * Factor order in a product: numbers and numeric roots, then variables and
 * their powers (in variable order), then bracketed sums, then functions,
 * with i last: 2·x·sin(x), a·(a²+1)·(x−i), (c1·x+c2)·ℯ^(−x), x−y·i.
 */
function factorClass(a: Ast): number {
  if (a.k === "sym" && a.name === "i") return 9;
  // π and ℯ follow the variables (n1·π); arbitrary constants lead (c1·x).
  if (a.k === "sym" && (a.name === "π" || a.name === "ℯ")) return 1.5;
  if (a.k === "sym" && /^[cn]\d+$/.test(a.name)) return 0.5;
  if (!hasVars(a)) return 0;
  if (a.k === "sym" || (a.k === "bin" && a.op === "^" && a.a.k === "sym" && a.a.name !== "ℯ")) return 1;
  if (a.k === "bin" && (a.op === "+" || a.op === "-")) return 2;
  return 3;
}

const leadName = (a: Ast): string => (a.k === "sym" ? a.name : a.k === "bin" && a.a.k === "sym" ? a.a.name : "");

function orderProduct(a: Ast): Ast {
  if (!(a.k === "bin" && a.op === "*")) return a;
  const factors: Ast[] = [];
  const walk = (x: Ast) => {
    if (x.k === "bin" && x.op === "*") {
      walk(x.a);
      walk(x.b);
    } else factors.push(x);
  };
  walk(a);
  if (factors.length < 2) return a;
  const sorted = factors
    .map((f, i) => ({ f, i, c: factorClass(f) }))
    .sort(
      (p, q) =>
        p.c - q.c ||
        (p.c === 1 ? byVar(leadName(p.f), leadName(q.f)) : 0) ||
        (p.c === 2 ? conjugateOrder(p.f, q.f) : 0) ||
        (p.c === 3 ? trigOrder(p.f, q.f) : 0) ||
        p.i - q.i,
    )
    .map((x) => x.f);
  // 10·2·2^(1/3) → 20·2^(1/3) and 8·3·ln(2) → 24·ln(2): the whole numbers a
  // root's whole part or a log's power (8·ln(8)) leaves in a product join the
  // coefficient (Giac's own products carry one at most). A
  // product of numbers alone is a factorisation and stays: factor(1001) is
  // 7·11·13, factor(420) is 2^2·3·5·7.
  const whole = (x: Ast | undefined): string | null => (x && x.k === "num" && /^\d+$/.test(x.v) ? x.v : null);
  const numeric = (x: Ast) => x.k === "num" || (x.k === "bin" && x.op === "^" && x.a.k === "num" && x.b.k === "num");
  let out = sorted;
  if (!sorted.every(numeric)) {
    // ln(2)·3·ln(2): the numbers lead, and a constant that comes twice is squared, 3·(ln(2))^2.
    const wholes = sorted.filter((x) => whole(x));
    const rest: { f: Ast; n: number }[] = [];
    for (const f of sorted.filter((x) => !whole(x))) {
      const same = factorClass(f) === 0 ? rest.find((r) => print(r.f) === print(f)) : undefined;
      if (same) same.n++;
      else rest.push({ f, n: 1 });
    }
    if (wholes.length > 1 || rest.some((r) => r.n > 1)) {
      const c = wholes.reduce((m, x) => m * BigInt(whole(x)!), 1n);
      out = [...(wholes.length ? [num(c.toString())] : []), ...rest.map((r): Ast => (r.n === 1 ? r.f : tidy({ k: "bin", op: "^", a: r.f, b: num(String(r.n)) })))];
    }
  }
  return out.slice(1).reduce<Ast>((acc, f) => ({ k: "bin", op: "*", a: acc, b: f }), out[0]!);
}

/**
 * x+√3 before x−√3, and x+√a before x−√a: of two factors that differ only
 * in the sign of a radical or symbolic term, the handheld puts + first.
 * Integer constants keep Giac's order: (x−2)·(x+2).
 */
function conjugateOrder(p: Ast, q: Ast): number {
  const tp = flatten(p);
  const tq = flatten(q);
  if (tp.length < 2 || tp.length !== tq.length) return 0;
  if (print(tp[0]!.t) !== print(tq[0]!.t) || tp[0]!.neg !== tq[0]!.neg) return 0;
  // Pairs by the size of their radical: (x+√2)·(x−√2)·(x+√3)·(x−√3).
  if (tp.length === 2 && print(tp[1]!.t) !== print(tq[1]!.t)) {
    const [m, n] = [numericValue(tp[1]!.t), numericValue(tq[1]!.t)];
    const radical = (t: Ast) => t.k !== "num" && !hasI(t) && !hasVars(t);
    return radical(tp[1]!.t) && radical(tq[1]!.t) && Number.isFinite(m) && Number.isFinite(n) ? m - n : 0;
  }
  // Conjugates differ only in the sign of one term.
  const differ = tp.map((t, k) => print(t.t) === print(tq[k]!.t) && t.neg !== tq[k]!.neg);
  const same = tp.map((t, k) => print(t.t) === print(tq[k]!.t) && t.neg === tq[k]!.neg);
  const d = differ.indexOf(true);
  if (d < 1 || differ.filter(Boolean).length !== 1 || same.filter(Boolean).length !== tp.length - 1) return 0;
  const t = tp[d]!.t;
  // x−1 before x+1 and x−i before x+i; but x+√3 before x−√3.
  const minusFirst = t.k === "num" || (t.k === "sym" && t.name === "i");
  return (tp[d]!.neg ? 1 : -1) * (minusFirst ? -1 : 1);
}

const PRIORITY = "xyztuvw";
function varRank(name: string): number {
  const i = PRIORITY.indexOf(name[0] ?? "");
  if (i >= 0) return i;
  if (/^[a-s]/.test(name)) return 10 + name.charCodeAt(0) - 97;
  return 40;
}
/** Variable order: x, y, z, t, u, v, w, then a … s, ties by full name. */
const byVar = (m: string, n: string) => varRank(m) - varRank(n) || (m < n ? -1 : m > n ? 1 : 0);

const isNum = (a: Ast, v?: string): a is { k: "num"; v: string } => a.k === "num" && (v === undefined || a.v === v);

/**
 * A leading minus is taken out of a real constant sum, −(√2−1) rather than
 * −√2+1, and out of a fraction's numerator, −(√5−1)/2.
 */
function minusOut(a: Ast): Ast {
  const flip = (sum: Ast): Ast | null => {
    if (!(sum.k === "bin" && (sum.op === "+" || sum.op === "-"))) return null;
    const terms = flatten(sum);
    if (!terms[0]!.neg || terms.every((t) => t.neg) || terms.some((t) => hasI(t.t))) return null;
    const flipped = terms.map((t) => ({ neg: !t.neg, t: t.t }));
    return flipped.slice(1).reduce<Ast>((acc, t) => ({ k: "bin", op: t.neg ? "-" : "+", a: acc, b: t.t }), flipped[0]!.t);
  };
  if (a.k === "bin" && (a.op === "+" || a.op === "-") && !hasVars(a) && !flatten(a).some((t) => t.t.k === "bin" && t.t.op === "/")) {
    const f = flip(a);
    if (f) return { k: "neg", a: f };
  }
  if (a.k === "bin" && a.op === "/") {
    const f = flip(a.a);
    if (f) return { k: "neg", a: { ...a, a: f } };
  }
  return a;
}

/**
 * A sum in a fraction, above or below the bar or a factor of either, keeps
 * the standard order (no positive term swapped to the front, as at the top
 * of an answer: 3/2−x/2), and a negative lead comes out as the fraction's
 * sign: x=−(b−d)/(a−c), y=x·z/(x−z), 1/(2·(x−1)), −(ℯ^(x·y)·y−1)/(x·ℯ^(x·y)−1).
 * Sums with i are the complex forms' business and stay as they are.
 */
function fractionSigns(a: Ast): Ast {
  // A fraction that tidy() made under a minus, −((−√D−b)/5), cancels the two signs.
  if (a.k === "neg" && a.a.k === "bin" && a.a.op === "/") {
    const f = fractionSigns(a.a);
    return f === a.a ? a : f.k === "neg" ? f.a : { k: "neg", a: f };
  }
  if (!(a.k === "bin" && a.op === "/")) return a;
  let neg = false;
  const fix = (x: Ast): Ast => {
    if (x.k === "bin" && x.op === "*") return { ...x, a: fix(x.a), b: fix(x.b) };
    if (!(x.k === "bin" && (x.op === "+" || x.op === "-")) || hasI(x)) return x;
    // A constant keeps its order unless every term is negative: −1/(π+2).
    if (!hasVars(x) && !flatten(x).every((u) => u.neg)) return x;
    const terms = hasVars(x) ? flatten(orderSum(x, false, false)) : flatten(x);
    const lead = terms[0]!.neg;
    if (lead) neg = !neg;
    const t = lead ? terms.map((u) => ({ neg: !u.neg, t: u.t })) : terms;
    return t.slice(1).reduce<Ast>((acc, u) => ({ k: "bin", op: u.neg ? "-" : "+", a: acc, b: u.t }), t[0]!.neg ? { k: "neg", a: t[0]!.t } : t[0]!.t);
  };
  // A sign already on the numerator joins the one taken out: −x·z/(z−x) is x·z/(x−z).
  let top = a.a;
  if (top.k === "neg") [neg, top] = [true, top.a];
  else if (top.k === "num" && top.v.startsWith("-")) [neg, top] = [true, num(top.v.slice(1))];
  const made: Ast = { ...a, a: fix(top), b: fix(a.b) };
  // (A/2)/a, left when the sign came off the inner fraction, is A/(2·a).
  const out = top.k === "bin" && top.op === "/" ? tidy(made) : made;
  if (print(out) === print(top === a.a ? a : { ...a, a: top }) && top === a.a) return a;
  return neg ? { k: "neg", a: out } : out;
}

/** A product tidy() just made, under a sign or a minus, is put in order too: x−y·i, not x−i·y. */
function reorderMade(a: Ast): Ast {
  if (a.k === "neg" && a.a.k === "bin" && a.a.op === "*") return { ...a, a: orderProduct(a.a) };
  if (a.k === "bin" && (a.op === "+" || a.op === "-") && a.b.k === "bin" && a.b.op === "*") return { ...a, b: orderProduct(a.b) };
  return a;
}

/** The whole k-th root of n for the largest k ≥ 2, or null when n is no perfect power. */
function perfectPower(n: bigint): { m: bigint; k: number } | null {
  if (n < 4n) return null;
  // Past a double's range (ln(2^1100)) the estimate below is Infinity: use the primes' exponents.
  if (!Number.isFinite(Number(n))) {
    const f = primeFactors(n);
    if (!f) return null;
    const k = [...f.values()].reduce((g, e) => Number(gcdBig(BigInt(g), BigInt(e))), 0);
    if (k < 2) return null;
    return { m: [...f].reduce((m, [p, e]) => m * p ** BigInt(e / k), 1n), k };
  }
  for (let k = Math.floor(Math.log2(Number(n))); k >= 2; k--) {
    const m = BigInt(Math.round(Number(n) ** (1 / k)));
    for (const c of [m - 1n, m, m + 1n]) if (c > 1n && c ** BigInt(k) === n) return { m: c, k };
  }
  return null;
}

/**
 * ln(16) → 4·ln(2), ln(9/4) → 2·ln(3/2): the log of an exact power is written
 * as a multiple, as the handheld always does (no example has the log of a
 * perfect power). A coefficient left over a number then reduces: ln(4)/10 → ln(2)/5.
 */
function logOfPower(a: Ast): Ast {
  if (!(a.k === "call" && a.f === "ln" && a.args.length === 1)) return a;
  const r = ratOf(a.args[0]!);
  if (!r || r[0] < 2n) return a;
  const top = r[1] === 1n ? perfectPower(r[0]) : null;
  if (top) return { k: "bin", op: "*", a: num(String(top.k)), b: { ...a, args: [num(top.m.toString())] } };
  if (r[1] === 1n) return a;
  // A fraction: both parts the same power.
  const [pt, pb] = [perfectPower(r[0]), perfectPower(r[1])];
  if (!pt || !pb) return a;
  for (let k = Math.min(pt.k, pb.k); k >= 2; k--) {
    if (pt.k % k || pb.k % k) continue;
    const [m, n] = [pt.m ** BigInt(pt.k / k), pb.m ** BigInt(pb.k / k)];
    return { k: "bin", op: "*", a: num(String(k)), b: { ...a, args: [{ k: "bin", op: "/", a: num(m.toString()), b: num(n.toString()) }] } };
  }
  return a;
}

/** c·X/d with whole c and d: the common factor cancels, 2·ln(2)/10 → ln(2)/5. */
function reduceRatio(a: Ast): Ast {
  if (!(a.k === "bin" && a.op === "/" && a.b.k === "num" && /^\d+$/.test(a.b.v) && a.b.v !== "0")) return a;
  // −16^(1/4)/2 is −2/2 once the root is whole: the sign waits outside, −1.
  if (a.a.k === "neg") {
    const inner: Ast = { ...a, a: a.a.a };
    const pos = reduceRatio(inner);
    return pos === inner ? a : { k: "neg", a: pos };
  }
  const n = ratOf(a);
  if (n) {
    const g = gcdBig(n[0], n[1]);
    if (g === 1n) return a;
    return n[1] === g ? num((n[0] / g).toString()) : { ...a, a: num((n[0] / g).toString()), b: num((n[1] / g).toString()) };
  }
  const factors: Ast[] = [];
  const walk = (x: Ast) => {
    if (x.k === "bin" && x.op === "*") {
      walk(x.a);
      walk(x.b);
    } else factors.push(x);
  };
  walk(a.a);
  const whole = factors.filter((f) => f.k === "num" && /^\d+$/.test(f.v)) as { k: "num"; v: string }[];
  if (whole.length === 0 || factors.length === whole.length) return a;
  const c = whole.reduce((acc, f) => acc * BigInt(f.v), 1n);
  const d = BigInt(a.b.v);
  const g = gcdBig(c, d);
  if (g === 1n && whole.length === 1) return a;
  const rest = factors.filter((f) => !whole.includes(f as { k: "num"; v: string }));
  const parts = c / g === 1n ? rest : [num((c / g).toString()), ...rest];
  const numer = orderProduct(parts.slice(1).reduce<Ast>((acc, f) => ({ k: "bin", op: "*", a: acc, b: f }), parts[0]!));
  return d / g === 1n ? numer : { ...a, a: numer, b: num((d / g).toString()) };
}

/** A positive integer or fraction of integers, as [numerator, denominator]. */
function ratOf(a: Ast): [bigint, bigint] | null {
  if (a.k === "num" && /^\d+$/.test(a.v)) return [BigInt(a.v), 1n];
  if (a.k === "bin" && a.op === "/" && a.a.k === "num" && a.b.k === "num" && /^\d+$/.test(a.a.v) && /^\d+$/.test(a.b.v)) {
    return BigInt(a.b.v) === 0n ? null : [BigInt(a.a.v), BigInt(a.b.v)];
  }
  return null;
}

const gcdBig = (m: bigint, n: bigint): bigint => (n === 0n ? (m < 0n ? -m : m) : gcdBig(n, m % n));

/** Prime factors by trial division, or null when a large cofactor is left unsplit. */
function primeFactors(n: bigint): Map<bigint, number> | null {
  const out = new Map<bigint, number>();
  let rest = n;
  for (let d = 2n; d <= 100000n && d * d <= rest; d += d === 2n ? 1n : 2n) {
    while (rest % d === 0n) {
      out.set(d, (out.get(d) ?? 0) + 1);
      rest /= d;
    }
  }
  if (rest > 1n) {
    if (rest > 100000n * 100000n) return null;
    out.set(rest, (out.get(rest) ?? 0) + 1);
  }
  return out;
}

/**
 * The handheld's form for a root of a number, N^(p/q) with q ≥ 3: whole
 * powers come out as a coefficient, the primes left over are grouped by
 * their exponent, and the groups go smallest exponent first, so every base
 * is squarefree and every exponent below 1: 130000^(1/5) → 13^(1/5)·10^(4/5),
 * 20^(1/3) → 5^(1/3)·2^(2/3), 9^(1/3) → 3^(2/3), 16^(1/4) → 2. A fraction is
 * rationalised, (27/4)^(1/3) → 3·2^(1/3)/2, and a power of a root merges,
 * (2^(1/7))^4 → 2^(4/7). Square roots print as √ and are left alone.
 */
function radicalForm(a: Ast): Ast | null {
  if (!(a.k === "bin" && a.op === "^")) return null;
  let base = ratOf(a.a);
  let exp = ratOf(a.b);
  // (b^(m/n))^k with a whole k: one power, b^(m·k/n).
  if (!base && exp && exp[1] === 1n && a.a.k === "bin" && a.a.op === "^") {
    const inner = ratOf(a.a.b);
    base = ratOf(a.a.a);
    if (!inner || !base) return null;
    exp = [inner[0] * exp[0], inner[1]];
  }
  if (!base || !exp || base[0] === 0n) return null;
  const g = gcdBig(exp[0], exp[1]);
  const [p, q] = [exp[0] / g, exp[1] / g];
  if (q < 3n || p === 0n) return null;
  const top = primeFactors(base[0]);
  const bottom = primeFactors(base[1]);
  if (!top || !bottom) return null;
  const powers = new Map<bigint, bigint>();
  for (const [f, e] of top) powers.set(f, BigInt(e));
  for (const [f, e] of bottom) powers.set(f, (powers.get(f) ?? 0n) - BigInt(e));
  let [cn, cd] = [1n, 1n];
  // Groups of primes by their leftover exponent r/q, in lowest terms.
  const groups = new Map<string, { r: bigint; s: bigint; base: bigint }>();
  for (const [f, e] of powers) {
    const total = e * p;
    // Floor division, so a prime in the denominator leaves a positive remainder: 2^(−2/3) = 2^(1/3)/2.
    let whole = total / q;
    if (total % q !== 0n && total < 0n) whole -= 1n;
    const rem = total - whole * q;
    if (whole > 0n) cn *= f ** whole;
    if (whole < 0n) cd *= f ** -whole;
    if (rem === 0n) continue;
    const h = gcdBig(rem, q);
    const key = `${rem / h}/${q / h}`;
    const grp = groups.get(key) ?? { r: rem / h, s: q / h, base: 1n };
    grp.base *= f;
    groups.set(key, grp);
  }
  const roots = [...groups.values()].sort((m, n) => Number(m.r * n.s - n.r * m.s));
  const factors: Ast[] = [
    ...(cn !== 1n || roots.length === 0 ? [num(cn.toString())] : []),
    ...roots.map((r): Ast => ({ k: "bin", op: "^", a: num(r.base.toString()), b: { k: "bin", op: "/", a: num(r.r.toString()), b: num(r.s.toString()) } })),
  ];
  const product = factors.slice(1).reduce<Ast>((acc, f) => ({ k: "bin", op: "*", a: acc, b: f }), factors[0]!);
  const out: Ast = cd === 1n ? product : { k: "bin", op: "/", a: product, b: num(cd.toString()) };
  return print(out) === print(a) ? null : out;
}

/** Local clean-ups, applied bottom-up. */
function tidy(a: Ast): Ast {
  if (a.k === "call") return logOfPower(a);
  if (a.k === "neg" && a.a.k === "neg") return a.a.a;
  // −(b−c) → c−b
  if (a.k === "neg" && a.a.k === "bin" && a.a.op === "-") return { k: "bin", op: "-", a: a.a.b, b: a.a.a };
  // −(b−c)/a → (c−b)/a
  if (a.k === "neg" && a.a.k === "bin" && a.a.op === "/" && a.a.a.k === "bin" && a.a.a.op === "-") {
    return { ...a.a, a: { k: "bin", op: "-", a: a.a.a.b, b: a.a.a.a } };
  }
  if (a.k !== "bin") return a;
  const { op, a: l, b: r } = a;
  if (op === "*") {
    if (isNum(r, "1")) return l;
    if (isNum(l, "1")) return r;
    // 1/2·x → x/2, (3/4)·x → 3·x/4, 1/2·(a+b) → (a+b)/2: the handheld
    // writes the denominator last.
    if (l.k === "bin" && l.op === "/" && isNum(l.a) && isNum(l.b) && (r.k !== "bin" || r.op === "+" || r.op === "-" || r.op === "^" || (r.op === "*" && isNum(r.a)))) {
      const numer = l.a.v === "1" ? r : { k: "bin" as const, op: "*" as const, a: l.a, b: r };
      return reduceRatio({ k: "bin", op: "/", a: numer, b: l.b });
    }
    // 1/ln(2)·ln(x) → ln(x)/ln(2)
    if (l.k === "bin" && l.op === "/" && isNum(l.a, "1") && !isNum(l.b)) return { k: "bin", op: "/", a: r, b: l.b };
    // (−a)·b → −(a·b), so the sign leads the term; also (−2)·π² and a·(−b).
    if (l.k === "neg") return { k: "neg", a: tidy({ k: "bin", op: "*", a: l.a, b: r }) };
    // (isNum(l,"1") above narrows l's type; the literal is read back plainly.)
    const lit = l as Ast;
    if (lit.k === "num" && lit.v.startsWith("-")) return { k: "neg", a: tidy({ k: "bin", op: "*", a: num(lit.v.slice(1)), b: r }) };
    if (r.k === "neg") return { k: "neg", a: tidy({ k: "bin", op: "*", a: l, b: r.a }) };
    // (−1/2)·x → −(x/2)
    if (l.k === "bin" && l.op === "/" && (l.a.k === "neg" || (isNum(l.a) && l.a.v.startsWith("-")))) {
      const top = l.a.k === "neg" ? l.a.a : num((l.a as { v: string }).v.slice(1));
      return { k: "neg", a: tidy({ k: "bin", op: "*", a: { ...l, a: top }, b: r }) };
    }
  }
  if (op === "/" && l.k === "bin" && l.op === "*" && isNum(l.b, "1")) return { ...a, a: l.a };
  // a/(−b) → −(a/b): no 2/-(…) on screen.
  if (op === "/" && r.k === "neg") return { k: "neg", a: { ...a, b: r.a } };
  // (A/2)/a → A/(2·a)
  if (op === "/" && l.k === "bin" && l.op === "/") return tidy({ k: "bin", op: "/", a: l.a, b: { k: "bin", op: "*", a: l.b, b: r } });
  // (−√D−b)/(2·a) → −(√D+b)/(2·a): a numerator whose terms are all negative.
  if (op === "/" && l.k === "bin" && (l.op === "+" || l.op === "-")) {
    const terms = flatten(l);
    if (terms.every((t) => t.neg)) {
      const sum = terms.slice(1).reduce<Ast>((acc, t) => ({ k: "bin", op: "+", a: acc, b: t.t }), terms[0]!.t);
      return { ...a, a: { k: "neg", a: orderSum(sum, false) } };
    }
  }
  // −3/2 is drawn with the minus before the bar, not in the numerator.
  if (op === "/" && isNum(l) && l.v.startsWith("-")) return { k: "neg", a: { ...a, a: num(l.v.slice(1)) } };
  if (op === "^" && isNum(r, "1")) return l;
  if (op === "^") {
    const rf = radicalForm(a);
    if (rf) return rf;
  }
  if (op === "/") {
    const lp = reduceRatio(a);
    if (lp !== a) return lp;
  }
  if (op === "+" && r.k === "neg") return { k: "bin", op: "-", a: l, b: r.a };
  // a + (−b)/c → a − b/c
  if (op === "+" && r.k === "bin" && r.op === "/" && r.a.k === "neg") {
    return { k: "bin", op: "-", a: l, b: { ...r, a: r.a.a } };
  }
  if (op === "+" && r.k === "bin" && r.op === "/" && isNum(r.a) && r.a.v.startsWith("-")) {
    return { k: "bin", op: "-", a: l, b: { ...r, a: num(r.a.v.slice(1)) } };
  }
  if (op === "+" && isNum(r) && r.v.startsWith("-")) return { k: "bin", op: "-", a: l, b: num(r.v.slice(1)) };
  if (op === "-" && r.k === "neg") return { k: "bin", op: "+", a: l, b: r.a };
  return a;
}

type Term = { neg: boolean; t: Ast };

function flatten(a: Ast, neg = false, out: Term[] = []): Term[] {
  if (a.k === "bin" && a.op === "+") {
    flatten(a.a, neg, out);
    flatten(a.b, neg, out);
  } else if (a.k === "bin" && a.op === "-") {
    flatten(a.a, neg, out);
    flatten(a.b, !neg, out);
  } else if (a.k === "neg") {
    flatten(a.a, !neg, out);
  } else out.push({ neg, t: a });
  return out;
}

/** Exponents of each variable in a term's polynomial part. */
function degrees(a: Ast, into: Map<string, number> = new Map()): Map<string, number> {
  if (a.k === "sym" && a.name !== "i") into.set(a.name, (into.get(a.name) ?? 0) + 1);
  else if (a.k === "bin" && a.op === "*") {
    degrees(a.a, into);
    degrees(a.b, into);
  } else if (a.k === "bin" && a.op === "/") degrees(a.a, into);
  else if (a.k === "bin" && a.op === "^" && a.a.k === "sym" && a.b.k === "num") {
    into.set(a.a.name, (into.get(a.a.name) ?? 0) + Number(a.b.v));
  } else if (a.k === "bin" && a.op === "^" && (a.a.k === "bin" && (a.a.op === "+" || a.a.op === "-")) && a.b.k === "num") {
    // (x+y)² counts as its leading term squared, so it sorts ahead of −y².
    const total = (m: Map<string, number>) => [...m.values()].reduce((s, v) => s + v, 0);
    const lead = flatten(a.a).map((t) => degrees(t.t)).sort((p, q) => total(q) - total(p))[0];
    for (const [k, v] of lead ?? []) into.set(k, (into.get(k) ?? 0) + v * Number(a.b.v));
  } else if (a.k === "neg") degrees(a.a, into);
  return into;
}

/**
 * A term's degrees for ordering. A fraction with the variable in its
 * denominator sorts ahead of that variable's polynomial terms, as the
 * handheld prints 2/(x−1)+x+1 and 1/(x+1)+x+1/(y+1)+y.
 */
function termDegrees(a: Ast): Map<string, number> {
  const d = degrees(a);
  const den = denominatorOf(a);
  if (den) {
    const names: string[] = [];
    mapAst(den, (x) => {
      if (x.k === "sym" && !CONSTANT_SYMS.has(x.name)) names.push(x.name);
      return x;
    });
    const main = names.sort(byVar)[0];
    if (main) d.set(main, (d.get(main) ?? 0) + 1000);
  }
  return d;
}

function denominatorOf(a: Ast): Ast | null {
  if (a.k === "bin" && a.op === "/") return a.b;
  if (a.k === "bin" && a.op === "*") return denominatorOf(a.a) ?? denominatorOf(a.b);
  if (a.k === "neg") return denominatorOf(a.a);
  return null;
}

function compareTerms(p: Ast, q: Ast): number {
  const dp = termDegrees(p);
  const dq = termDegrees(q);
  // Terms with a function of a variable (sin x, ℯ^x, ln x) come first,
  // exponentials ahead of the rest; then by degree in variable order.
  const fp = funcRank(p);
  const fq = funcRank(q);
  if (fp !== fq) return fq - fp;
  const names = [...new Set([...dp.keys(), ...dq.keys()])].sort(byVar);
  for (const n of names) {
    const diff = (dq.get(n) ?? 0) - (dp.get(n) ?? 0);
    if (diff) return diff;
  }
  // The imaginary part comes after the real part: x+1+2·i.
  const i = Number(hasI(p)) - Number(hasI(q));
  if (i) return i;
  // cos(x)·sin(y) before sin(x)·cos(y): by the function of the first variable.
  const [tp, tq] = [trigKey(p), trigKey(q)];
  return tp && tq && tp !== tq ? (tp < tq ? -1 : 1) : 0;
}

/** 2 for a term with ℯ^(…variable…), 1 for another function of a variable, else 0. */
function funcRank(a: Ast): number {
  let rank = 0;
  mapAst(a, (x) => {
    if (x.k === "bin" && x.op === "^" && x.a.k === "sym" && x.a.name === "ℯ" && hasVars(x.b)) rank = 2;
    else if (x.k === "call" && x.args.some(hasVars)) rank = Math.max(rank, 1);
    return x;
  });
  return rank;
}

const CONSTANT_SYMS = new Set(["π", "ℯ", "i", "∞"]);
const hasVars = (a: Ast): boolean => {
  let found = false;
  mapAst(a, (x) => {
    if (x.k === "sym" && !CONSTANT_SYMS.has(x.name)) found = true;
    return x;
  });
  return found;
};

/** Reorder a sum of terms the way the handheld prints it. */
function orderSum(a: Ast, ascending: boolean, swap = true): Ast {
  if (!(a.k === "bin" && (a.op === "+" || a.op === "-"))) return a;
  const terms = flatten(a);
  if (terms.length < 2) return a;
  // A constant: only the imaginary part moves, after the real part (1+√3·i).
  if (!terms.some((t) => hasVars(t.t))) {
    if (!terms.some((t) => hasI(t.t)) || ascending) return a;
    const sorted = [...terms].sort((p, q) => Number(hasI(p.t)) - Number(hasI(q.t)));
    if (sorted[0]!.neg && sorted.length > 1) {
      const k = sorted.findIndex((x) => !x.neg);
      if (k > 0 && !hasI(sorted[k]!.t)) sorted.unshift(...sorted.splice(k, 1));
    }
    return sorted.slice(1).reduce<Ast>(
      (acc, t) => ({ k: "bin", op: t.neg ? "-" : "+", a: acc, b: t.t }),
      sorted[0]!.neg ? { k: "neg", a: sorted[0]!.t } : sorted[0]!.t,
    );
  }
  const sorted = terms
    .map((t, i) => ({ ...t, i }))
    .sort((p, q) => (ascending ? -1 : 1) * compareTerms(p.t, q.t) || p.i - q.i);
  // A negative lead swaps with a positive term of the same total degree
  // (b³/3 − a³/3), or with a lone positive constant (3/2 − x/2).
  if (sorted[0]!.neg && !ascending && swap) {
    const total = (x: Ast) => [...degrees(x).values()].reduce((s, v) => s + v, 0);
    const lead = total(sorted[0]!.t);
    let k = sorted.findIndex((x) => !x.neg && total(x.t) === lead);
    if (k < 0 && sorted.length === 2 && !sorted[1]!.neg && !hasVars(sorted[1]!.t)) k = 1;
    if (k > 0) sorted.unshift(...sorted.splice(k, 1));
  } else if (sorted[0]!.neg && ascending) {
    // Lowest power first, but not a leading minus: z−1, not −1+z.
    const k = sorted.findIndex((x) => !x.neg);
    if (k > 0) sorted.unshift(...sorted.splice(k, 1));
  }
  return sorted.slice(1).reduce<Ast>(
    (acc, t) => ({ k: "bin", op: t.neg ? "-" : "+", a: acc, b: t.t }),
    sorted[0]!.neg ? { k: "neg", a: sorted[0]!.t } : sorted[0]!.t,
  );
}

function hasI(a: Ast): boolean {
  let found = false;
  mapAst(a, (x) => {
    if (x.k === "sym" && x.name === "i") found = true;
    return x;
  });
  return found;
}

const TRIG = ["sin", "cos", "tan"];
/** sin(x) and cos(x) as factors: by argument variable, then sin, cos, tan (2·sin(x)·cos(x)). */
function trigCall(a: Ast): { v: string; f: string } | null {
  const c = a.k === "bin" && a.op === "^" ? a.a : a;
  if (c.k !== "call" || !TRIG.includes(c.f) || !c.args[0]) return null;
  const names: string[] = [];
  mapAst(c.args[0], (x) => {
    if (x.k === "sym" && !CONSTANT_SYMS.has(x.name)) names.push(x.name);
    return x;
  });
  return { v: names.sort(byVar)[0] ?? "", f: c.f };
}
function trigOrder(p: Ast, q: Ast): number {
  const [a, b] = [trigCall(p), trigCall(q)];
  if (!a || !b) return 0;
  return byVar(a.v, b.v) || TRIG.indexOf(a.f) - TRIG.indexOf(b.f);
}
/** A term's trig factor on its first variable, by name ("cos" < "sin"), for ordering sums. */
function trigKey(a: Ast): string | null {
  const found: { v: string; f: string }[] = [];
  mapAst(a, (x) => {
    const t = trigCall(x);
    if (t && x.k === "call") found.push(t);
    return x;
  });
  if (found.length < 2) return null;
  return found.sort((p, q) => byVar(p.v, q.v))[0]!.f;
}
