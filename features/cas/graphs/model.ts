// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 VCE Hub. Part of the /cas calculator: https://github.com/vcehub/cas
/**
 * The Graphs page's state and window presets. Functions are defined in the
 * engine as f1(x), f2(x) …, so a Calculator page in the same problem can use
 * them, as on the handheld.
 */
export type GraphWindow = { xmin: number; xmax: number; ymin: number; ymax: number; xscl: number; yscl: number };

/** The handheld's standard window (the screen is wider than it is tall). */
export const STANDARD: GraphWindow = { xmin: -10, xmax: 10, ymin: -20 / 3, ymax: 20 / 3, xscl: 1, yscl: 1 };

export type AnalyzeKind = "zero" | "min" | "max" | "inflection" | "integral" | "intersection";

export type Tool =
  /**
   * Graph Trace on a function (fn, x), or on a relation or parametric curve:
   * `at` is the distance along the relation's curve, or t. NaN until the page
   * puts it at the curve's starting point.
   */
  | { kind: "trace"; fn: number; x: number; curve?: { kind: "rel" | "par"; n: number; at: number } }
  /**
   * An Analyze Graph tool. With two or more graphs it starts at "graph": the
   * student clicks the graph to search (or picks it with ↑/↓ and Enter), then
   * the lower and upper bounds.
   */
  | { kind: "bounds"; type: AnalyzeKind; fn: number; stage: "graph" | "lower" | "upper"; lower?: number; x: number }
  | { kind: "dydx"; fn: number; x: number };

export type Mark =
  | { kind: "point"; fn: number; x: number; y: number; title?: string }
  | { kind: "area"; fn: number; a: number; b: number; value: number };

/** Plotted values for one function across the window. */
export type Samples = { n: number; xs: number[]; ys: number[] };

/** Zoom presets by menu id. Positions not yet checked on hardware are approximate. */
export function zoomed(id: string, w: GraphWindow, samples: Samples[], aspect: number): GraphWindow {
  const cx = (w.xmin + w.xmax) / 2;
  const cy = (w.ymin + w.ymax) / 2;
  const scale = (f: number): GraphWindow => ({
    ...w,
    xmin: cx - ((w.xmax - w.xmin) * f) / 2,
    xmax: cx + ((w.xmax - w.xmin) * f) / 2,
    ymin: cy - ((w.ymax - w.ymin) * f) / 2,
    ymax: cy + ((w.ymax - w.ymin) * f) / 2,
  });
  switch (id) {
    case "zoomIn":
      return scale(1 / 4);
    case "zoomOut":
      return scale(4);
    case "zoomQuadrant1":
      return { ...STANDARD, xmin: 0, xmax: 20, ymin: 0, ymax: 40 / 3 };
    case "zoomTrig":
      return { xmin: (-17 * Math.PI) / 8, xmax: (17 * Math.PI) / 8, ymin: -4, ymax: 4, xscl: Math.PI / 2, yscl: 1 };
    case "zoomDecimal":
      return { xmin: -15.9, xmax: 15.9, ymin: -10.6, ymax: 10.6, xscl: 1, yscl: 1 };
    case "zoomSquare": {
      const half = ((w.xmax - w.xmin) / 2) / aspect;
      return { ...w, ymin: cy - half, ymax: cy + half };
    }
    case "zoomFit": {
      const ys = samples.flatMap((s) => s.ys.filter(Number.isFinite));
      if (!ys.length) return w;
      let lo = Math.min(...ys);
      let hi = Math.max(...ys);
      if (hi - lo < 1e-9) {
        lo -= 1;
        hi += 1;
      }
      return { ...w, ymin: lo, ymax: hi };
    }
    case "zoomStandard":
    case "zoomUser":
    case "zoomData":
      return STANDARD;
    default:
      return w;
  }
}

/** Coordinates on graph labels: three significant figures, like the handheld's graph labels. */
export function fmt3(v: number): string {
  if (!Number.isFinite(v)) return "undef";
  if (Math.abs(v) < 1e-10) return "0";
  const s = Number(v.toPrecision(3));
  if (Math.abs(s) >= 1e6 || Math.abs(s) < 1e-3) return s.toExponential(2).replace("e", "E").replace("+", "");
  return String(s);
}

/** Window Settings' "Auto" tick spacing: a power of ten giving 10 to 99 ticks, so 1 for −10…10. */
export function autoScale(lo: number, hi: number): number {
  const range = hi - lo;
  if (!(range > 0)) return 1;
  return 10 ** Math.floor(Math.log10(range / 10));
}

/**
 * Engine names for a Graphs page's curves. Each page has its own, so a page
 * never redraws another's: f1 on a new page doesn't change f1 on page 1.
 * The plain name f1 is also defined, for the Calculator (the latest
 * definition wins, as on the handheld).
 */
export const fnName = (page: number, n: number) => `g${page}f${n}_`;
export const relName = (page: number, n: number) => `g${page}r${n}_`;
export const parNames = (page: number, n: number): [string, string] => [`g${page}x${n}_`, `g${page}y${n}_`];
/** A Diff Eq's slope, f(x, y). */
export const deName = (page: number, n: number) => `g${page}d${n}_`;
