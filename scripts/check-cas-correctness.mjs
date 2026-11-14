#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 VCE Hub. Part of the /cas calculator: https://github.com/vcehub/cas
/**
 * CAS correctness check: random exam-style inputs through the same evaluate()
 * the page uses, each answer verified numerically by an evaluator written
 * here (not Giac), so a wrong answer can't check itself.
 *
 * - solve/zeros: every answer satisfies the equation, and none in the
 *   domain is missing (sign changes and touch points on a fine grid).
 * - d, ∫ (indefinite and definite), tangentLine, normalLine, fMin, fMax,
 *   deSolve, f(x)|x=a, the form commands (expand, factor …), the
 *   distributions and linear systems.
 * - After every entry: no variable left assigned and no assumption left
 *   on x, y, a, b, k, t (the fMax(…)|0≤x≤2 leak).
 *
 *   node scripts/check-cas-correctness.mjs [--n 40] [--seed 1] [--only solve,fmin] [--show 20]
 */
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const args = process.argv.slice(2);
const opt = (name, dflt) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : dflt);
const N = Number(opt("n", 40));
const ONLY = opt("only", "") ? new Set(opt("only", "").split(",")) : null;
const SHOW = Number(opt("show", 15));

const build = path.join(root, "node_modules/.cache/cas-correctness-build");
rmSync(build, { recursive: true, force: true });
execFileSync(
  path.join(root, "node_modules/.bin/tsc"),
  [
    ...["math/ast.ts", "math/print.ts", "math/builtins.ts", "engine/translate.ts", "engine/format.ts", "engine/evaluate.ts", "graphs/analyze.ts", "finance/tvm.ts"].map((f) =>
      path.join(root, "features/cas", f),
    ),
    "--outDir", build, "--rootDir", path.join(root, "features/cas"),
    "--module", "commonjs", "--target", "es2022", "--skipLibCheck", "--strict",
  ],
  { stdio: "inherit" },
);
const require = createRequire(import.meta.url);
const { evaluate, setupCommands, DEFAULT_SETTINGS } = require(path.join(build, "engine/evaluate.js"));
const { parse } = require(path.join(build, "math/ast.js"));
const { analyze, sample, sampleGrid, sampleParametric, valueAt, slopeAt } = require(path.join(build, "graphs/analyze.js"));
const { solveTvm } = require(path.join(build, "finance/tvm.js"));

const M = require(path.join(root, "public/cas/giac/1.9.0/giacwasm.js"));
await new Promise((res) => (M.calledRun ? res() : (M.onRuntimeInitialized = res)));
const caseval = M.cwrap("caseval", "string", ["string"]);
// Giac prints warnings to the console; keep the report readable.
const quiet = (fn) => {
  const [log, err, warn] = [console.log, console.error, console.warn];
  console.log = console.error = console.warn = () => {};
  try {
    return fn();
  } finally {
    Object.assign(console, { log, error: err, warn });
  }
};
// As the page's worker does, a Giac exception comes back as an error string.
// It also leaves the wasm runtime broken (the page restarts its worker), so
// here it's reported as a crash and the run stops.
let crashed = null;
let current = "";
const giac = async (c) =>
  quiet(() => {
    if (crashed) return "Error: engine crashed";
    try {
      return caseval(c);
    } catch (e) {
      crashed = { input: current, cmd: c, error: String(e).slice(0, 200) };
      return `Error: ${e}`;
    }
  });
const restart = () => quiet(() => {
  caseval("restart");
  for (const c of setupCommands(DEFAULT_SETTINGS)) caseval(c);
});

