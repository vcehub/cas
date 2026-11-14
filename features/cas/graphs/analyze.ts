// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 VCE Hub. Part of the /cas calculator: https://github.com/vcehub/cas
import type { Giac } from "../engine/evaluate";
import type { AnalyzeKind, GraphWindow, Mark, Samples } from "./model";

/**
 * Numbers for the Graphs page, from the engine: plot samples, a function's
 * value or slope at a point, and the Analyze Graph results. Dummy names
 * (x_, k_) keep a user's own x or k from leaking in.
 */

/** Parse a Giac list of decimals; anything non-real or undefined is NaN. */
export function parseNumbers(raw: string): number[] {
  const body = raw.trim().replace(/^\[|\]$/g, "");
  if (!body) return [];
  return body.split(",").map((s) => {
    // Giac prints a negative zero as "0.-000000000000000".
    if (/^0\.-0+$/.test(s.trim())) return 0;
    const v = s.trim().replace(/e\+?/, "e");
    return /^-?[\d.]+(e-?\d+)?$/.test(v) ? Number(v) : NaN;
  });
}

const num = (v: number) => (Number.isFinite(v) ? v.toPrecision(15) : "0");

export async function sample(giac: Giac, f: string, n: number, w: GraphWindow, count = 320): Promise<Samples> {
  const h = (w.xmax - w.xmin) / count;
  const raw = await giac(`evalf(seq(${f}(${num(w.xmin)}+k_*${num(h)}),k_,0,${count}))`);
  const ys = parseNumbers(raw);
  const xs = ys.map((_, k) => w.xmin + k * h);
  return { n, xs, ys };
}

/** A relation's left − right side over a grid: vals[j][i] at x = xmin + i·hx, y = ymin + j·hy. */
export type RelGrid = { n: number; nx: number; ny: number; w: GraphWindow; vals: number[][] };

export async function sampleGrid(giac: Giac, rel: string, n: number, w: GraphWindow, nx = 160, ny = 120): Promise<RelGrid> {
  const hx = (w.xmax - w.xmin) / nx;
  const hy = (w.ymax - w.ymin) / ny;
  const raw = await giac(
    `evalf(seq(seq(${rel}(${num(w.xmin)}+i_*${num(hx)},${num(w.ymin)}+j_*${num(hy)}),i_,0,${nx}),j_,0,${ny}))`,
  );
  // Split by rows, keeping a NaN for anything that isn't a real number (undef, complex).
  const rows = raw
    .trim()
    .replace(/^\[\[|\]\]$/g, "")
    .split("],[");
  const vals = rows.map((r) => r.split(",").map((t) => (/^[-+0-9.eE]+$/.test(t.trim()) ? Number(t) : NaN)));
  return { n, nx, ny, w, vals };
}

/** A parametric curve's points at t = tmin, tmin + tstep, … up to tmax. */
export type ParSamples = { n: number; pts: [number, number][] };

export async function sampleParametric(
  giac: Giac,
  names: [string, string],
  c: { n: number; tmin: number; tmax: number; tstep: number },
): Promise<ParSamples> {
  const count = Math.min(2000, Math.floor((c.tmax - c.tmin) / c.tstep + 1e-9));
  const raw = await giac(
    `evalf(seq([${names[0]}(${num(c.tmin)}+k_*${num(c.tstep)}),${names[1]}(${num(c.tmin)}+k_*${num(c.tstep)})],k_,0,${count}))`,
  );
  const pts = raw
    .trim()
    .replace(/^\[\[|\]\]$/g, "")
    .split("],[")
    .map((p) => p.split(",").map((t) => (/^[-+0-9.eE]+$/.test(t.trim()) ? Number(t) : NaN)) as [number, number]);
  return { n: c.n, pts };
}

export async function valueAt(giac: Giac, f: string, x: number): Promise<number> {
  return parseNumbers(await giac(`evalf(${f}(${num(x)}))`))[0] ?? NaN;
}