// ------------------------------------------------------------ random
let seed = Number(opt("seed", 1)) >>> 0;
const rand = () => {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
const nz = (lo, hi) => {
  let v = 0;
  while (v === 0) v = int(lo, hi);
  return v;
};
const pick = (xs) => xs[Math.floor(rand() * xs.length)];
const sg = (v) => (v < 0 ? `-${-v}` : `+${v}`);

/** A Methods-style function of x, as entry text. */
function fn() {
  const [a, b, c, d] = [nz(-4, 4), nz(-3, 3), int(-5, 5), int(-4, 4)];
  return pick([
    () => `${a}*x^2${sg(b)}*x${sg(c)}`,
    () => `${a}*x^3${sg(b)}*x^2${sg(c)}*x${sg(d)}`,
    () => `x^3${sg(a)}*x`,
    () => `${a}*(x${sg(b)})^2*(x${sg(c)})`,
    () => `x^4${sg(a)}*x^2${sg(c)}`,
    () => `${a}*ℯ^(${b}*x)${sg(c)}`,
    () => `x*ℯ^(${b}*x)`,
    () => `${a}*ln(x${sg(Math.abs(b) + 1)})${sg(c)}`,
    () => `x*ln(x)`,
    () => `${a}*sin(${b}*x)${sg(c)}`,
    () => `${a}*cos(${b}*x)${sg(c)}`,
    () => `sin(x)+cos(x)`,
    () => `${a}*√(x${sg(Math.abs(b) + 1)})${sg(c)}`,
    () => `(${a}*x${sg(b)})/(x${sg(Math.abs(c) + 1)})`,
    () => `${a}/(x^2+${Math.abs(b)})`,
    () => `abs(x${sg(b)})${sg(c)}`,
    () => `x^2*ℯ^(-x)`,
    () => `${a}*tan(x)`,
  ])();
}

// ------------------------------------------------------------ numbers
/** Numeric value of an answer's AST, independent of Giac. NaN when it can't. */
let DEG = false;
function num(a, env = {}) {
  const r = (x) => num(x, env);
  switch (a.k) {
    case "num":
      return Number(a.v.replace(/\.$/, ""));
    case "sym":
      if (a.name === "π") return Math.PI;
      if (a.name === "ℯ") return Math.E;
      if (a.name === "∞") return Infinity;
      return a.name in env ? env[a.name] : NaN;
    case "neg":
      return -r(a.a);
    case "bin": {
      const [x, y] = [r(a.a), r(a.b)];
      switch (a.op) {
        case "+": return x + y;
        case "-": return x - y;
        case "*": return x * y;
        case "/": return x / y;
        case "^": {
          if (x < 0 && !Number.isInteger(y)) {
            // A real odd root: (−8)^(1/3) = −2.
            const inv = 1 / y;
            if (Math.abs(inv - Math.round(inv)) < 1e-9 && Math.round(inv) % 2) return -((-x) ** y);
          }
          return x ** y;
        }
        default: return NaN;
      }
    }
    case "call": {
      const v = a.args.map(r);
      const [p, q] = v;
      const [toR, fromR] = DEG ? [Math.PI / 180, 180 / Math.PI] : [1, 1];
      const F = {
        sin: (t) => Math.sin(t * toR), cos: (t) => Math.cos(t * toR), tan: (t) => Math.tan(t * toR),
        "sin⁻¹": (t) => Math.asin(t) * fromR, "cos⁻¹": (t) => Math.acos(t) * fromR, "tan⁻¹": (t) => Math.atan(t) * fromR,
        ln: Math.log, "√": Math.sqrt, abs: Math.abs, sign: Math.sign, exp: Math.exp, sinh: Math.sinh, cosh: Math.cosh,
      };
      if (a.f === "log") return v.length === 2 ? Math.log(p) / Math.log(q) : Math.log10(p);
      if (a.f === "root") return q % 2 && p < 0 ? -((-p) ** (1 / q)) : p ** (1 / q);
      return F[a.f] ? F[a.f](p) : NaN;
    }
    default:
      return NaN;
  }
}
const f = (text, x, env = {}) => num(parse(text), { ...env, x });
const close = (p, q, tol = 1e-6) => Math.abs(p - q) <= tol * Math.max(1, Math.abs(p), Math.abs(q));
/** A shown answer: 6 significant digits when it's a decimal, so only that close. */
const shownTol = (r, tol) => (r.ok && /\d\.\d*|\d\.(?!\d)/.test(r.outputText) ? Math.max(tol, 1e-5) : tol);

/** The x values in an answer like "x=1 or x=2", {1,2}, x=−∞ (NaN when one isn't numeric). */
function answers(ast, v = "x") {
  if (ast.k === "sym" && ast.name === "false") return [];
  if (ast.k === "list") return ast.items.map((i) => num(i));
  if (ast.k === "bin" && ast.op === "or") return [...answers(ast.a, v), ...answers(ast.b, v)];
  if (ast.k === "bin" && ast.op === "=" && ast.a.k === "sym" && ast.a.name === v) return [num(ast.b)];
  return [NaN];
}

/** Roots of g on [lo,hi]: sign changes, and touch points where |g| dips to ~0. */
function roots(g, lo, hi, steps = 6000) {
  const out = [];
  const h = (hi - lo) / steps;
  let px = lo;
  let pv = g(lo);
  for (let k = 1; k <= steps; k++) {
    const x = lo + k * h;
    const v = g(x);
    if (Number.isFinite(pv) && Number.isFinite(v)) {
      if (pv === 0) out.push(px);
      else if (pv * v < 0) {
        let [a, b] = [px, x];
        for (let i = 0; i < 80; i++) {
          const m = (a + b) / 2;
          if (g(a) * g(m) <= 0) b = m;
          else a = m;
        }
        // A jump through a pole isn't a root.
        if (Math.abs(g((a + b) / 2)) < 1e-6 * Math.max(1, Math.abs(pv), Math.abs(v))) out.push((a + b) / 2);
      }
    }
    px = x;
    pv = v;
  }
  if (Number.isFinite(g(hi)) && g(hi) === 0) out.push(hi);
  // Touch points: a local minimum of |g| that is ~0 without a sign change.
  for (let k = 1; k < steps; k++) {
    const [x0, x1, x2] = [lo + (k - 1) * h, lo + k * h, lo + (k + 1) * h];
    const [a0, a1, a2] = [Math.abs(g(x0)), Math.abs(g(x1)), Math.abs(g(x2))];
    if (a1 < a0 && a1 < a2 && a1 < 1e-4 && !out.some((r) => Math.abs(r - x1) < 2 * h)) out.push(x1);
  }
  return out.sort((p, q) => p - q);
}

// ------------------------------------------------------------ harness
const failures = [];
const counts = {};
let ans;
const TRACE = args.includes("--trace");
async function run(text) {
  current = text;
  // --trace: each input on stderr as it starts, so a Giac call that never returns shows which.
  if (TRACE) process.stderr.write(`${text}\n`);
  const r = await evaluate(text, giac, { settings: DEFAULT_SETTINGS, ans });
  if (r.ok) ans = r.output;
  return r;
}
function fail(family, input, got, why) {
  failures.push({ family, input, got, why });
}
/** Nothing assigned and nothing assumed on the usual names after an entry. */
async function leaks(family, input) {
  for (const v of ["x", "y", "a", "b", "k", "t"]) {
    const val = (await giac(v)).trim();
    const about = (await giac(`about(${v})`)).trim();
    if (val !== v || about !== v) {
      fail(family, input, `${v} = ${val}; about(${v}) = ${about}`, "left a value or assumption behind");
      await giac(`purge(${v})`);
    }
  }
}

async function family(name, make) {
  if (ONLY && !ONLY.has(name)) return;
  counts[name] = { ok: 0, n: 0 };
  restart();
  for (let k = 0; k < N && !crashed; k++) {
    const before = failures.length;
    let input = "";
    try {
      input = await make();
    } catch (e) {
      fail(name, input || current, String(e?.stack ?? e).split("\n").slice(0, 6).join(" | "), "checker crashed");
    }
    await leaks(name, input);
    counts[name].n++;
    if (failures.length === before) counts[name].ok++;
  }
}

const out = (r) => (r.ok ? r.outputText : r.error);

// solve(f(x)=k,x)|lo≤x≤hi: all roots there, nothing else.
await family("solve", async () => {
  const F = fn();
  const k = int(-3, 3);
  const [lo, hi] = pick([[-5, 5], [0, 4], [-3, 2], [0, 6.283185307179586]]);
  const dom = hi === 6.283185307179586 ? "0≤x≤2*π" : `${lo}≤x≤${hi}`;
  const input = `solve(${F}=${k},x)|${dom}`;
  const r = await run(input);
  if (!r.ok) return fail("solve", input, out(r), "error"), input;
  // true: every x in the domain works (where f is defined).
  if (r.outputText === "true") {
    for (let j = 0; j <= 50; j++) {
      const x = lo + ((hi - lo) * j) / 50;
      const v = f(F, x);
      if (Number.isFinite(v) && !close(v, k, 1e-9)) return fail("solve", input, out(r), `x=${x} gives ${v}`), input;
    }
    return input;
  }
  const got = answers(r.output);
  const want = roots((x) => f(F, x) - k, lo, hi);
  if (got.some(Number.isNaN)) return fail("solve", input, out(r), "an answer isn't a number"), input;
  for (const x of got) {
    if (x < lo - 1e-9 || x > hi + 1e-9) fail("solve", input, out(r), `x=${x} is outside the domain`);
    // Shown to 6 digits: the residual allowed grows with the slope there.
    else if (Math.abs(f(F, x) - k) > 2e-5 * Math.max(1, Math.abs(x)) * Math.max(1, Math.abs((f(F, x + 1e-6) - f(F, x - 1e-6)) / 2e-6)))
      fail("solve", input, out(r), `x=${x} gives ${f(F, x)}, not ${k}`);
  }
  // A touching root is only found to the grid's spacing.
  for (const x of want) if (!got.some((g) => Math.abs(g - x) < 1e-3)) fail("solve", input, out(r), `missing x≈${x.toFixed(6)}`);
  return input;
});

// d(f(x),x) against a central difference.
await family("d", async () => {
  const F = fn();
  const input = `d(${F},x)`;
  const r = await run(input);
  if (!r.ok) return fail("d", input, out(r), "error"), input;
  for (const x of [0.37, 1.3, 2.1]) {
    const h = 1e-5;
    const numeric = (f(F, x + h) - f(F, x - h)) / (2 * h);
    if (!Number.isFinite(numeric)) continue;
    const got = f(r.outputText, x);
    if (!close(got, numeric, 1e-4)) return fail("d", input, out(r), `at x=${x}: ${got}, numerically ${numeric}`), input;
  }
  return input;
});

// ∫(f(x),x): its derivative is f.
await family("antiderivative", async () => {
  const F = fn();
  const input = `∫(${F},x)`;
  const r = await run(input);
  if (!r.ok) return fail("antiderivative", input, out(r), "error"), input;
  if (/∫/.test(r.outputText)) return input;
  for (const x of [0.37, 1.3, 2.1]) {
    const h = 1e-5;
    const numeric = (f(r.outputText, x + h) - f(r.outputText, x - h)) / (2 * h);
    const want = f(F, x);
    if (!Number.isFinite(want) || !Number.isFinite(numeric)) continue;
    if (!close(numeric, want, 1e-4)) return fail("antiderivative", input, out(r), `d/dx at x=${x} is ${numeric}, f is ${want}`), input;
  }
  return input;
});

/** Simpson's rule, NaN if f isn't finite on [a,b]. */
function simpson(g, a, b, n = 4000) {
  const h = (b - a) / n;
  let s = g(a) + g(b);
  for (let k = 1; k < n; k++) s += (k % 2 ? 4 : 2) * g(a + k * h);
  return (s * h) / 3;
}

// ∫(f(x),x,a,b) against Simpson's rule.
await family("integral", async () => {
  const F = fn();
  const [a, b] = pick([[0, 1], [0, 2], [1, 3], [-1, 1], [0.5, 2]]);
  const input = `∫(${F},x,${a},${b})`;
  const want = simpson((x) => f(F, x), a, b);
  const r = await run(input);
  // tan has poles inside some intervals: no numeric answer to compare with.
  if (!Number.isFinite(want) || /tan/.test(F)) return input;
  if (!r.ok) return fail("integral", input, out(r), "error"), input;
  const got = num(r.output);
  if (!close(got, want, 1e-5)) fail("integral", input, out(r), `${got}, numerically ${want}`);
  return input;
});

// fMin/fMax(f(x),x)|a≤x≤b: the returned x reaches the sampled extreme.
await family("fminmax", async () => {
  const F = fn();
  const which = pick(["fMin", "fMax"]);
  const [lo, hi] = pick([[0, 4], [-2, 3], [-3, 3], [1, 5]]);
  const input = `${which}(${F},x)|${lo}≤x≤${hi}`;
  const r = await run(input);
  // tan and rational functions may have a pole in the interval.
  if (/tan|\)\/\(x/.test(F)) return input;
  const sgn = which === "fMin" ? 1 : -1;
  let best = Infinity;
  for (let k = 0; k <= 20000; k++) {
    const v = f(F, lo + ((hi - lo) * k) / 20000);
    if (Number.isFinite(v)) best = Math.min(best, sgn * v);
  }
  if (!r.ok) return fail("fminmax", input, out(r), "error"), input;
  const xs = answers(r.output);
  if (!xs.length || xs.some(Number.isNaN)) return fail("fminmax", input, out(r), "no numeric answer"), input;
  for (const x of xs) {
    const v = sgn * f(F, x);
    if (x < lo - 1e-9 || x > hi + 1e-9) fail("fminmax", input, out(r), `x=${x} is outside the domain`);
    else if (!(v <= best + 1e-6 * Math.max(1, Math.abs(best)))) fail("fminmax", input, out(r), `f(${x})=${sgn * v}, but ${sgn * best} is reached`);
  }
  return input;
});

// fMin/fMax with no domain: compared with a wide sample and the ends' behaviour.
await family("fminmax-open", async () => {
  const F = pick([() => `${nz(1, 3)}*x^2${sg(int(-4, 4))}*x`, () => `-${nz(1, 3)}*x^2${sg(int(-4, 4))}*x`, () => `x^3-3*x`, () => `x*ℯ^(-x)`, () => `x^4-${nz(1, 4)}*x^2`])();
  const which = pick(["fMin", "fMax"]);
  const input = `${which}(${F},x)`;
  const r = await run(input);
  if (!r.ok) return fail("fminmax-open", input, out(r), "error"), input;
  const sgn = which === "fMin" ? 1 : -1;
  const xs = answers(r.output);
  const far = [sgn * f(F, -1e4), sgn * f(F, 1e4)];
  const unbounded = far.some((v) => v < -1e6);
  if (unbounded) {
    if (!xs.some((x) => !Number.isFinite(x))) fail("fminmax-open", input, out(r), "the function is unbounded; expected x=±∞");
    return input;
  }
  let best = Infinity;
  for (let k = 0; k <= 40000; k++) {
    const v = sgn * f(F, -20 + (40 * k) / 40000);
    if (Number.isFinite(v)) best = Math.min(best, v);
  }
  for (const x of xs) {
    const v = Number.isFinite(x) ? sgn * f(F, x) : Math.min(...far);
    if (!(v <= best + 1e-6 * Math.max(1, Math.abs(best)))) fail("fminmax-open", input, out(r), `x=${x} gives ${sgn * v}, but ${sgn * best} is reached`);
  }
  return input;
});

// tangentLine / normalLine at a point: passes through it with the right slope.
await family("lines", async () => {
  const F = fn();
  const at = pick([0.5, 1, 2, -1, 3]);
  const which = pick(["tangentLine", "normalLine"]);
  const form = pick([`x,${at}`, `x=${at}`]);
  const input = `${which}(${F},${form})`;
  // abs at its corner has no slope (undef is right).
  if (/abs/.test(F)) return input;
  const y0 = f(F, at);
  const h = 1e-6;
  const m = (f(F, at + h) - f(F, at - h)) / (2 * h);
  const r = await run(input);
  if (!Number.isFinite(y0) || !Number.isFinite(m)) return input;
  if (!r.ok) return fail("lines", input, out(r), "error"), input;
  if (which === "normalLine" && Math.abs(m) < 1e-6) {
    if (!/^x=/.test(r.outputText)) fail("lines", input, out(r), "slope 0: the normal is vertical, x=a");
    return input;
  }
  const L = (x) => f(r.outputText, x);
  const want = which === "tangentLine" ? m : -1 / m;
  if (!close(L(at), y0, 1e-5)) fail("lines", input, out(r), `L(${at})=${L(at)}, f(${at})=${y0}`);
  else if (!close(L(at + 1) - L(at), want, 1e-4)) fail("lines", input, out(r), `slope ${L(at + 1) - L(at)}, want ${want}`);
  return input;
});

// Define f, then f(a) and f(x)|x=a.
await family("define", async () => {
  const F = fn();
  const a = pick([0, 1, 2, -1, 0.5, "√(2)", "π/4"]);
  await run(`Define g(x)=${F}`);
  const want = f(F, num(parse(String(a))));
  if (!Number.isFinite(want)) return `Define g(x)=${F}`;
  for (const input of [`g(${a})`, `g(x)|x=${a}`]) {
    const r = await run(input);
    if (!r.ok) fail("define", `g(x)=${F}: ${input}`, out(r), "error");
    // A decimal input gives a 6-digit answer.
    else if (!close(num(r.output), want, String(a).includes(".") ? 1e-5 : 1e-6)) fail("define", `g(x)=${F}: ${input}`, out(r), `${num(r.output)}, want ${want}`);
  }
  return `Define g(x)=${F}`;
});

// solve(f(x)=k,x)|x<a or x>b: the roots on either side, nothing in between.
await family("solve-or", async () => {
  const F = fn();
  const k = int(-3, 3);
  const [a, b] = pick([[-1, 1], [0, 2], [-2, 0.5], [1, 3]]);
  const input = `solve(${F}=${k},x)|-5≤x≤${a} or ${b}≤x≤5`;
  const r = await run(input);
  if (!r.ok) return fail("solve-or", input, out(r), "error"), input;
  if (r.outputText === "true") return input;
  const got = answers(r.output);
  const want = [...roots((x) => f(F, x) - k, -5, a), ...roots((x) => f(F, x) - k, b, 5)];
  if (got.some(Number.isNaN)) return fail("solve-or", input, out(r), "an answer isn't a number"), input;
  for (const x of got) if (x > a + 1e-9 && x < b - 1e-9) fail("solve-or", input, out(r), `x=${x} is between the two parts`);
  for (const x of want) if (!got.some((g) => Math.abs(g - x) < 1e-3)) fail("solve-or", input, out(r), `missing x≈${x.toFixed(6)}`);
  return input;
});

// Define g(x)=f(x)|lo≤x≤hi: f's value inside, undef outside; and |k=… is put into the body.
await family("define-restricted", async () => {
  const F = fn();
  const [lo, hi] = pick([[-2, 2], [0, 3], [-1, 4]]);
  const def = `Define g(x)=${F}|${lo}≤x≤${hi}`;
  await run(def);
  for (const x of [lo - 1.5, (lo + hi) / 2, hi + 0.5, lo, hi]) {
    const r = await run(`g(${x})`);
    const inside = x >= lo && x <= hi;
    const want = f(F, x);
    if (!inside) {
      if (!r.ok || r.outputText !== "undef") fail("define-restricted", `${def}: g(${x})`, out(r), "want undef outside the domain");
    } else if (!Number.isFinite(want)) continue;
    else if (!r.ok || !close(num(r.output), want, String(x).includes(".") ? 1e-5 : 1e-6)) fail("define-restricted", `${def}: g(${x})`, out(r), `want ${want}`);
  }
  const c = int(1, 4);
  await run(`h(x):=x^2+k*x|k=${c}`);
  const r = await run("h(2)");
  if (!r.ok || num(r.output) !== 4 + 2 * c) fail("define-restricted", `h(x):=x^2+k*x|k=${c}: h(2)`, out(r), `want ${4 + 2 * c}`);
  return def;
});

// solve(system,x,y): the variables one by one are the list {x,y}.
await family("solve-vars", async () => {
  const [x0, y0] = [int(-5, 5), int(-5, 5)];
  const [a, b, c, d] = [nz(-4, 4), nz(-4, 4), nz(-4, 4), nz(-4, 4)];
  if (a * d - b * c === 0) return "singular";
  const sys = `${a}*x${sg(b)}*y=${a * x0 + b * y0} and ${c}*x${sg(d)}*y=${c * x0 + d * y0}`;
  const [r1, r2] = [await run(`solve(${sys},{x,y})`), await run(`solve(${sys},x,y)`)];
  if (out(r1) !== out(r2)) fail("solve-vars", `solve(${sys},x,y)`, out(r2), `want ${out(r1)}, as with {x,y}`);
  return sys;
});

// With a value stored in x: d(f(x),x) is f′ there, a definite integral doesn't depend on it,
// and a command that needs x as a variable says so rather than answer with the value worked in.
// x(…) is a call of the function x, an error with x a variable, never x times (…).
await family("stored-var", async () => {
  const F = fn();
  const v = pick([1, 2, 0.5, 3]);
  const [w, h] = [pick([0.25, 1.5, 2]), 1e-5];
  // NaN at a corner (abs(x−3) at 3), where d() is rightly undef.
  const slope = (at) => {
    const [l, r] = [(f(F, at) - f(F, at - h)) / h, (f(F, at + h) - f(F, at)) / h];
    return close(l, r, 1e-3) ? (f(F, at + h) - f(F, at - h)) / (2 * h) : NaN;
  };
  await run(`${v}→x`);
  const checks = [
    [`d(${F},x)`, slope(v)],
    [`d(${F},x)|x=${w}`, slope(w)],
  ];
  // Simpson's rule over [0,1].
  const simpson = Array.from({ length: 201 }, (_, k) => (k === 0 || k === 200 ? 1 : k % 2 ? 4 : 2) * f(F, k / 200)).reduce((p, q) => p + q, 0) / 600;
  checks.push([`∫(${F},x,0,1)`, simpson]);
  for (const [input, want] of checks) {
    if (!Number.isFinite(want)) continue;
    const r = await run(input);
    if (!r.ok || !close(num(r.output), want, shownTol(r, 1e-4))) fail("stored-var", `${v}→x: ${input}`, out(r), `want ${want}`);
  }
  for (const input of [`fMin(${F},x)`, `tangentLine(${F},x,1)`, `∫(${F},x)`, `x(x${sg(nz(-5, 5))})^2`]) {
    const r = await run(input);
    if (r.ok) fail("stored-var", `${v}→x: ${input}`, out(r), "want an error: x holds a value");
  }
  await run("DelVar x");
  const r = await run(`x(${nz(1, 6)}-x)^2`);
  if (r.ok) fail("stored-var", "x(6-x)^2", out(r), "want Invalid implied multiply");
  return F;
});

// Form commands keep the value: expand, factor, completeSquare, propFrac, comDenom, tExpand, tCollect.
await family("forms", async () => {
  const [a, b, c] = [nz(-4, 4), nz(-5, 5), int(-6, 6)];
  const input = pick([
    `expand((${a}*x${sg(b)})^3)`,
    `expand((x${sg(b)})*(x${sg(c)})*(x${sg(a)}))`,
    `factor(x^3${sg(-(b + c))}*x^2${sg(b * c)}*x)`,
    `factor(${a}*x^2${sg(a * (b + c))}*x${sg(a * b * c)})`,
    `factor(x^2${sg(b)}*x${sg(c)},x)`,
    `completeSquare(${a}*x^2${sg(b)}*x${sg(c)},x)`,
    `propFrac((${a}*x^2${sg(b)})/(x${sg(c || 1)}))`,
    `comDenom(1/(x${sg(b)})+${a}/(x${sg(c || 1)}))`,
    `expand((${a}*x${sg(b)})/((x${sg(c || 1)})*(x${sg((c || 1) + 1)})))`,
    `tExpand(sin(${Math.abs(b)}*x))`,
    `tCollect(sin(x)^${Math.abs(a) + 1})`,
  ]);
  const inner = input.replace(/^[A-Za-z]+\((.*?)(,x)?\)$/, "$1");
  const r = await run(input);
  if (!r.ok) return fail("forms", input, out(r), "error"), input;
  for (const x of [0.37, 1.7, -2.3]) {
    const [p, q] = [f(inner, x), f(r.outputText, x)];
    if (Number.isFinite(p) && !close(p, q, 1e-6)) return fail("forms", input, out(r), `at x=${x}: ${q}, the input is ${p}`), input;
  }
  return input;
});

// deSolve first-order with a condition: satisfies the equation and the condition.
await family("desolve", async () => {
  const [a, b, y0] = [nz(-3, 3), int(-4, 4), nz(-3, 3)];
  const [ode, rhs] = pick([
    [`y'=${a}*y${sg(b)}`, (x, y) => a * y + b],
    [`y'=${a}*x*y`, (x, y) => a * x * y],
    [`y'=${a}*x^2${sg(b)}`, (x) => a * x * x + b],
    [`y'=${a}*cos(x)`, (x) => a * Math.cos(x)],
    [`y'=${a}*ℯ^(${b || 1}*x)`, (x) => a * Math.exp((b || 1) * x)],
  ]);
  const input = `deSolve(${ode} and y(0)=${y0},x,y)`;
  const r = await run(input);
  if (!r.ok) return fail("desolve", input, out(r), "error"), input;
  const m = /^y=(.*)$/.exec(r.outputText);
  if (!m) return fail("desolve", input, out(r), "not y=…"), input;
  const Y = (x) => f(m[1], x);
  if (!close(Y(0), y0, 1e-6)) return fail("desolve", input, out(r), `y(0)=${Y(0)}, want ${y0}`), input;
  for (const x of [0.3, 0.9]) {
    const h = 1e-6;
    const dy = (Y(x + h) - Y(x - h)) / (2 * h);
    if (!close(dy, rhs(x, Y(x)), 1e-4)) return fail("desolve", input, out(r), `y' at ${x} is ${dy}, the equation wants ${rhs(x, Y(x))}`), input;
  }
  return input;
});

// Linear systems.
await family("systems", async () => {
  const [x0, y0] = [int(-5, 5), int(-5, 5)];
  const [a, b, c, d] = [nz(-4, 4), nz(-4, 4), nz(-4, 4), nz(-4, 4)];
  if (a * d - b * c === 0) return "singular";
  const input = `solve(${a}*x${sg(b)}*y=${a * x0 + b * y0} and ${c}*x${sg(d)}*y=${c * x0 + d * y0},{x,y})`;
  const r = await run(input);
  if (!r.ok) return fail("systems", input, out(r), "error"), input;
  if (r.outputText.replace(/\s/g, "") !== `x=${x0}andy=${y0}`.replace("+", "")) fail("systems", input, out(r), `want x=${x0} and y=${y0}`);
  return input;
});

// Distributions against direct sums and the error function.
const erf = (x) => {
  // Abramowitz–Stegun 7.1.26 is too coarse; integrate the density instead.
  return (2 / Math.sqrt(Math.PI)) * simpson((t) => Math.exp(-t * t), 0, x, 20000);
};
const choose = (n, k) => {
  let c = 1;
  for (let i = 1; i <= k; i++) c = (c * (n - k + i)) / i;
  return c;
};
await family("distributions", async () => {
  const kind = pick(["normCdf", "binomPdf", "binomCdf", "poissCdf", "invNorm"]);
  let input;
  let want;
  if (kind === "normCdf") {
    const [mu, s] = [int(-5, 20), int(1, 6)];
    const [lo, hi] = [mu - int(0, 3) * s * rand(), mu + int(0, 3) * s * rand()].map((v) => Math.round(v * 10) / 10);
    input = `normCdf(${lo},${hi},${mu},${s})`;
    want = (erf((hi - mu) / (s * Math.SQRT2)) - erf((lo - mu) / (s * Math.SQRT2))) / 2;
  } else if (kind === "invNorm") {
    const [p, mu, s] = [int(1, 99) / 100, int(-5, 20), int(1, 6)];
    input = `invNorm(${p},${mu},${s})`;
    // Check it by going back through the cdf.
    const r = await run(input);
    if (!r.ok) return fail(kind, input, out(r), "error"), input;
    const x = num(r.output);
    const back = (1 + erf((x - mu) / (s * Math.SQRT2))) / 2;
    // The answer shows 6 digits, so Φ of it is only that close.
    if (!close(back, p, 1e-4)) fail("distributions", input, out(r), `Φ of the answer is ${back}, not ${p}`);
    return input;
  } else {
    const [n, p, k] = [int(2, 30), int(1, 9) / 10, 0];
    const kk = int(0, n);
    if (kind === "binomPdf") {
      input = `binomPdf(${n},${p},${kk})`;
      want = choose(n, kk) * p ** kk * (1 - p) ** (n - kk);
    } else if (kind === "binomCdf") {
      const lo = int(0, kk);
      input = `binomCdf(${n},${p},${lo},${kk})`;
      want = 0;
      for (let i = lo; i <= kk; i++) want += choose(n, i) * p ** i * (1 - p) ** (n - i);
    } else {
      const lam = int(1, 8);
      input = `poissCdf(${lam},${k},${kk})`;
      want = 0;
      let term = Math.exp(-lam);
      for (let i = 0; i <= kk; i++) {
        want += term;
        term = (term * lam) / (i + 1);
      }
    }
  }
  const r = await run(input);
  if (!r.ok) return fail("distributions", input, out(r), "error"), input;
  // The display has 6 significant digits.
  if (!close(num(r.output), want, 5e-6)) fail("distributions", input, out(r), `want ${want}`);
  return input;
});

// Graphs → Analyze Graph over an interval, as the page calls it.
await family("analyze", async () => {
  const F = pick([fn, fn, () => `(x${sg(nz(-3, 3))})^2${sg(int(-1, 1))}`, () => `x^3${sg(nz(-3, 3))}*x^2`])();
  const G = fn();
  const [a, b] = pick([[-4, 4], [-2, 3], [0, 5], [-5, 0]]);
  const kind = pick(["zero", "min", "max", "intersection", "integral", "inflection"]);
  const input = `${kind} of f1(x)=${F}${kind === "intersection" ? ` with f2(x)=${G}` : ""} on [${a},${b}]`;
  if (kind === "intersection" && F === G) return input;
  if (/tan|\)\/\(x/.test(F + (kind === "intersection" ? G : ""))) return input;
  await run(`Define f1(x)=${F}`);
  await run(`Define f2(x)=${G}`);
  current = input;
  const m = await analyze(giac, kind, 1, "f1", kind === "intersection" ? "f2" : undefined, a, b);
  if (crashed) return fail("analyze", input, crashed.error, "engine crashed"), input;
  const F1 = (x) => f(F, x);
  if (kind === "integral") {
    const want = simpson(F1, a, b);
    if (!Number.isFinite(want)) return input;
    if (!m) fail("analyze", input, "nothing", `want ${want}`);
    else if (!close(m.value, want, 1e-6)) fail("analyze", input, String(m.value), `want ${want}`);
    return input;
  }
  if (kind === "min" || kind === "max") {
    const sgn = kind === "min" ? 1 : -1;
    let best = Infinity;
    for (let k = 0; k <= 20000; k++) {
      const v = sgn * F1(a + ((b - a) * k) / 20000);
      if (Number.isFinite(v)) best = Math.min(best, v);
    }
    if (!Number.isFinite(best)) return input;
    if (!m) fail("analyze", input, "nothing", `want ${sgn * best}`);
    else if (sgn * m.y > best + 1e-6 * Math.max(1, Math.abs(best))) fail("analyze", input, `(${m.x}, ${m.y})`, `${sgn * best} is reached`);
    return input;
  }
  const g =
    kind === "zero" ? F1 : kind === "intersection" ? (x) => F1(x) - f(G, x) : (x) => (F1(x + 1e-4) - 2 * F1(x) + F1(x - 1e-4)) / 1e-8;
  const want = roots(g, a, b);
  // An inflection needs a sign change of f″, not just f″=0.
  const real = kind === "inflection" ? want.filter((x) => Math.sign(g(x - 1e-3)) !== Math.sign(g(x + 1e-3))) : want;
  if (!m) {
    if (real.length) fail("analyze", input, "nothing found", `there is one at x≈${real[0].toFixed(6)}`);
    return input;
  }
  if (m.x < a - 1e-9 || m.x > b + 1e-9) fail("analyze", input, `x=${m.x}`, "outside the interval");
  else if (kind !== "inflection" && Math.abs(g(m.x)) > 1e-6 * Math.max(1, Math.abs(F1(m.x)))) fail("analyze", input, `x=${m.x}`, `not a ${kind}: ${g(m.x)}`);
  return input;
});

// limit, nSolve, nInt, arcLen, impDif and Σ, each against a numeric answer.
await family("calculus-more", async () => {
  const F = fn();
  const [k, a] = [nz(-4, 4), pick([0.5, 1, 2, -1, 1.5])];
  const which = pick(["limit", "limit-classic", "nSolve", "nSolve-range", "nInt", "arcLen", "impDif", "sum"]);
  let input;
  let want;
  let check = (v) => close(v, want, 1e-5);
  if (which === "limit") {
    input = `limit(${F},x,${a})`;
    want = f(F, a);
    if (!Number.isFinite(want) || /abs|tan/.test(F)) return input;
  } else if (which === "limit-classic") {
    [input, want] = pick([
      [`limit(sin(${k}*x)/x,x,0)`, k],
      [`limit((x^2-${k * k})/(x${sg(-k)}),x,${k})`, 2 * k],
      [`limit((1+${k}/x)^x,x,∞)`, Math.exp(k)],
      [`limit((ℯ^(${k}*x)-1)/x,x,0)`, k],
      [`limit((${k}*x^2+1)/(x^2+3),x,∞)`, k],
    ]);
  } else if (which === "nSolve" || which === "nSolve-range") {
    const c = int(-3, 3);
    const [lo, hi] = [-3, 4];
    input = which === "nSolve" ? `nSolve(${F}=${c},x)` : `nSolve(${F}=${c},x,${lo},${hi})`;
    const r = await run(input);
    const rs = roots((x) => f(F, x) - c, which === "nSolve" ? -50 : lo, which === "nSolve" ? 50 : hi);
    if (!r.ok) return fail("calculus-more", input, out(r), "error"), input;
    if (r.output.k === "str") {
      if (rs.length && which === "nSolve-range") fail("calculus-more", input, out(r), `there is a root at x≈${rs[0].toFixed(6)}`);
      return input;
    }
    const x = num(r.output);
    // At the edge of a domain one side is undefined: a one-sided slope.
    const slope = Math.abs((f(F, x + 1e-6) - f(F, x - 1e-6)) / 2e-6) || Math.abs((f(F, x + 1e-6) - f(F, x)) / 1e-6) || 1;
    if (!(Math.abs(f(F, x) - c) <= 2e-5 * Math.max(1, Math.abs(x)) * Math.max(1, slope))) fail("calculus-more", input, out(r), `f(${x})=${f(F, x)}, not ${c}`);
    if (which === "nSolve-range" && (x < lo || x > hi)) fail("calculus-more", input, out(r), "outside the range");
    return input;
  } else if (which === "nInt") {
    const [lo, hi] = pick([[0, 1], [1, 2], [-1, 1]]);
    input = `nInt(${F},x,${lo},${hi})`;
    want = simpson((x) => f(F, x), lo, hi);
    if (!Number.isFinite(want) || /tan/.test(F)) return input;
  } else if (which === "arcLen") {
    const [lo, hi] = pick([[0, 1], [1, 2]]);
    input = `arcLen(${F},x,${lo},${hi})`;
    const d = (x) => (f(F, x + 1e-6) - f(F, x - 1e-6)) / 2e-6;
    want = simpson((x) => Math.sqrt(1 + d(x) ** 2), lo, hi, 2000);
    if (!Number.isFinite(want) || /tan|abs/.test(F)) return input;
    check = (v) => close(v, want, 1e-4);
  } else if (which === "impDif") {
    const [p, q] = [nz(1, 3), nz(1, 3)];
    input = `impDif(${p}*x^2*y+y^3=${q}*x,x,y)`;
    const r = await run(input);
    if (!r.ok) return fail("calculus-more", input, out(r), "error"), input;
    const [x0, y0] = [0.7, 1.3];
    const fx = 2 * p * x0 * y0 - q;
    const fy = p * x0 * x0 + 3 * y0 * y0;
    const got = num(r.output, { x: x0, y: y0 });
    if (!close(got, -fx / fy, 1e-8)) fail("calculus-more", input, out(r), `at (0.7,1.3): ${got}, want ${-fx / fy}`);
    return input;
  } else {
    const [c2, c1, c0, n] = [int(-3, 3), int(-3, 3), int(-3, 3), int(3, 30)];
    input = `Σ(${c2}*k^2${sg(c1)}*k${sg(c0)},k,1,${n})`;
    want = 0;
    for (let j = 1; j <= n; j++) want += c2 * j * j + c1 * j + c0;
  }
  const r = await run(input);
  if (!r.ok) return fail("calculus-more", input, out(r), "error"), input;
  const v = num(r.output);
  if (!check(v)) fail("calculus-more", input, out(r), `want ${want}`);
  return input;
});

// Degree mode: solve with the domain in degrees, sin/cos/tan of degrees.
await family("degrees", async () => {
  const settings = { ...DEFAULT_SETTINGS, angle: "deg" };
  for (const c of setupCommands(settings)) await giac(c);
  const [a, b] = [nz(1, 3), int(-2, 2)];
  const fns = { sin: (d) => Math.sin((d * Math.PI) / 180), cos: (d) => Math.cos((d * Math.PI) / 180), tan: (d) => Math.tan((d * Math.PI) / 180) };
  const t = pick(["sin", "cos", "tan"]);
  const k = pick(["1/2", "-1/2", "√(3)/2", "1", "0", "0.3", "-0.7", "√(2)/2"]);
  const kv = num(parse(k));
  const input = `solve(${t}(${a}*x${sg(b * 15)})=${k},x)|0≤x≤360`;
  current = input;
  const r = await evaluate(input, giac, { settings });
  for (const c of setupCommands(DEFAULT_SETTINGS)) await giac(c);
  DEG = true;
  const done = () => (DEG = false);
  const g = (x) => fns[t](a * x + b * 15) - kv;
  if (t !== "tan" && Math.abs(kv) > 1) return done(), input;
  if (!r.ok) return done(), fail("degrees", input, out(r), "error"), input;
  const got = answers(r.output);
  done();
  if (got.some(Number.isNaN)) return fail("degrees", input, out(r), "an answer isn't a number"), input;
  for (const x of got) if (x < -1e-9 || x > 360 + 1e-9 || Math.abs(g(x)) > 1e-4) fail("degrees", input, out(r), `x=${x} doesn't solve it in [0,360]`);
  for (const x of roots(g, 0, 360, 36000)) if (!got.some((y) => Math.abs(y - x) < 1e-2)) fail("degrees", input, out(r), `missing x≈${x.toFixed(4)}`);
  return input;
});

// ------------------------------------------------------------ complex
/** Complex value [re, im] of an AST, independent of Giac; NaN parts when it can't. */
const C = {
  add: ([a, b], [c, d]) => [a + c, b + d],
  sub: ([a, b], [c, d]) => [a - c, b - d],
  mul: ([a, b], [c, d]) => [a * c - b * d, a * d + b * c],
  div: ([a, b], [c, d]) => {
    const m = c * c + d * d;
    return [(a * c + b * d) / m, (b * c - a * d) / m];
  },
  exp: ([a, b]) => [Math.exp(a) * Math.cos(b), Math.exp(a) * Math.sin(b)],
  log: ([a, b]) => [Math.log(Math.hypot(a, b)), Math.atan2(b, a)],
  abs: ([a, b]) => Math.hypot(a, b),
};
C.pow = (z, w) => {
  if (w[1] === 0 && Number.isInteger(w[0]) && Math.abs(w[0]) <= 64) {
    let r = [1, 0];
    for (let k = 0; k < Math.abs(w[0]); k++) r = C.mul(r, z);
    return w[0] < 0 ? C.div([1, 0], r) : r;
  }
  if (z[0] === 0 && z[1] === 0) return [0, 0];
  return C.exp(C.mul(w, C.log(z)));
};
const NaNc = [NaN, NaN];
function cnum(a, env = {}) {
  const r = (x) => cnum(x, env);
  switch (a.k) {
    case "num":
      return [Number(a.v.replace(/\.$/, "")), 0];
    case "sym":
      if (a.name === "i") return [0, 1];
      if (a.name === "π") return [Math.PI, 0];
      if (a.name === "ℯ") return [Math.E, 0];
      return env[a.name] ?? NaNc;
    case "neg": {
      const [x, y] = r(a.a);
      return [0 - x, 0 - y];
    }
    case "bin": {
      if (a.op === "∠") {
        const [m] = r(a.a);
        const [t] = r(a.b);
        return [m * Math.cos(t), m * Math.sin(t)];
      }
      const [p, q] = [r(a.a), r(a.b)];
      if (a.op === "+") return C.add(p, q);
      if (a.op === "-") return C.sub(p, q);
      if (a.op === "*") return C.mul(p, q);
      if (a.op === "/") return C.div(p, q);
      if (a.op === "^") return C.pow(p, q);
      return NaNc;
    }
    case "call": {
      const v = a.args.map(r);
      const z = v[0] ?? NaNc;
      switch (a.f) {
        case "√": return C.pow(z, [0.5, 0]);
        case "abs": return [C.abs(z), 0];
        case "conj": return [z[0], -z[1]];
        case "real": return [z[0], 0];
        case "imag": return [z[1], 0];
        case "angle": return [Math.atan2(z[1], z[0]), 0];
        case "ln": return C.log(z);
        case "exp": return C.exp(z);
        case "tan⁻¹": return z[1] === 0 ? [Math.atan(z[0]), 0] : NaNc;
        case "sin": return z[1] === 0 ? [Math.sin(z[0]), 0] : NaNc;
        case "cos": return z[1] === 0 ? [Math.cos(z[0]), 0] : NaNc;
        default: return NaNc;
      }
    }
    default:
      return NaNc;
  }
}
const cclose = (p, q, tol = 1e-6) => C.abs(C.sub(p, q)) <= tol * Math.max(1, C.abs(p), C.abs(q));
const RECT = { ...DEFAULT_SETTINGS, complex: "rect" };
async function runIn(settings, text) {
  current = text;
  for (const c of setupCommands(settings)) await giac(c);
  const r = await evaluate(text, giac, { settings, ans });
  for (const c of setupCommands(DEFAULT_SETTINGS)) await giac(c);
  if (r.ok) ans = r.output;
  return r;
}
// Angles students meet, the half-angle ones included (Giac's evalc and normal got π/12 and 5π/12 wrong).
const ANG = () => pick(["π/2", "π/3", "π/4", "π/6", "π/12", "5*π/12", "7*π/12", "2*π/3", "-π/4", "-5*π/6", "π", "3*π/4", "π/8", "π/5"]);
const cplx = () => {
  const [a, b] = [int(-5, 5), nz(-5, 5)];
  return `(${a}${b < 0 ? "-" : "+"}${Math.abs(b)}*i)`;
};

// Complex arithmetic in Rectangular mode.
await family("complex", async () => {
  const [z, w] = [cplx(), cplx()];
  const n = int(2, 6);
  const input = pick([
    `${z}*${w}`, `${z}/${w}`, `${z}+${w}`, `${z}^${n}`, `conj(${z})*${w}`, `abs(${z})`, `real(${z}*${w})`,
    `imag(${z}/${w})`, `angle(${z})`, `√(${-(nz(1, 9) ** 2)})`, `√(${z})`, `ℯ^(i*${ANG()})*${nz(1, 4)}`,
    `(${nz(1, 5)}∠${ANG()})*(${nz(1, 5)}∠${ANG()})`, `(${nz(1, 5)}∠${ANG()})+(${nz(1, 5)}∠${ANG()})`, `(${nz(1, 5)}∠${ANG()})/(${nz(1, 5)}∠${ANG()})`,
    `(${nz(1, 3)}∠${ANG()})^${int(2, 5)}`, `1/${z}`, `${z}^(-1)`,
  ]);
  const r = await runIn(RECT, input);
  if (!r.ok) return fail("complex", input, out(r), "error"), input;
  const want = cnum(parse(input));
  const got = cnum(r.output);
  if (!cclose(got, want, shownTol(r, 1e-6))) fail("complex", input, out(r), `value ${got}, want ${want}`);
  return input;
});

/** All roots of a polynomial (coefficients high to low), Durand–Kerner. */
function polyRootsC(cs) {
  const n = cs.length - 1;
  const lead = cs[0];
  const p = (z) => cs.reduce((acc, c) => C.add(C.mul(acc, z), [c / lead, 0]), [0, 0]);
  let zs = Array.from({ length: n }, (_, k) => C.pow([0.4, 0.9], [k, 0]));
  for (let it = 0; it < 2000; it++) {
    zs = zs.map((z, i) => {
      let d = [1, 0];
      zs.forEach((w, j) => {
        if (j !== i) d = C.mul(d, C.sub(z, w));
      });
      return C.sub(z, C.div(p(z), d));
    });
  }
  return zs;
}

// cSolve, cZeros and cFactor of polynomials: every root right, none missing.
await family("csolve", async () => {
  const d = int(2, 4);
  const cs = [nz(1, 3), ...Array.from({ length: d }, () => int(-6, 6))];
  if (cs[d] === 0) cs[d] = nz(1, 5);
  const P = cs.map((c, k) => (c ? `${k ? sg(c) : c}*z^${d - k}` : "")).join("").replace(/\*z\^0/g, "");
  const which = pick(["cSolve", "cZeros", "cFactor"]);
  const input = which === "cSolve" ? `cSolve(${P}=0,z)` : which === "cZeros" ? `cZeros(${P},z)` : `cFactor(${P},z)`;
  const r = await run(input);
  if (crashed) return input;
  if (!r.ok) return fail("csolve", input, out(r), "error"), input;
  const Pz = (zv) => cnum(parse(P), { z: zv });
  if (which === "cFactor") {
    for (const zv of [[0.3, 0.7], [-1.2, 0.4], [2, -1]]) {
      const got = cnum(r.output, { z: zv });
      if (!cclose(got, Pz(zv), 1e-5)) return fail("csolve", input, out(r), `at z=${zv}: ${got}, want ${Pz(zv)}`), input;
    }
    return input;
  }
  const vals = [];
  const walk = (x) => {
    if (x.k === "bin" && x.op === "or") (walk(x.a), walk(x.b));
    else if (x.k === "bin" && x.op === "=") vals.push(cnum(x.b));
    else if (x.k === "list") x.items.forEach((i) => vals.push(cnum(i)));
  };
  walk(r.output);
  const want = polyRootsC(cs);
  for (const v of vals) {
    const scale = Math.max(1, ...cs.map(Math.abs)) * Math.max(1, C.abs(v)) ** d;
    if (!(C.abs(Pz(v)) <= 2e-5 * scale)) fail("csolve", input, out(r), `z=${v} gives ${Pz(v)}`);
  }
  for (const w of want) if (!vals.some((v) => cclose(v, w, 1e-4))) fail("csolve", input, out(r), `missing z≈${w.map((x) => x.toFixed(5))}`);
  return input;
});

// ▶Polar and ▶Rect keep the value.
await family("polar", async () => {
  const z = cplx();
  const input = pick([`${z}▶Polar`, `(${nz(1, 6)}∠${ANG()})▶Rect`, `ℯ^(i*${ANG()})*${nz(1, 5)}▶Rect`]);
  const r = await runIn(RECT, input);
  if (!r.ok) return fail("polar", input, out(r), "error"), input;
  const want = cnum(parse(input.replace(/▶(Polar|Rect)$/, "")));
  const got = cnum(r.output);
  if (!cclose(got, want, shownTol(r, 1e-6))) fail("polar", input, out(r), `value ${got}, want ${want}`);
  return input;
});

// ------------------------------------------------------------ matrices
const matText = (m) => `[${m.map((row) => `[${row.join(",")}]`).join("")}]`;
const matOf = (a) => (a.k === "mat" ? a.rows.map((row) => row.map((x) => num(x))) : a.k === "list" ? [a.items.map((x) => num(x))] : null);
const mmul = (A, B) => A.map((row) => B[0].map((_, j) => row.reduce((s, v, k) => s + v * B[k][j], 0)));
function detJS(m) {
  const n = m.length;
  if (n === 1) return m[0][0];
  let d = 0;
  for (let j = 0; j < n; j++) d += (j % 2 ? -1 : 1) * m[0][j] * detJS(m.slice(1).map((row) => row.filter((_, k) => k !== j)));
  return d;
}
function rrefJS(m) {
  const a = m.map((row) => row.slice());
  let lead = 0;
  for (let r = 0; r < a.length && lead < a[0].length; r++) {
    let i = r;
    while (Math.abs(a[i][lead]) < 1e-12) {
      if (++i === a.length) {
        i = r;
        if (++lead === a[0].length) return a;
      }
    }
    [a[i], a[r]] = [a[r], a[i]];
    const lv = a[r][lead];
    a[r] = a[r].map((x) => x / lv);
    for (let k = 0; k < a.length; k++) if (k !== r) a[k] = a[k].map((x, j) => x - a[k][lead] * a[r][j]);
    lead++;
  }
  return a;
}
const mclose = (A, B, tol = 1e-8) => A && B && A.length === B.length && A.every((row, i) => row.length === B[i].length && row.every((x, j) => close(x, B[i][j], tol)));
await family("matrices", async () => {
  const n = int(2, 3);
  const M = Array.from({ length: n }, () => Array.from({ length: n }, () => int(-5, 5)));
  const N2 = Array.from({ length: n }, () => Array.from({ length: n }, () => int(-5, 5)));
  const which = pick(["det", "inv", "mul", "transpose", "rref", "pow", "add", "solve"]);
  const input = {
    det: `det(${matText(M)})`, inv: `${matText(M)}^(-1)`, mul: `${matText(M)}*${matText(N2)}`, transpose: `${matText(M)}ᵀ`,
    rref: `rref(${matText(M)})`, pow: `${matText(M)}^3`, add: `${matText(M)}+${matText(N2)}`, solve: `${matText(M)}^(-1)*${matText(N2.map((r) => [r[0]]))}`,
  }[which];
  const d = detJS(M);
  const r = await run(input);
  if ((which === "inv" || which === "solve") && d === 0) {
    if (r.ok) fail("matrices", input, out(r), "singular: want an error");
    return input;
  }
  if (!r.ok) return fail("matrices", input, out(r), "error"), input;
  let want;
  if (which === "det") {
    if (!close(num(r.output), d, 1e-9)) fail("matrices", input, out(r), `want ${d}`);
    return input;
  }
  const got = matOf(r.output);
  if (which === "inv") want = null;
  if (which === "inv") {
    if (!mclose(mmul(M, got ?? [[NaN]]), M.map((row, i) => row.map((_, j) => (i === j ? 1 : 0))))) fail("matrices", input, out(r), "M·M⁻¹ isn't I");
    return input;
  }
  if (which === "solve") {
    const b = N2.map((row) => [row[0]]);
    if (!mclose(mmul(M, got ?? [[NaN]]), b)) fail("matrices", input, out(r), "M·x isn't b");
    return input;
  }
  want = { mul: mmul(M, N2), transpose: M[0].map((_, j) => M.map((row) => row[j])), rref: rrefJS(M), pow: mmul(mmul(M, M), M), add: M.map((row, i) => row.map((v, j) => v + N2[i][j])) }[which];
  if (!mclose(got, want)) fail("matrices", input, out(r), `want ${JSON.stringify(want)}`);
  return input;
});

// ------------------------------------------------------------ probability, more
function tcdf(t, df) {
  const dens = (x) => Math.exp(lgamma((df + 1) / 2) - lgamma(df / 2) - 0.5 * Math.log(df * Math.PI) - ((df + 1) / 2) * Math.log(1 + (x * x) / df));
  return 0.5 + Math.sign(t) * simpson(dens, 0, Math.abs(t), 20000);
}
function lgamma(z) {
  // Lanczos
  const g = 7;
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * z))) - lgamma(1 - z);
  z -= 1;
  let x = c[0];
  for (let i = 1; i < g + 2; i++) x += c[i] / (z + i);
  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}
await family("probability", async () => {
  const kind = pick(["invBinom", "geomPdf", "geomCdf", "poissPdf", "normPdf", "binomPdf-list", "tCdf", "invt", "binomCdf-upper", "nCr", "nPr"]);
  let input;
  let want;
  let tol = 5e-6;
  const [n, p] = [int(2, 30), int(1, 9) / 10];
  if (kind === "invBinom") {
    const q = int(1, 99) / 100;
    input = `invBinom(${q},${n},${p})`;
    let cdf = 0;
    want = n;
    for (let k = 0; k <= n; k++) {
      cdf += choose(n, k) * p ** k * (1 - p) ** (n - k);
      if (cdf >= q - 1e-12) {
        want = k;
        break;
      }
    }
    tol = 0;
  } else if (kind === "geomPdf") {
    const k = int(1, 10);
    input = `geomPdf(${p},${k})`;
    want = (1 - p) ** (k - 1) * p;
  } else if (kind === "geomCdf") {
    const [lo, hi] = [int(1, 4), int(4, 12)];
    input = `geomCdf(${p},${lo},${hi})`;
    want = (1 - p) ** (lo - 1) - (1 - p) ** hi;
  } else if (kind === "poissPdf") {
    const [lam, k] = [int(1, 9), int(0, 12)];
    input = `poissPdf(${lam},${k})`;
    want = Math.exp(-lam + k * Math.log(lam) - lgamma(k + 1));
  } else if (kind === "normPdf") {
    const [x, mu, sd] = [int(-5, 15), int(-3, 10), int(1, 5)];
    input = `normPdf(${x},${mu},${sd})`;
    want = Math.exp(-(((x - mu) / sd) ** 2) / 2) / (sd * Math.sqrt(2 * Math.PI));
  } else if (kind === "binomPdf-list") {
    const m = int(2, 8);
    input = `sum(binomPdf(${m},${p}))`;
    want = 1;
  } else if (kind === "tCdf") {
    const [lo, hi, df] = [-int(0, 3) - 0.5, int(0, 3) + 0.25, int(2, 30)];
    input = `tCdf(${lo},${hi},${df})`;
    want = tcdf(hi, df) - tcdf(lo, df);
    tol = 1e-5;
  } else if (kind === "invt") {
    const [q, df] = [int(5, 95) / 100, int(2, 30)];
    input = `invt(${q},${df})`;
    const r = await run(input);
    if (!r.ok) return fail("probability", input, out(r), "error"), input;
    if (!close(tcdf(num(r.output), df), q, 1e-4)) fail("probability", input, out(r), `t-cdf of the answer is ${tcdf(num(r.output), df)}`);
    return input;
  } else if (kind === "binomCdf-upper") {
    const k = int(0, n);
    input = `binomCdf(${n},${p},${k},${n})`;
    want = 0;
    for (let i = k; i <= n; i++) want += choose(n, i) * p ** i * (1 - p) ** (n - i);
  } else {
    const k = int(0, Math.min(n, 10));
    input = kind === "nCr" ? `nCr(${n},${k})` : `nPr(${n},${k})`;
    want = kind === "nCr" ? choose(n, k) : Array.from({ length: k }, (_, j) => n - j).reduce((a, b) => a * b, 1);
    tol = 1e-12;
  }
  const r = await run(input);
  if (!r.ok) return fail("probability", input, out(r), "error"), input;
  const got = num(r.output);
  if (tol === 0 ? got !== want : !close(got, want, tol)) fail("probability", input, out(r), `want ${want}`);
  return input;
});