export async function slopeAt(giac: Giac, f: string, x: number): Promise<number> {
  return parseNumbers(await giac(`evalf(subst(diff(${f}(x_),x_),x_=${num(x)}))`))[0] ?? NaN;
}

/** Dense samples on [a,b], then narrow in three times on the best one. */
async function extremum(giac: Giac, f: string, a: number, b: number, want: "min" | "max") {
  let lo = a;
  let hi = b;
  let best = { x: NaN, y: NaN };
  for (let round = 0; round < 4; round++) {
    const count = round ? 80 : 400;
    const h = (hi - lo) / count;
    const ys = parseNumbers(await giac(`evalf(seq(${f}(${num(lo)}+k_*${num(h)}),k_,0,${count}))`));
    let bi = -1;
    ys.forEach((y, i) => {
      if (!Number.isFinite(y)) return;
      if (bi < 0 || (want === "min" ? y < ys[bi]! : y > ys[bi]!)) bi = i;
    });
    if (bi < 0) break;
    best = { x: lo + bi * h, y: ys[bi]! };
    lo = Math.max(a, best.x - 2 * h);
    hi = Math.min(b, best.x + 2 * h);
  }
  // Finish on f′(x)=0 near the best sample, so x²−4 gives x=0 rather than
  // 4.98E-7. A minimum at a bound has no such root and keeps the sample.
  if (Number.isFinite(best.x) && hi > lo) {
    const x = await rootIn(giac, `diff(${f}(x_),x_)=0`, lo, hi);
    if (Number.isFinite(x)) {
      const y = await valueAt(giac, f, x);
      if (Number.isFinite(y) && (want === "min" ? y <= best.y + 1e-9 : y >= best.y - 1e-9)) best = { x, y };
    }
  }
  return best;
}

/**
 * The roots of an equation on [a,b], left to right (or just the first). Sampled first, so a root where
 * the graph only touches the axis ((x−2)², no sign change for bisection to
 * find) and a root at an end of the interval are found too; then refined:
 * a sign change by fsolve in its bracket, a touch point by f′=0 there.
 */
export async function rootsIn(giac: Giac, equation: string, a: number, b: number, touch = true, firstOnly = false): Promise<number[]> {
  const found: number[] = [];
  const take = (r: number) => {
    if (!found.some((f) => Math.abs(f - r) <= 1e-9 * Math.max(1, Math.abs(r)))) found.push(r);
    return firstOnly;
  };
  const [lhs, rhs] = equation.split("=");
  const g = `(${lhs})-(${rhs ?? "0"})`;
  const count = firstOnly ? 400 : 1600;
  const h = (b - a) / count;
  const ys = parseNumbers(await giac(`evalf(seq(subst(${g},x_=${num(a)}+k_*${num(h)}),k_,0,${count}))`));
  const xs = ys.map((_, k) => a + k * h);
  // The size of g for "zero to rounding": the median sample, as a pole (tan) makes the largest meaningless.
  const sizes = ys.filter(Number.isFinite).map(Math.abs).sort((p, q) => p - q);
  const scale = Math.max(1, sizes[Math.floor(sizes.length / 2)] ?? 1);
  const valueAtX = async (x: number) => parseNumbers(await giac(`evalf(subst(${g},x_=${num(x)}))`))[0] ?? NaN;
  const inside = (x: number) => Number.isFinite(x) && x >= a - 1e-9 && x <= b + 1e-9;
  /** The sign change in [lo,hi] (g(lo) = ylo) by halving, to double precision; undefined if g breaks off inside. */
  const bisect = async (lo: number, hi: number, ylo: number): Promise<number | undefined> => {
    for (let k = 0; k < 60 && hi - lo > 1e-15 * Math.max(1, Math.abs(lo)); k++) {
      const m = (lo + hi) / 2;
      const ym = await valueAtX(m);
      if (!Number.isFinite(ym)) return undefined;
      if (ym === 0) return m;
      if (Math.sign(ym) === Math.sign(ylo)) [lo, ylo] = [m, ym];
      else hi = m;
    }
    return (lo + hi) / 2;
  };
  // A root is accepted only when g is zero to rounding there: x·ℯ^(3x) is
  // −2.5E−5 at x=−4, tiny beside 6.5E5 at x=4, but no root.
  for (let i = 0; i < ys.length; i++) {
    const y = ys[i]!;
    if (!Number.isFinite(y)) continue;
    if (y === 0) {
      if (take(xs[i]!)) return found;
      continue;
    }
    // Coming in from where g is undefined (the edge of ln's or √'s domain): a
    // root can sit between the edge and this sample, unseen by the grid.
    const before = ys[i - 1];
    if (before !== undefined && !Number.isFinite(before)) {
      let [out, inn] = [xs[i - 1]!, xs[i]!];
      for (let k = 0; k < 60; k++) {
        const m = (out + inn) / 2;
        if (Number.isFinite(await valueAtX(m))) inn = m;
        else out = m;
      }
      const edge = await valueAtX(inn);
      if (Number.isFinite(edge) && edge * y < 0) {
        const r = parseNumbers(await giac(`fsolve(${g}=0,x_=${num(inn)}..${num(xs[i]!)})`)).find(inside);
        if (r !== undefined && Math.abs(await valueAtX(r)) <= 1e-6 * scale && take(r)) return found;
      }
    }
    const next = ys[i + 1];
    if (next !== undefined && !Number.isFinite(next)) {
      let [inn, out] = [xs[i]!, xs[i + 1]!];
      for (let k = 0; k < 60; k++) {
        const m = (out + inn) / 2;
        if (Number.isFinite(await valueAtX(m))) inn = m;
        else out = m;
      }
      const edge = await valueAtX(inn);
      if (Number.isFinite(edge) && edge * y < 0) {
        const r = parseNumbers(await giac(`fsolve(${g}=0,x_=${num(xs[i]!)}..${num(inn)})`)).find(inside);
        if (r !== undefined && Math.abs(await valueAtX(r)) <= 1e-6 * scale && take(r)) return found;
      }
    }
    if (next !== undefined && Number.isFinite(next) && y * next < 0) {
      // Giac's bisection finds nothing when the root sits on the bracket's end to rounding
      // (2^x−x² at the sample 4.0, a hair below 0): halving the bracket here finds it.
      const r = parseNumbers(await giac(`fsolve(${g}=0,x_=${num(xs[i]!)}..${num(xs[i + 1]!)})`)).find(inside) ?? (await bisect(xs[i]!, xs[i + 1]!, y));
      // A jump through a pole changes sign too; only a real root counts.
      if (r !== undefined && Math.abs(await valueAtX(r)) <= 1e-6 * Math.max(Math.abs(y), Math.abs(next)) && take(r)) return found;
      continue;
    }
    // A touch point: |g| has a small local minimum here.
    const prev = ys[i - 1];
    // A candidate is small beside the whole graph; only an exact zero (below) is accepted.
    if (!touch || Math.abs(y) > 1e-2 * scale) continue;
    const lower = (v: number | undefined) => v === undefined || !Number.isFinite(v) || Math.abs(y) <= Math.abs(v);
    if (!lower(prev) || !lower(next)) continue;
    const lo = xs[Math.max(0, i - 1)]!;
    const hi = xs[Math.min(xs.length - 1, i + 1)]!;
    const r = parseNumbers(await giac(`fsolve(diff(${g},x_)=0,x_=${num(lo)}..${num(hi)})`)).find(inside);
    // A touch point's value is zero to rounding: (x−2)² gives ~1E−30 there.
    if (r !== undefined && Math.abs(await valueAtX(r)) <= 1e-12 * Math.max(1, scale) && take(r)) return found;
    // An end of the interval that is a root: the minimum of |g| sits on it.
    for (const end of [a, b]) if (Math.abs(end - xs[i]!) < h / 2 && Math.abs(await valueAtX(end)) <= 1e-12 * Math.max(1, scale) && take(end)) return found;
  }
  // A root sitting exactly on an end of the interval (5cos(t)−4cos(5t/2)=1 at t=4π).
  for (const end of [a, b]) {
    const v = await valueAtX(end);
    if (Number.isFinite(v) && Math.abs(v) <= 1e-12 * Math.max(1, scale) && take(end)) return found;
  }
  return found.sort((p, q) => p - q);
}