// ------------------------------------------------------------ statistics
const statRows = (a) => {
  const m = new Map();
  if (a.k !== "mat") return m;
  for (const [l, v] of a.rows) if (l.k === "str") m.set(l.v, v.k === "list" ? v.items.map((x) => num(x)) : num(v));
  return m;
};
function quartiles(s) {
  const med = (v) => (v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2);
  const n = s.length;
  return [med(s.slice(0, Math.floor(n / 2))), med(s), med(s.slice(Math.ceil(n / 2)))];
}
function lsq(X, Y) {
  const n = X.length;
  const mx = X.reduce((a, b) => a + b, 0) / n;
  const my = Y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (X[i] - mx) * (Y[i] - my);
    sxx += (X[i] - mx) ** 2;
    syy += (Y[i] - my) ** 2;
  }
  return { m: sxy / sxx, b: my - (sxy / sxx) * mx, r: sxy / Math.sqrt(sxx * syy) };
}
await family("statistics", async () => {
  const n = int(4, 12);
  const xs = Array.from({ length: n }, () => int(-10, 40) / pick([1, 1, 2, 10]));
  const fq = Array.from({ length: n }, () => int(1, 4));
  const useF = rand() < 0.4;
  const data = useF ? xs.flatMap((x, i) => Array(fq[i]).fill(x)) : xs;
  const L = `{${xs.join(",")}}`;
  const F = `{${fq.join(",")}}`;
  const mean = data.reduce((a, b) => a + b, 0) / data.length;
  const ss = data.reduce((a, b) => a + (b - mean) ** 2, 0);
  const sorted = [...data].sort((a, b) => a - b);
  const kind = pick(["mean", "median", "stDevSamp", "stDevPop", "varSamp", "OneVar", "TwoVar", "LinRegMx", "QuadReg", "ExpReg", "PowerReg", "LnReg", "sortA", "max"]);
  let input;
  if (["mean", "median", "stDevSamp", "stDevPop", "varSamp"].includes(kind)) {
    input = `${kind}(${L}${useF ? `,${F}` : ""})`;
    const want = {
      mean, median: quartiles(sorted)[1], stDevSamp: Math.sqrt(ss / (data.length - 1)), stDevPop: Math.sqrt(ss / data.length), varSamp: ss / (data.length - 1),
    }[kind];
    if (kind === "median" && useF) input = `median(${L},${F})`;
    const r = await run(input);
    if (!r.ok) return fail("statistics", input, out(r), "error"), input;
    if (!close(num(r.output), want, shownTol(r, 1e-6))) fail("statistics", input, out(r), `want ${want}`);
    return input;
  }
  if (kind === "sortA" || kind === "max") {
    input = kind === "max" ? `max(${L})` : `SortA ${L}`;
    if (kind === "sortA") return input;
    const r = await run(input);
    if (!r.ok || !close(num(r.output), Math.max(...xs), 1e-12)) fail("statistics", input, out(r), `want ${Math.max(...xs)}`);
    return input;
  }
  if (kind === "OneVar") {
    input = `OneVar ${L}${useF ? `,${F}` : ""}`;
    const r = await run(input);
    if (!r.ok) return fail("statistics", input, out(r), "error"), input;
    const m = statRows(r.output);
    const [q1, med, q3] = quartiles(sorted);
    const want = { "x̄": mean, "Σx": mean * data.length, "Σx²": data.reduce((a, b) => a + b * b, 0), "sx := sₙ₋₁x": Math.sqrt(ss / (data.length - 1)), "σx := σₙx": Math.sqrt(ss / data.length), n: data.length, MinX: sorted[0], "Q₁X": q1, MedianX: med, "Q₃X": q3, MaxX: sorted.at(-1), "SSX := Σ(x-x̄)²": ss };
    for (const [k, v] of Object.entries(want)) if (!close(m.get(k), v, 1e-5)) fail("statistics", input, `${k} = ${m.get(k)}`, `want ${v}`);
    return input;
  }
  // Paired data for TwoVar and the regressions: positive where logs are needed.
  const X = Array.from({ length: n }, (_, i) => i + 1 + int(0, 2) / 2);
  const Y = X.map((x) => Math.round((pick([2, 3]) * x + int(1, 6) + rand()) * 10) / 10);
  const XL = `{${X.join(",")}}`;
  const YL = `{${Y.join(",")}}`;
  input = kind === "TwoVar" ? `TwoVar ${XL},${YL}` : `${kind} ${XL},${YL}`;
  const r = await run(input);
  if (!r.ok) return fail("statistics", input, out(r), "error"), input;
  const m = statRows(r.output);
  const check = (k, v) => {
    if (!close(m.get(k), v, 1e-5)) fail("statistics", input, `${k} = ${m.get(k)}`, `want ${v}`);
  };
  if (kind === "TwoVar") {
    const f = lsq(X, Y);
    check("r", f.r);
    check("Σxy", X.reduce((a, x, i) => a + x * Y[i], 0));
    check("ȳ", Y.reduce((a, b) => a + b, 0) / n);
  } else if (kind === "LinRegMx") {
    const f = lsq(X, Y);
    check("m", f.m);
    check("b", f.b);
    check("r", f.r);
    check("r²", f.r ** 2);
  } else if (kind === "ExpReg") {
    const f = lsq(X, Y.map(Math.log));
    check("a", Math.exp(f.b));
    check("b", Math.exp(f.m));
    check("r", f.r);
  } else if (kind === "PowerReg") {
    const f = lsq(X.map(Math.log), Y.map(Math.log));
    check("a", Math.exp(f.b));
    check("b", f.m);
  } else if (kind === "LnReg") {
    const f = lsq(X.map(Math.log), Y);
    check("a", f.b);
    check("b", f.m);
  } else {
    // QuadReg against the normal equations, solved here by Cramer's rule.
    const S = (p) => X.reduce((s, x) => s + x ** p, 0);
    const T = (p) => X.reduce((s, x, i) => s + x ** p * Y[i], 0);
    const A = [[S(4), S(3), S(2)], [S(3), S(2), S(1)], [S(2), S(1), n]];
    const v = [T(2), T(1), T(0)];
    const D = detJS(A);
    const col = (k) => detJS(A.map((row, i) => row.map((x, j) => (j === k ? v[i] : x)))) / D;
    check("a", col(0));
    check("b", col(1));
    check("c", col(2));
  }
  return input;
});