/** The leftmost root of an equation on [a,b], or NaN. */
export async function rootIn(giac: Giac, equation: string, a: number, b: number, touch = true): Promise<number> {
  return (await rootsIn(giac, equation, a, b, touch, true))[0] ?? NaN;
}

/** Run an Analyze Graph tool over [a,b]. Null when nothing is found there. */
export async function analyze(
  giac: Giac,
  type: AnalyzeKind,
  fn: number,
  name: string,
  other: string | undefined,
  a: number,
  b: number,
): Promise<Mark | null> {
  const point = async (x: number, title: string): Promise<Mark | null> => {
    if (!Number.isFinite(x)) return null;
    const y = await valueAt(giac, name, x);
    return Number.isFinite(y) ? { kind: "point", fn, x, y, title } : null;
  };
  switch (type) {
    case "zero":
      return point(await rootIn(giac, `${name}(x_)=0`, a, b), "zero");
    case "inflection":
      // f″ has to change sign: x⁴ has no inflection at 0.
      return point(await rootIn(giac, `diff(${name}(x_),x_,2)=0`, a, b, false), "inflection");
    case "intersection":
      if (other === undefined) return null;
      return point(await rootIn(giac, `${name}(x_)=${other}(x_)`, a, b), "intersection");
    case "min":
    case "max": {
      const e = await extremum(giac, name, a, b, type);
      return Number.isFinite(e.y)
        ? { kind: "point", fn, x: e.x, y: e.y, title: type === "min" ? "minimum" : "maximum" }
        : null;
    }
    case "integral": {
      const v = parseNumbers(await giac(`evalf(integrate(${name}(x_),x_,${num(a)},${num(b)}))`))[0] ?? NaN;
      return Number.isFinite(v) ? { kind: "area", fn, a, b, value: v } : null;
    }
  }
}

/** A relation's curve as paths through the grid, for Graph Trace: anticlockwise when closed, left to right when not. */
export type RelPath = { pts: [number, number][]; closed: boolean; len: number[] };

/**
 * The edge where left = right, found cell by cell as drawRelation finds it,
 * with the pieces joined into paths through the cell edges they share.
 */
export function relationPaths(grid: RelGrid): RelPath[] {
  const { nx, ny, vals, w } = grid;
  const X = (i: number) => w.xmin + (i / nx) * (w.xmax - w.xmin);
  const Y = (j: number) => w.ymin + (j / ny) * (w.ymax - w.ymin);
  const points = new Map<string, [number, number]>();
  const links = new Map<string, string[]>();
  const link = (p: string, q: string) => {
    links.set(p, [...(links.get(p) ?? []), q]);
    links.set(q, [...(links.get(q) ?? []), p]);
  };
  const limit = 1e6 * (Math.abs(w.xmax - w.xmin) + Math.abs(w.ymax - w.ymin));
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const [a, b, c, d] = [vals[j]?.[i], vals[j]?.[i + 1], vals[j + 1]?.[i], vals[j + 1]?.[i + 1]];
      if ([a, b, c, d].some((v) => v === undefined || !Number.isFinite(v))) continue;
      if (Math.max(Math.abs(a!), Math.abs(b!), Math.abs(c!), Math.abs(d!)) > limit) continue;
      const hit: string[] = [];
      const edge = (id: string, p: number, q: number, x0: number, y0: number, x1: number, y1: number) => {
        if (p <= 0 === q <= 0) return;
        const t = p / (p - q);
        points.set(id, [x0 + t * (x1 - x0), y0 + t * (y1 - y0)]);
        hit.push(id);
      };
      edge(`h${i},${j}`, a!, b!, X(i), Y(j), X(i + 1), Y(j));
      edge(`v${i + 1},${j}`, b!, d!, X(i + 1), Y(j), X(i + 1), Y(j + 1));
      edge(`h${i},${j + 1}`, d!, c!, X(i + 1), Y(j + 1), X(i), Y(j + 1));
      edge(`v${i},${j}`, c!, a!, X(i), Y(j + 1), X(i), Y(j));
      for (let k = 0; k + 1 < hit.length; k += 2) link(hit[k]!, hit[k + 1]!);
    }
  const used = new Set<string>();
  const walk = (from: string): string[] => {
    const out = [from];
    used.add(from);
    for (let at = from; ; ) {
      const next = (links.get(at) ?? []).find((q) => !used.has(q));
      if (!next) break;
      used.add(next);
      out.push(next);
      at = next;
    }
    return out;
  };
  const paths: RelPath[] = [];
  // Open paths start at an end (a point with one link); then the loops.
  const ends = [...links.keys()].filter((k) => links.get(k)!.length === 1);
  for (const start of [...ends, ...links.keys()]) {
    if (used.has(start)) continue;
    const ids = walk(start);
    if (ids.length < 2) continue;
    let pts = ids.map((id) => points.get(id)!);
    const closed = (links.get(ids.at(-1)!) ?? []).includes(ids[0]!) && ids.length > 2;
    if (closed) {
      pts.push(pts[0]!);
      let area = 0;
      for (let k = 0; k + 1 < pts.length; k++) area += pts[k]![0] * pts[k + 1]![1] - pts[k + 1]![0] * pts[k]![1];
      if (area < 0) pts = pts.reverse();
    } else if (pts[0]![0] > pts.at(-1)![0]) pts = pts.reverse();
    const len = [0];
    for (let k = 1; k < pts.length; k++) len.push(len[k - 1]! + Math.hypot(pts[k]![0] - pts[k - 1]![0], pts[k]![1] - pts[k - 1]![1]));
    paths.push({ pts, closed, len });
  }
  return paths.sort((p, q) => q.len.at(-1)! - p.len.at(-1)!);
}

/** The point a distance `at` along a path: a loop wraps round, an open path stops at its ends. */
export function pointAlong(path: RelPath, at: number): [number, number] {
  const total = path.len.at(-1)!;
  const s = path.closed ? ((at % total) + total) % total : Math.max(0, Math.min(total, at));
  let k = 1;
  while (k < path.len.length - 1 && path.len[k]! < s) k++;
  const [s0, s1] = [path.len[k - 1]!, path.len[k]!];
  const t = s1 > s0 ? (s - s0) / (s1 - s0) : 0;
  const [p, q] = [path.pts[k - 1]!, path.pts[k]!];
  return [p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])];
}

/** Where Graph Trace starts on a relation's curve: 15° round from its centre (1.93, 0.518 on x²+y²=4, as on the handheld). */
export function relationStart(path: RelPath): number {
  if (!path.closed) return path.len.at(-1)! / 2;
  const n = path.pts.length - 1;
  const cx = path.pts.slice(0, n).reduce((s, p) => s + p[0], 0) / n;
  const cy = path.pts.slice(0, n).reduce((s, p) => s + p[1], 0) / n;
  let best = 0;
  let gap = Infinity;
  for (let k = 0; k < n; k++) {
    const a = Math.atan2(path.pts[k]![1] - cy, path.pts[k]![0] - cx);
    const d = Math.abs(a - Math.PI / 12);
    if (d < gap) [gap, best] = [d, path.len[k]!];
  }
  return best;
}