// ------------------------------------------------------------ finance
await family("finance", async () => {
  const ppy = pick([1, 4, 12, 26, 52]);
  // Terms up to 40 years, as loans and investments run.
  const t = { n: int(2, 40 * ppy), i: int(1, 120) / 10, pv: int(1, 500) * 1000, pmt: 0, fv: 0, ppy, cpy: 0, begin: rand() < 0.3 };
  t.cpy = rand() < 0.7 ? t.ppy : pick([1, 2, 4, 12, 365]);
  t.fv = rand() < 0.5 ? 0 : -int(0, 200) * 1000;
  t.pmt = solveTvm(t, "pmt");
  // Interest only (FV = −PV): any N fits, so N isn't recoverable.
  if (t.fv === -t.pv) t.fv = 0, (t.pmt = solveTvm(t, "pmt"));
  // Independent check: the balance, from first principles.
  const bal = (u) => {
    const r = (1 + u.i / 100 / u.cpy) ** (u.cpy / u.ppy) - 1;
    let s = u.pv;
    for (let k = 1; k <= Math.round(u.n); k++) s = s * (1 + r) + u.pmt * (u.begin ? 1 + r : 1);
    // Fractional N isn't used here.
    return s + u.fv;
  };
  const input = `N=${t.n} I=${t.i} PV=${t.pv} FV=${t.fv} PpY=${t.ppy} CpY=${t.cpy}${t.begin ? " Begin" : ""}`;
  current = input;
  if (!Number.isFinite(t.pmt) || Math.abs(bal(t)) > 1e-6 * t.pv * (1 + t.i)) fail("finance", input, `Pmt=${t.pmt}`, `balance after N payments is ${bal(t)}`);
  for (const field of ["n", "i", "pv", "fv"]) {
    const back = solveTvm({ ...t, [field]: field === "n" ? 1 : 0 }, field);
    if (!close(back, t[field], 1e-6)) fail("finance", input, `${field}=${back}`, `want ${t[field]}`);
  }
  return input;
});