/** The distance along a path of its point nearest (x, y), for the pointer. */
export function nearestAlong(path: RelPath, x: number, y: number): number {
  let best = 0;
  let gap = Infinity;
  for (let k = 0; k < path.pts.length; k++) {
    const d = Math.hypot(path.pts[k]![0] - x, path.pts[k]![1] - y);
    if (d < gap) [gap, best] = [d, path.len[k]!];
  }
  return best;
}

/** A slope field: slopes[j][i] at the centre of cell (i, j) of a res × res grid over the window. */
export type SlopeField = { res: number; w: GraphWindow; slopes: number[][] };

export async function sampleField(giac: Giac, f: string, w: GraphWindow, res: number): Promise<SlopeField> {
  const hx = (w.xmax - w.xmin) / res;
  const hy = (w.ymax - w.ymin) / res;
  const raw = await giac(
    `evalf(seq(seq(${f}(${num(w.xmin)}+(i_+0.5)*${num(hx)},${num(w.ymin)}+(j_+0.5)*${num(hy)}),i_,0,${res - 1}),j_,0,${res - 1}))`,
  );
  const rows = raw
    .trim()
    .replace(/^\[\[|\]\]$/g, "")
    .split("],[");
  return { res, w, slopes: rows.map((r) => r.split(",").map((t) => (/^[-+0-9.eE]+$/.test(t.trim()) ? Number(t) : NaN))) };
}

/**
 * The solution through (x0, y0), by Euler's method or Runge–Kutta (RK4), from
 * x0 out to Plot End and back to Plot Start: a point each Plot Step, worked
 * in `iterations` smaller steps between.
 */
export async function solveDE(
  giac: Giac,
  f: string,
  x0: number,
  y0: number,
  s: { method: "Euler" | "Runge-Kutta"; iterations: number; start: number; end: number; step: number },
): Promise<[number, number][]> {
  const h = s.step / Math.max(1, Math.round(s.iterations));
  const it = Math.max(1, Math.round(s.iterations));
  const move =
    s.method === "Euler"
      ? "yy:=yy+hh*F(xx,yy);"
      : "k1:=F(xx,yy); k2:=F(xx+hh/2,yy+hh*k1/2); k3:=F(xx+hh/2,yy+hh*k2/2); k4:=F(xx+hh,yy+hh*k3); yy:=yy+hh*(k1+2*k2+2*k3+k4)/6;";
  // One engine call each way: a loop that stops at the end or once the values run off.
  const run = (to: number, sign: number) => {
    const n = Math.min(4000, Math.max(0, Math.floor((Math.abs(to - x0) + 1e-9) / s.step)));
    return `((F,x0,y0,hh,N,M)->{ local L,xx,yy,k,m,k1,k2,k3,k4; L:=[[x0,y0]]; xx:=x0; yy:=y0; for (k:=1;k<=N;k++) { for (m:=1;m<=M;m++) { ${move} xx:=xx+hh; } yy:=evalf(yy); if (type(yy)!=DOM_FLOAT || abs(yy)>1e12) break; L:=append(L,[evalf(xx),yy]); } return L; })(${f},${num(x0)},${num(y0)},${num(sign * h)},${n},${it})`;
  };
  const parse = (raw: string): [number, number][] =>
    raw
      .trim()
      .replace(/^\[\[|\]\]$/g, "")
      .split("],[")
      .map((p) => p.split(",").map((t) => (/^[-+0-9.eE]+$/.test(t.trim()) ? Number(t) : NaN)) as [number, number])
      .filter((p) => p.length === 2 && p.every(Number.isFinite));
  const ahead = x0 < s.end ? parse(await giac(run(s.end, 1))) : [[x0, y0] as [number, number]];
  const back = x0 > s.start ? parse(await giac(run(s.start, -1))) : [];
  return [...back.reverse(), ...ahead.slice(back.length ? 1 : 0)];
}