// ------------------------------------------------------------ workflows
// Several entries in a row, as students use the calculator: stored values,
// redefinitions, list elements, DelVar, functions of functions.
await family("workflow", async () => {
  let F = fn();
  while (/abs/.test(F)) F = fn();
  const G = fn();
  const k = pick([0.5, 1, 2, 3]);
  const log = [];
  const step = async (text, want) => {
    const r = await run(text);
    log.push(`${text} → ${out(r)}`);
    if (want === undefined) return r;
    if (!r.ok) return fail("workflow", log.join(" ; "), out(r), `step "${text}" errored`), r;
    const got = typeof want === "number" ? num(r.output) : r.outputText;
    if (typeof want === "number" ? !(Number.isFinite(want) ? close(got, want, shownTol(r, 1e-6)) : true) : got !== want) fail("workflow", log.join(" ; "), out(r), `step "${text}": want ${want}`);
    return r;
  };
  await step(`Define f(x)=${F}`, "Done");
  await step(`${k}→a`);
  await step("f(a)", f(F, k));
  await step("DelVar a", "Done");
  const sym = await step("f(a)");
  const constant = close(f(F, 0.3), f(F, 1.7), 1e-12) && close(f(F, 0.3), f(F, 2.9), 1e-12);
  if (sym.ok && !constant && Number.isFinite(num(sym.output))) fail("workflow", log.join(" ; "), out(sym), "a was deleted: f(a) should stay symbolic");
  await step(`Define g(x)=d(f(x),x)`, "Done");
  await step(`g(${k})`, (f(F, k + 1e-6) - f(F, k - 1e-6)) / 2e-6);
  await step(`Define f(x)=${G}`, "Done");
  await step(`f(${k})`, f(G, k));
  await step(`{1,2,3}→l`);
  await step(`f(l[2])`, f(G, 2));
  await step(`sum(l^2)`, 14);
  await step(`2+3`);
  await step(`Ans*2`, 10);
  await step(`DelVar l`, "Done");
  return log.join(" ; ");
});

// Approximate mode: exact inputs come back as decimals of the same value.
await family("approx", async () => {
  const input = pick([`√(${int(2, 50)})+${int(-5, 5)}`, `π/${nz(1, 12)}`, `ln(${int(2, 40)})`, `sin(${nz(-5, 5)})`, `ℯ^(${nz(-3, 3)})`, `${nz(-9, 9)}/${nz(1, 13)}`, `cos(π/${nz(1, 9)})`, `tan⁻¹(${nz(-5, 5)})`, `${int(2, 9)}^(1/${int(2, 5)})`]);
  const r = await runIn({ ...DEFAULT_SETTINGS, mode: "approx" }, input);
  if (!r.ok) return fail("approx", input, out(r), "error"), input;
  if (!/\./.test(r.outputText)) fail("approx", input, out(r), "not a decimal");
  if (!close(num(r.output), num(parse(input)), 5e-6)) fail("approx", input, out(r), `want ${num(parse(input))}`);
  return input;
});

// Graphs: plotted samples, relation grids and parametric points are the function's values.
await family("graph-samples", async () => {
  const F = fn();
  await run(`Define f1(x)=${F}`);
  const w = { xmin: -10, xmax: 10, ymin: -6.67, ymax: 6.67 };
  const s = await sample(giac, "f1", 1, w, 80);
  for (let k = 0; k < s.xs.length; k += 7) {
    const want = f(F, s.xs[k]);
    if (Number.isFinite(want) && !close(s.ys[k], want, 1e-9)) return fail("graph-samples", `f1(x)=${F}`, `y(${s.xs[k]})=${s.ys[k]}`, `want ${want}`), F;
    if (!Number.isFinite(want) && Number.isFinite(s.ys[k])) return fail("graph-samples", `f1(x)=${F}`, `y(${s.xs[k]})=${s.ys[k]}`, "should be no point"), F;
  }
  const [a, b] = [nz(1, 4), nz(1, 4)];
  await giac(`rel1_(x,y):=(x^2/${a * a}+y^2/${b * b})-(1)`);
  const g = await sampleGrid(giac, "rel1_", 1, w, 20, 16);
  for (let j = 0; j <= 16; j += 4)
    for (let i = 0; i <= 20; i += 5) {
      const [x, y] = [w.xmin + (i * (w.xmax - w.xmin)) / 20, w.ymin + (j * (w.ymax - w.ymin)) / 16];
      if (!close(g.vals[j][i], (x * x) / (a * a) + (y * y) / (b * b) - 1, 1e-9)) return fail("graph-samples", `ellipse ${a},${b}`, `grid (${x},${y}) = ${g.vals[j][i]}`, "wrong value"), F;
    }
  await giac(`xp_(t):=${a}*cos(t)`);
  await giac(`yp_(t):=${b}*sin(t)`);
  const ps = await sampleParametric(giac, ["xp_", "yp_"], { n: 1, tmin: 0, tmax: 6.28, tstep: 0.13 });
  for (const [k, pt] of ps.pts.entries())
    if (!close(pt[0], a * Math.cos(k * 0.13), 1e-9) || !close(pt[1], b * Math.sin(k * 0.13), 1e-9)) return fail("graph-samples", "parametric", `${pt}`, "wrong point"), F;
  return F;
});

// solve(f(x)>k,x): the answer's intervals are where f−k has that sign.
/** True if x meets an answer such as "x<−2 or x>2", "−2≤x≤3", "x≠1", true/false. */
function meets(a, x) {
  switch (a.k) {
    case "sym":
      return a.name === "true" ? true : a.name === "false" ? false : NaN;
    case "bin": {
      if (a.op === "or") return meets(a.a, x) || meets(a.b, x);
      if (a.op === "and") return meets(a.a, x) && meets(a.b, x);
      const REL = { "<": (p, q) => p < q, ">": (p, q) => p > q, "≤": (p, q) => p <= q, "≥": (p, q) => p >= q, "≠": (p, q) => p !== q, "=": (p, q) => Math.abs(p - q) < 1e-9 };
      if (!REL[a.op]) return NaN;
      if (a.a.k === "bin" && REL[a.a.op]) return meets(a.a, x) && REL[a.op](num(a.a.b, { x }), num(a.b, { x }));
      return REL[a.op](num(a.a, { x }), num(a.b, { x }));
    }
    default:
      return NaN;
  }
}
await family("inequality", async () => {
  const F = pick([fn, () => `(x${sg(nz(-4, 4))})*(x${sg(nz(-4, 4))})`, () => `x^3${sg(nz(-5, 5))}*x`, () => `(x${sg(nz(-3, 3))})/(x${sg(nz(-3, 3))})`])();
  const k = int(-3, 3);
  const op = pick([">", "<", "≥", "≤"]);
  // Sometimes a second relation (k ≤ f < k2) or a domain, as exam questions have them.
  const k2 = k + int(1, 4);
  const both = rand() < 0.3;
  const [dlo, dhi] = rand() < 0.4 ? [int(-6, 0), int(1, 6)] : [-Infinity, Infinity];
  const body = both ? `${F}${op}${k} and ${F}<${k2}` : `${F}${op}${k}`;
  const input = `solve(${body},x)${Number.isFinite(dlo) ? `|${dlo}≤x≤${dhi}` : ""}`;
  if (/sin|cos|tan/.test(F) && !Number.isFinite(dlo)) return input;
  const r = await run(input);
  if (!r.ok) return fail("inequality", input, out(r), "error"), input;
  const test1 = { ">": (v) => v > 0, "<": (v) => v < 0, "≥": (v) => v >= 0, "≤": (v) => v <= 0 }[op];
  const test = (v, x) => test1(v) && (!both || f(F, x) < k2) && x >= dlo && x <= dhi;
  for (let j = 0; j <= 400; j++) {
    const x = -10 + j * 0.05 + 0.0123;
    const v = f(F, x) - k;
    if (!Number.isFinite(v) || Math.abs(v) < 1e-6 || (both && Math.abs(f(F, x) - k2) < 1e-6)) continue;
    const m = meets(r.output, x);
    if (Number.isNaN(m)) return fail("inequality", input, out(r), "answer not readable as intervals"), input;
    if (m !== test(v, x)) return fail("inequality", input, out(r), `at x=${x.toFixed(4)}: f−k=${v.toFixed(5)}, answer says ${m}`), input;
  }
  return input;
});

// Exact values: trig at π/12-type angles, inverse trig, logs, roots and their sums and products.
await family("exact-values", async () => {
  const ang = () => pick(["π/12", "5*π/12", "7*π/12", "11*π/12", "π/8", "3*π/8", "π/5", "2*π/5", "π/6", "π/4", "π/3", "2*π/3", "5*π/6", "-π/12", "13*π/12"]);
  const term = () => pick([
    () => `${pick(["sin", "cos", "tan"])}(${ang()})`, () => `√(${int(2, 30)})`, () => `ln(${int(2, 30)})`, () => `${pick(["sin⁻¹", "cos⁻¹", "tan⁻¹"])}(${pick(["1/2", "-1/2", "√(3)/2", "1", "√(2)/2", "-√(3)/2", "0"])})`,
    () => `ℯ^(${nz(-3, 3)})`, () => `${int(2, 9)}^(1/${int(2, 4)})`, () => `log(${int(2, 99)},${int(2, 10)})`, () => `${nz(-9, 9)}/${nz(1, 12)}`,
  ])();
  const input = pick([() => term(), () => `${term()}+${term()}`, () => `${term()}*${term()}`, () => `${term()}/(${term()})`, () => `(${term()})^2`, () => `${term()}-${term()}*${term()}`])();
  const want = num(parse(input));
  if (!Number.isFinite(want)) return input;
  const r = await run(input);
  if (!r.ok) return fail("exact-values", input, out(r), "error"), input;
  const got = num(r.output);
  if (!close(got, want, shownTol(r, 1e-9))) fail("exact-values", input, out(r), `value ${got}, want ${want}`);
  return input;
});

// Answers with a parameter: checked at sample values of k.
await family("parameters", async () => {
  const which = pick(["solve-quad", "solve-lin", "d", "int", "def-int", "tangent"]);
  const ks = [0.7, 1.9, 3.3];
  let input;
  let check;
  if (which === "solve-quad") {
    input = `solve(k*x^2${sg(nz(-5, 5))}*x${sg(nz(-4, 4))}=0,x)`;
    const P = input.slice(6, input.indexOf("=0"));
    check = (r) => {
      for (const k of ks) {
        const xs = [];
        const walk = (a) => {
          if (a.k === "bin" && a.op === "or") (walk(a.a), walk(a.b));
          else if (a.k === "bin" && a.op === "=") xs.push(num(a.b, { k }));
        };
        walk(r.output);
        const real = xs.filter(Number.isFinite);
        for (const x of real) if (!close(f(P, x, { k }), 0, 1e-8)) return `k=${k}: x=${x} gives ${f(P, x, { k })}`;
        if (roots((x) => f(P, x, { k }), -50, 50).some((x) => !real.some((y) => Math.abs(y - x) < 1e-4))) return `k=${k}: a root is missing`;
      }
      return null;
    };
  } else if (which === "solve-lin") {
    input = `solve(${nz(-4, 4)}*k*x${sg(nz(-5, 5))}=${int(-5, 5)}*x+k,x)`;
    const [L, R] = input.slice(6, input.lastIndexOf(",")).split("=");
    check = (r) => {
      for (const k of ks) {
        const ans = r.output.k === "bin" && r.output.op === "=" ? num(r.output.b, { k }) : NaN;
        if (!close(f(L, ans, { k }), f(R, ans, { k }), 1e-8)) return `k=${k}: x=${ans} doesn't solve it`;
      }
      return null;
    };
  } else if (which === "d" || which === "int" || which === "def-int" || which === "tangent") {
    const F = pick([`k*x^${int(2, 4)}`, `ℯ^(k*x)`, `sin(k*x)`, `x*ℯ^(-k*x)`, `ln(k*x+1)`, `k/(x+k)`, `√(k*x+1)`]);
    input = which === "d" ? `d(${F},x)` : which === "int" ? `∫(${F},x)` : which === "def-int" ? `∫(${F},x,0,1)` : `tangentLine(${F},x,1)`;
    check = (r) => {
      for (const k of ks) {
        const g = (x) => f(F, x, { k });
        const d = (h, x) => (h(x + 1e-6) - h(x - 1e-6)) / 2e-6;
        const R = (x) => num(r.output, { k, x });
        if (which === "d" && !close(R(0.6), d(g, 0.6), 1e-5)) return `k=${k}: ${R(0.6)} vs ${d(g, 0.6)}`;
        if (which === "int" && !close(d(R, 0.6), g(0.6), 1e-5)) return `k=${k}: derivative ${d(R, 0.6)} vs ${g(0.6)}`;
        if (which === "def-int" && !close(R(0), simpson(g, 0, 1), 1e-6)) return `k=${k}: ${R(0)} vs ${simpson(g, 0, 1)}`;
        if (which === "tangent" && (!close(R(1), g(1), 1e-6) || !close(R(2) - R(1), d(g, 1), 1e-5))) return `k=${k}: not the tangent`;
      }
      return null;
    };
  }
  const r = await run(input);
  if (!r.ok) return fail("parameters", input, out(r), "error"), input;
  const why = check(r);
  if (why) fail("parameters", input, out(r), why);
  return input;
});

// Second-order deSolve with conditions.
await family("desolve2", async () => {
  const [p, q] = pick([[0, 1], [0, 4], [2, 1], [3, 2], [-1, -2], [0, -1], [1, 0], [0, 9]]);
  const rhs = pick(["0", "x", "1", "ℯ^(x)", "sin(x)"]);
  const [y0, y1] = [int(-3, 3), int(-3, 3)];
  const input = `deSolve(y''${sg(p)}*y'${sg(q)}*y=${rhs} and y(0)=${y0} and y'(0)=${y1},x,y)`;
  const r = await run(input);
  if (!r.ok) return fail("desolve2", input, out(r), "error"), input;
  const m = /^y=(.*)$/.exec(r.outputText);
  if (!m) return fail("desolve2", input, out(r), "not y=…"), input;
  const Y = (x) => f(m[1], x);
  const R = (x) => f(rhs, x);
  const h = 1e-4;
  if (!close(Y(0), y0, 1e-6)) return fail("desolve2", input, out(r), `y(0)=${Y(0)}`), input;
  if (!close((Y(h) - Y(-h)) / (2 * h), y1, 1e-5)) return fail("desolve2", input, out(r), `y'(0)=${(Y(h) - Y(-h)) / (2 * h)}`), input;
  for (const x of [0.4, 1.1]) {
    const d2 = (Y(x + h) - 2 * Y(x) + Y(x - h)) / (h * h);
    const d1 = (Y(x + h) - Y(x - h)) / (2 * h);
    if (!close(d2 + p * d1 + q * Y(x), R(x), 1e-4)) return fail("desolve2", input, out(r), `residual at ${x}: ${d2 + p * d1 + q * Y(x) - R(x)}`), input;
  }
  return input;
});

// Non-linear systems: every pair solves both equations, none missing (by a grid search).
await family("systems2", async () => {
  const [a, b, c] = [nz(-3, 3), int(-4, 4), int(1, 25)];
  const [E1, E2] = pick([
    [`x^2+y^2=${c}`, `y=${a}*x${sg(b)}`],
    [`y=x^2${sg(b)}`, `y=${a}*x${sg(int(-3, 3))}`],
    [`x*y=${nz(-6, 6)}`, `x+y=${b}`],
    [`y=ℯ^x`, `y=${a}*x+${Math.abs(b) + 2}`],
  ]);
  const input = `solve(${E1} and ${E2},{x,y})`;
  const r = await run(input);
  if (!r.ok) return fail("systems2", input, out(r), "error"), input;
  const res = (e, x, y) => {
    const [L, R] = e.split("=");
    return f(L, x, { y }) - f(R, x, { y });
  };
  const sols = [];
  const walk = (t) => {
    if (t.k === "bin" && t.op === "or") (walk(t.a), walk(t.b));
    else if (t.k === "bin" && t.op === "and" && t.a.k === "bin" && t.a.op === "=" && t.b.k === "bin" && t.b.op === "=") sols.push([num(t.a.b), num(t.b.b)]);
    else if (!(t.k === "sym" && t.name === "false")) sols.push([NaN, NaN]);
  };
  walk(r.output);
  for (const [x, y] of sols) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (Math.abs(res(E1, x, y)) > 1e-4 * Math.max(1, Math.abs(x), Math.abs(y)) || Math.abs(res(E2, x, y)) > 1e-4 * Math.max(1, Math.abs(x), Math.abs(y))) fail("systems2", input, out(r), `(${x}, ${y}) doesn't solve both`);
  }
  // Real solutions by eliminating y with E2 (all E2 forms give y in terms of x, or x+y=b).
  const yOf = E2.startsWith("x+y") ? (x) => b - x : (x) => f(E2.split("=")[1], x);
  for (const x of roots((x) => res(E1, x, yOf(x)), -20, 20)) if (!sols.some(([sx]) => Math.abs(sx - x) < 1e-3)) fail("systems2", input, out(r), `missing x≈${x.toFixed(5)}`);
  return input;
});

// Integers and rounding.
await family("number", async () => {
  const [a, b] = [int(-200, 200), nz(-30, 30)];
  const x = int(-999, 999) / 100;
  const which = pick(["mod", "remain", "gcd", "lcm", "floor", "ceiling", "round", "iPart", "fPart", "abs", "isPrime", "factorial", "round-list"]);
  if (which === "round-list") {
    const xs = Array.from({ length: int(2, 5) }, () => int(-9999, 9999) / 1000);
    const d = int(0, 2);
    const asMatrix = rand() < 0.5 && xs.length >= 4;
    const input = asMatrix ? `round([[${xs[0]},${xs[1]}][${xs[2]},${xs[3]}]],${d})` : `round({${xs.join(",")}},${d})`;
    const r = await run(input);
    const want = (asMatrix ? xs.slice(0, 4) : xs).map((x) => (Math.sign(x) * Math.round(Math.abs(x) * 10 ** d + 1e-9)) / 10 ** d);
    const got = r.ok ? (r.output.k === "mat" ? r.output.rows.flat() : r.output.k === "list" ? r.output.items : []).map((v) => num(v)) : [];
    if (!r.ok || got.length !== want.length || got.some((g, k) => !close(g, want[k], 1e-12))) fail("number", input, out(r), `want ${want}`);
    return input;
  }
  const gcd = (p, q) => (q ? gcd(q, p % q) : Math.abs(p));
  const [input, want] = {
    mod: [`mod(${a},${b})`, a - b * Math.floor(a / b)],
    remain: [`remain(${a},${b})`, a - b * Math.trunc(a / b)],
    gcd: [`gcd(${a},${b})`, gcd(a, b)],
    lcm: [`lcm(${a || 1},${b})`, Math.abs(((a || 1) * b) / gcd(a || 1, b))],
    floor: [`floor(${x})`, Math.floor(x)],
    ceiling: [`ceiling(${x})`, Math.ceil(x)],
    round: [`round(${x},1)`, Math.sign(x) * Math.round(Math.abs(x) * 10 + 1e-9) / 10],
    iPart: [`iPart(${x})`, Math.trunc(x)],
    fPart: [`fPart(${x})`, x - Math.trunc(x)],
    abs: [`abs(${a})`, Math.abs(a)],
    isPrime: [`isPrime(${Math.abs(a) + 2})`, (() => { const n = Math.abs(a) + 2; for (let d = 2; d * d <= n; d++) if (n % d === 0) return 0; return 1; })()],
    factorial: [`${int(0, 15)}!`, 0],
  }[which];
  const r = await run(input);
  if (!r.ok) return fail("number", input, out(r), "error"), input;
  if (which === "isPrime") {
    if (r.outputText !== (want ? "true" : "false")) fail("number", input, out(r), `want ${want ? "true" : "false"}`);
    return input;
  }
  if (which === "factorial") {
    const n = Number(input.slice(0, -1));
    let fct = 1;
    for (let k = 2; k <= n; k++) fct *= k;
    if (num(r.output) !== fct) fail("number", input, out(r), `want ${fct}`);
    return input;
  }
  if (!close(num(r.output), want, 1e-9)) fail("number", input, out(r), `want ${want}`);
  return input;
});

// Piecewise functions: values on each piece, d and ∫ across the break.
await family("piecewise", async () => {
  const [c, a, b] = [int(-2, 2), nz(-3, 3), int(-4, 4)];
  const P1 = `${a}*x^2${sg(b)}`;
  const P2 = `${nz(-3, 3)}*x${sg(int(-4, 4))}`;
  await run(`Define h(x)=piecewise(${P1},x<${c},${P2},x≥${c})`);
  const H = (x) => (x < c ? f(P1, x) : f(P2, x));
  for (const x of [c - 1.3, c - 0.2, c, c + 0.7, c + 2]) {
    const r = await run(`h(${x})`);
    if (!r.ok || !close(num(r.output), H(x), shownTol(r, 1e-9))) return fail("piecewise", `h(x)=piecewise(${P1},x<${c},${P2},x≥${c}): h(${x})`, out(r), `want ${H(x)}`), P1;
  }
  const r = await run(`∫(h(x),x,${c - 2},${c + 2})`);
  // Each piece on its own side, so the break point doesn't count the wrong piece.
  const want = simpson((x) => f(P1, x), c - 2, c, 2000) + simpson((x) => f(P2, x), c, c + 2, 2000);
  if (!r.ok || !close(num(r.output), want, 1e-6)) fail("piecewise", `∫ of h across x=${c}`, out(r), `want ${want}`);
  return P1;
});

// Settings and corners: Degree-mode calculus, Polar and Exact display, the
// 1-Prop z Interval, functions of two arguments, graph trace values.
await family("settings-more", async () => {
  const which = pick(["deg-d", "deg-int", "polar", "exact", "zint", "two-args", "trace"]);
  const toR = Math.PI / 180;
  if (which === "deg-d" || which === "deg-int") {
    const [a, x0] = [nz(1, 4), int(10, 80)];
    const t = pick(["sin", "cos"]);
    const input = which === "deg-d" ? `d(${t}(${a}*x),x)|x=${x0}` : `∫(${t}(${a}*x),x,0,${x0})`;
    const want =
      which === "deg-d"
        ? (t === "sin" ? Math.cos(a * x0 * toR) : -Math.sin(a * x0 * toR)) * a * toR
        : t === "sin" ? (1 - Math.cos(a * x0 * toR)) / (a * toR) : Math.sin(a * x0 * toR) / (a * toR);
    const r = await runIn({ ...DEFAULT_SETTINGS, angle: "deg" }, input);
    if (!r.ok) return fail("settings-more", input, out(r), "error"), input;
    DEG = true;
    const got = num(r.output);
    DEG = false;
    if (!close(got, want, shownTol(r, 1e-8))) fail("settings-more", `${input} (Degree)`, out(r), `want ${want}`);
    return input;
  }
  if (which === "polar") {
    const z = cplx();
    const r = await runIn({ ...DEFAULT_SETTINGS, complex: "polar" }, `${z}*${cplx()}`);
    const input = current;
    if (!r.ok) return fail("settings-more", input, out(r), "error"), input;
    if (!cclose(cnum(r.output), cnum(parse(input)), shownTol(r, 1e-6))) fail("settings-more", `${input} (Polar)`, out(r), `want ${cnum(parse(input))}`);
    return input;
  }
  if (which === "exact") {
    const input = pick([`0.5+1/3`, `1.25*x+0.75*x`, `√(2.)`, `0.2^2`]);
    const r = await runIn({ ...DEFAULT_SETTINGS, mode: "exact" }, input);
    if (!r.ok) return fail("settings-more", input, out(r), "error"), input;
    if (/\d\./.test(r.outputText) && input !== "√(2.)") fail("settings-more", `${input} (Exact)`, out(r), "Exact mode gave a decimal");
    if (!close(num(r.output, { x: 1.7 }), num(parse(input), { x: 1.7 }), 1e-9)) fail("settings-more", `${input} (Exact)`, out(r), "wrong value");
    return input;
  }
  if (which === "zint") {
    const [n, c] = [int(20, 500), pick([0.9, 0.95, 0.99])];
    const x = int(1, n - 1);
    const input = `zInterval_1Prop ${x},${n},${c}`;
    const r = await run(input);
    if (!r.ok) return fail("settings-more", input, out(r), "error"), input;
    const m = statRows(r.output);
    const z = { 0.9: 1.6448536269514722, 0.95: 1.959963984540054, 0.99: 2.5758293035489004 }[c];
    const p = x / n;
    const me = z * Math.sqrt((p * (1 - p)) / n);
    for (const [k, v] of [["CLower", p - me], ["CUpper", p + me], ["p̂", p], ["ME", me]]) if (!close(m.get(k), v, 1e-5)) fail("settings-more", input, `${k} = ${m.get(k)}`, `want ${v}`);
    return input;
  }
  if (which === "two-args") {
    const [a, b] = [nz(-4, 4), nz(-4, 4)];
    await run(`Define q(u,v)=u^2*v${sg(a)}*u${sg(b)}*v`);
    const [u, v] = [int(-5, 5), int(-5, 5)];
    const input = `q(${u},${v})`;
    const r = await run(input);
    const want = u * u * v + a * u + b * v;
    if (!r.ok || num(r.output) !== want) fail("settings-more", `q(u,v)=u²v${sg(a)}u${sg(b)}v: ${input}`, out(r), `want ${want}`);
    return input;
  }
  const F = fn();
  await run(`Define f1(x)=${F}`);
  const x = pick([0.3, 1.1, 2.7, -0.6]);
  const [y, m] = [await valueAt(giac, "f1", x), await slopeAt(giac, "f1", x)];
  const [wy, wm] = [f(F, x), (f(F, x + 1e-6) - f(F, x - 1e-6)) / 2e-6];
  if (Number.isFinite(wy) && !close(y, wy, 1e-9)) fail("settings-more", `trace f1(x)=${F} at ${x}`, String(y), `want ${wy}`);
  if (Number.isFinite(wm) && !/abs/.test(F) && !close(m, wm, 1e-5)) fail("settings-more", `slope f1(x)=${F} at ${x}`, String(m), `want ${wm}`);
  return F;
});

// Real commands give the same answers in Rectangular mode: solve, zeros and polyRoots stay real.
await family("modes", async () => {
  const F = pick([fn, poly])();
  const input = pick([`solve(${F}=${int(-3, 3)},x)`, `zeros(${F},x)`, `polyRoots(${poly()},x)`, `d(${F},x)`, `∫(${F},x,0,1)`, `fMin(${F},x)|-2≤x≤2`, `nSolve(${F}=0,x)`]);
  if (/sin|cos|tan/.test(F) && input.startsWith("solve")) return input;
  const real = await run(input);
  const rect = await runIn(RECT, input);
  if (crashed) return input;
  // The same values (0 and 0. are the same answer).
  const vals = (r) => (r.ok ? (r.output.k === "list" || /=/.test(r.outputText) ? answers(r.output) : [num(r.output, { x: 0.37 })]) : [r.error]);
  const [p, q] = [vals(real), vals(rect)];
  const same = p.length === q.length && p.every((v, k) => (typeof v === "string" ? v === q[k] : close(v, q[k], 1e-9) || (Number.isNaN(v) && Number.isNaN(q[k]))));
  if (!same) fail("modes", input, `Real: ${out(real)} | Rectangular: ${out(rect)}`, "differs between Real and Rectangular");
  return input;
});

// Specialist inference and Euler's method, against their formulas.
const Phi = (z) => (1 + Math.sign(z) * (2 / Math.sqrt(Math.PI)) * simpson((t) => Math.exp(-t * t), 0, Math.abs(z) / Math.SQRT2, 20000)) / 2;
await family("spec-tools", async () => {
  const which = pick(["zInterval", "zTest", "euler"]);
  if (which === "euler") {
    const [a, b, y0] = [nz(-2, 2), int(-2, 2), nz(-3, 3)];
    const h = pick([0.1, 0.2, 0.25, 0.5]);
    const n = int(2, 8);
    const input = `euler(${a}*x${sg(b)}*y,x,y,{0,${n * h}},${y0},${h})`;
    const r = await run(input);
    if (!r.ok || r.output.k !== "mat") return fail("spec-tools", input, out(r), "error"), input;
    let y = y0;
    for (let k = 1; k <= n; k++) {
      y += h * (a * (k - 1) * h + b * y);
      const got = num(r.output.rows[1][k]);
      if (!close(got, y, 1e-5)) return fail("spec-tools", input, out(r), `step ${k}: y=${got}, want ${y}`), input;
    }
    return input;
  }
  const [mu, sigma, n] = [int(5, 100), int(1, 20), int(5, 200)];
  const mean = mu + (int(-30, 30) / 10) * (sigma / Math.sqrt(n));
  const m = Math.round(mean * 100) / 100;
  if (which === "zInterval") {
    const c = pick([0.9, 0.95, 0.99]);
    const input = `zInterval ${sigma},${m},${n},${c}`;
    const r = await run(input);
    if (!r.ok) return fail("spec-tools", input, out(r), "error"), input;
    const z = { 0.9: 1.6448536269514722, 0.95: 1.959963984540054, 0.99: 2.5758293035489004 }[c];
    const me = (z * sigma) / Math.sqrt(n);
    const rows = statRows(r.output);
    for (const [k, v] of [["CLower", m - me], ["CUpper", m + me], ["ME", me]]) if (!close(rows.get(k), v, 1e-5)) fail("spec-tools", input, `${k} = ${rows.get(k)}`, `want ${v}`);
    return input;
  }
  const hyp = pick([0, -1, 1]);
  const input = `zTest ${mu},${sigma},${m},${n},${hyp}`;
  const r = await run(input);
  if (!r.ok) return fail("spec-tools", input, out(r), "error"), input;
  const z = (m - mu) / (sigma / Math.sqrt(n));
  const p = hyp < 0 ? Phi(z) : hyp > 0 ? 1 - Phi(z) : 2 * (1 - Phi(Math.abs(z)));
  const rows = statRows(r.output);
  if (!close(rows.get("z"), z, 1e-5)) fail("spec-tools", input, `z = ${rows.get("z")}`, `want ${z}`);
  if (Math.abs(rows.get("PVal") - p) > 5e-6 * Math.max(1e-3, p) + 1e-9) fail("spec-tools", input, `PVal = ${rows.get("PVal")}`, `want ${p}`);
  return input;
});

/** A random polynomial of degree 3–5 with small integer coefficients. */
function poly() {
  const d = int(3, 5);
  const terms = [`${nz(-3, 3)}*x^${d}`];
  for (let p = d - 1; p >= 0; p--) if (rand() < 0.6) terms.push(`${sg(nz(-6, 6))}${p ? `*x${p > 1 ? `^${p}` : ""}` : ""}`);
  return terms.join("");
}

// Inputs Giac's exact algebra has crashed on: higher-degree polynomials everywhere.
await family("crash-hunt", async () => {
  const P = poly();
  const Q = poly();
  const input = pick([
    `solve(${P}=0,x)`,
    `zeros(${P},x)`,
    `cSolve(${P}=0,x)`,
    `cZeros(${P},x)`,
    `polyRoots(${P},x)`,
    `cPolyRoots(${P},x)`,
    `factor(${P})`,
    `factor(${P},x)`,
    `cFactor(${P},x)`,
    `fMin(${P},x)`,
    `fMax(${P},x)|-2≤x≤2`,
    `solve(d(${P},x)=0,x)`,
    `∫(1/(${P}),x)`,
    `∫(1/(${P}),x,3,4)`,
    `expand(1/(${P}))`,
    `propFrac((${Q})/(${P}))`,
    `solve(${P}=${Q},x)|0≤x≤3`,
    `limit((${P})/(${Q}),x,∞)`,
  ]);
  const r = await run(input);
  if (crashed) fail("crash-hunt", input, crashed.error, `engine crashed on ${crashed.cmd.slice(0, 120)}`);
  else if (!r.ok && !/Non-real|Not available/.test(r.error)) fail("crash-hunt", input, out(r), "error");
  else if (r.ok && /rootof|poly1|GIAC/.test(r.outputText)) fail("crash-hunt", input, out(r), "Giac's internals in the answer");
  else if (r.ok && /^(solve|zeros)\(/.test(input) && !input.includes("|")) {
    const deriv = input.startsWith("solve(d(");
    const F = (x) => (deriv ? (f(P, x + 1e-6) - f(P, x - 1e-6)) / 2e-6 : f(P, x));
    const xs = answers(r.output);
    // Answers are shown to 6 digits: the residual allowed grows with the slope there.
    const ok = (x) => Math.abs(F(x)) <= 1e-5 * Math.max(1, Math.abs(x)) * Math.max(1, Math.abs((F(x + 1e-6) - F(x - 1e-6)) / 2e-6));
    if (xs.some(Number.isNaN)) fail("crash-hunt", input, out(r), "an answer isn't a number");
    else for (const x of xs) if (!ok(x)) fail("crash-hunt", input, out(r), `x=${x} gives ${F(x)}`);
    for (const x of roots(F, -20, 20)) if (!xs.some((g) => Math.abs(g - x) < 1e-3)) fail("crash-hunt", input, out(r), `missing x≈${x.toFixed(6)}`);
  }
  return input;
});

// ------------------------------------------------------------ report
if (crashed) console.log(`\nENGINE CRASH on ${crashed.input}\n  ${crashed.cmd.slice(0, 200)}\n  ${crashed.error}\n  (the run stopped there)`);
let total = 0;
let ok = 0;
for (const [name, c] of Object.entries(counts)) {
  console.log(`${name.padEnd(16)} ${c.ok}/${c.n}`);
  total += c.n;
  ok += c.ok;
}
console.log(`all              ${ok}/${total}`);
const byFamily = new Map();
for (const fl of failures) {
  if (!byFamily.has(fl.family)) byFamily.set(fl.family, []);
  byFamily.get(fl.family).push(fl);
}
for (const [name, list] of byFamily) {
  console.log(`\n${name}: ${list.length} problem(s)`);
  for (const fl of list.slice(0, SHOW)) console.log(`  ${fl.input}\n    → ${fl.got}\n    ${fl.why}`);
}
process.exit(0);
