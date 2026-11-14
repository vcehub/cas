// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 VCE Hub. Part of the /cas calculator: https://github.com/vcehub/cas
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { palette } from "@/shared/lib/tokens";
import { cn } from "@/shared/lib/utils";
import type { Giac } from "../engine/evaluate";
import type { Cursor } from "../math/cursor";
import { selection } from "../math/editor";
import { MathView } from "../math/render";
import { chars } from "../math/tree";
import { DE_DEFAULTS, type GraphRelation, type GraphsPage } from "../state/document";
import {
  nearestAlong,
  parseNumbers,
  pointAlong,
  relationPaths,
  relationStart,
  sample,
  sampleField,
  solveDE,
  type SlopeField,
  sampleGrid,
  sampleParametric,
  slopeAt,
  valueAt,
  type ParSamples,
  type RelGrid,
} from "./analyze";
import { formatFloat } from "../engine/format";
import { SliderView } from "./sliders";
import { autoScale, deName, fmt3, fnName, parNames, relName, type GraphWindow, type Samples } from "./model";
import { graphSaid } from "../a11y";

export const CURVE = [palette.casF1, palette.casF2, palette.casF3, palette.casF4, palette.casF5, palette.casF6];
export const curveColour = (n: number) => CURVE[(n - 1) % CURVE.length]!;
/** Relations take the next colours after the functions'. */
const relColour = (page: GraphsPage, n: number) => curveColour(page.functions.length + n);
/** Parametric curves take the colours after the relations'. */
const parColour = (page: GraphsPage, n: number) =>
  curveColour(page.functions.length + (page.relations?.length ?? 0) + n);
/** Diff Eq solution curves, after the parametric curves'. */
const deColour = (page: GraphsPage, n: number) =>
  curveColour(page.functions.length + (page.relations?.length ?? 0) + (page.parametrics?.length ?? 0) + n);

/**
 * The Graphs page: axes with a tick per unit and the window's end values,
 * each function in its colour with its "f1(x)=…" label beside the curve,
 * marks left by Analyze Graph, the trace cursor and bound prompts, and the
 * entry line across the top. Text sizes follow the screen's width, so the
 * labels keep their size when the table takes half the screen.
 */
export function GraphsApp({
  page,
  giac,
  ready,
  onSamples,
  onWindow,
  onToolX,
  onConfirm,
  onToolFn,
  onEditFn,
  onEditRel,
  onEditPar,
  onDESettings,
  onSlider,
  onSliderAction,
  onSliderPlace,
  onCursor,
  onSelect,
}: {
  page: GraphsPage;
  giac: Giac | null;
  ready: boolean;
  onSamples: (s: Samples[]) => void;
  /** The mouse moved the window: a drag pans, the wheel zooms. */
  onWindow: (w: GraphWindow) => void;
  /** The mouse moved a trace point or a bound. */
  onToolX: (x: number) => void;
  /** A click that sets a bound at x, as Enter does. */
  onConfirm: (x: number) => void;
  /**
   * Analyze Graph, choosing a graph: the pointer is over function n. `pick`:
   * it was clicked, so take it and start the lower bound at x.
   */
  onToolFn: (n: number, pick?: { x: number }) => void;
  /** Double-clicking a curve's label edits that function (or relation). */
  onEditFn: (n: number) => void;
  onEditRel: (n: number) => void;
  onEditPar: (n: number) => void;
  /** The Diff Eq entry line's … button: the Differential Equation settings. */
  onDESettings: () => void;
  /** A slider moved; final when the drag or step has finished. */
  onSlider: (name: string, value: number, final: boolean) => void;
  /** A choice from a slider's right-click menu (Move is handled here). */
  onSliderAction: (name: string, action: "settings" | "animate" | "minimize" | "delete") => void;
  /** Move put a slider somewhere, as fractions of the graph's width and height. */
  onSliderPlace: (name: string, at: { x: number; y: number }) => void;
  onCursor: (c: Cursor) => void;
  /** A drag across the entry line selects that stretch of it. */
  onSelect: (from: Cursor, to: Cursor) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0, sw: 0 });
  const [samples, setSamples] = useState<Samples[]>([]);
  const [toolY, setToolY] = useState<number>(NaN);
  const [slope, setSlope] = useState<number>(NaN);
  const w = page.window;

  useEffect(() => {
    const el = box.current;
    const r = root.current;
    if (!el || !r) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight, sw: r.clientWidth }));
    ro.observe(el);
    ro.observe(r);
    return () => ro.disconnect();
  }, [page.table]);

  // Resample whenever the functions or the window change.
  // Slider values are part of every curve's key: moving one redraws them.
  const sliderKey = (page.sliders ?? []).map((sl) => `${sl.name}=${sl.value}`).join("|");
  const fnKey = page.functions.map((f) => `${f.n}:${f.text}:${f.hidden ? 1 : 0}`).join("|") + sliderKey;
  useEffect(() => {
    if (!giac || !ready) return;
    let cancelled = false;
    void (async () => {
      const out: Samples[] = [];
      for (const f of page.functions) {
        if (f.hidden) continue;
        out.push(await sample(giac, fnName(page.id, f.n), f.n, w));
      }
      if (!cancelled) {
        setSamples(out);
        onSamples(out);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fnKey stands for page.functions
  }, [giac, ready, fnKey, w]);

  // Relations: left − right over a grid, resampled with the window.
  const [grids, setGrids] = useState<RelGrid[]>([]);
  const relations = page.relations ?? [];
  const relKey = relations.map((r) => `${r.n}:${r.text}:${r.hidden ? 1 : 0}`).join("|") + sliderKey;
  useEffect(() => {
    if (!giac || !ready) return;
    let cancelled = false;
    void (async () => {
      const out: RelGrid[] = [];
      for (const r of relations) if (!r.hidden) out.push(await sampleGrid(giac, relName(page.id, r.n), r.n, w));
      if (!cancelled) setGrids(out);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- relKey stands for relations
  }, [giac, ready, relKey, w]);

  // Parametric curves: points at each t step, resampled when the curves change.
  const [pars, setPars] = useState<ParSamples[]>([]);
  const parametrics = page.parametrics ?? [];
  const parKey =
    sliderKey +
    parametrics.map((c) => `${c.n}:${c.x}:${c.y}:${c.tmin}:${c.tmax}:${c.tstep}:${c.hidden ? 1 : 0}`).join("|");
  useEffect(() => {
    if (!giac || !ready) return;
    let cancelled = false;
    void (async () => {
      const out: ParSamples[] = [];
      for (const c of parametrics) if (!c.hidden) out.push(await sampleParametric(giac, parNames(page.id, c.n), c));
      if (!cancelled) setPars(out);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- parKey stands for parametrics
  }, [giac, ready, parKey]);

  // Diff Eqs: the first one's slope field (the axes follow the page's first
  // Diff Eq, as on the handheld) and each one's solution through its (x0, y0).
  const [field, setField] = useState<SlopeField | null>(null);
  const [solutions, setSolutions] = useState<{ n: number; pts: [number, number][] }[]>([]);
  const des = page.des ?? [];
  const deSet = page.deSettings ?? DE_DEFAULTS;
  const deKey =
    sliderKey + JSON.stringify(deSet) + des.map((d) => `${d.n}:${d.rhs}:${d.x0}:${d.y0}:${d.hidden ? 1 : 0}`).join("|");
  useEffect(() => {
    if (!giac || !ready) return;
    let cancelled = false;
    void (async () => {
      const first = des.find((d) => !d.hidden);
      const f = first && deSet.field === "Slope" ? await sampleField(giac, deName(page.id, first.n), w, deSet.resolution) : null;
      const sols = [];
      for (const d of des)
        if (!d.hidden && d.x0 !== undefined && d.y0 !== undefined)
          sols.push({ n: d.n, pts: await solveDE(giac, deName(page.id, d.n), d.x0, d.y0, deSet) });
      if (!cancelled) {
        setField(f);
        setSolutions(sols);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deKey stands for des and deSet
  }, [giac, ready, deKey, w]);

  const [sliderMenu, setSliderMenu] = useState<{ name: string; x: number; y: number } | null>(null);
  /** The slider last used, drawn in blue; the newest until one is touched. */
  const [usedSlider, setUsedSlider] = useState<string | null>(null);
  const sliders = page.sliders ?? [];
  const activeSlider = sliders.some((sl) => sl.name === usedSlider) ? usedSlider : (sliders.at(-1)?.name ?? null);
  // New sliders take over: the first of a batch (a, then b) is the one in blue.
  const sliderNames = sliders.map((sl) => sl.name).join(",");
  const seenSliders = useRef(sliderNames);
  useEffect(() => {
    const before = new Set(seenSliders.current.split(","));
    const added = sliderNames.split(",").find((n) => n && !before.has(n));
    if (added) setUsedSlider(added);
    seenSliders.current = sliderNames;
  }, [sliderNames]);
  /** After Move: the slider follows the pointer until a click puts it down. */
  const [moving, setMoving] = useState<string | null>(null);

  const tool = page.tool;
  // Graph Trace on a relation follows its longest piece of curve.
  const paths = useMemo(() => new Map(grids.map((g) => [g.n, relationPaths(g)[0]])), [grids]);
  const curve = tool?.kind === "trace" ? tool.curve : undefined;
  const relPath = curve?.kind === "rel" ? paths.get(curve.n) : undefined;
  // A relation's trace starts at its starting point once the curve is known.
  useEffect(() => {
    if (curve?.kind === "rel" && !Number.isFinite(curve.at) && relPath) onToolX(relationStart(relPath));
  }, [curve, relPath, onToolX]);
  const [parPt, setParPt] = useState<[number, number] | null>(null);
  const curvePt: [number, number] | null =
    curve?.kind === "rel" ? (relPath && Number.isFinite(curve.at) ? pointAlong(relPath, curve.at) : null) : curve?.kind === "par" ? parPt : null;
  useEffect(() => {
    if (!giac || curve?.kind !== "par" || !Number.isFinite(curve.at)) return;
    let cancelled = false;
    void (async () => {
      const [gx, gy] = parNames(page.id, curve.n);
      const [x, y] = parseNumbers(await giac(`evalf([${gx}(${curve.at}),${gy}(${curve.at})])`));
      if (!cancelled) setParPt(Number.isFinite(x) && Number.isFinite(y) ? [x!, y!] : null);
    })();
    return () => {
      cancelled = true;
    };
  }, [giac, curve, page.id, parKey]);
  useEffect(() => {
    if (!giac || !tool || curve) return;
    let cancelled = false;
    void (async () => {
      const y = await valueAt(giac, fnName(page.id, tool.fn), tool.x);
      const s = tool.kind === "dydx" ? await slopeAt(giac, fnName(page.id, tool.fn), tool.x) : NaN;
      if (!cancelled) {
        setToolY(y);
        setSlope(s);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [giac, tool, curve, page.id]);

  // Mouse: drag the background to pan, wheel to zoom about the pointer. With a
  // tool running, the trace point or bound follows the pointer and a click
  // sets the bound.
  const drag = useRef<{ x: number; y: number; w: GraphWindow; moved: boolean } | null>(null);
  const xAt = (clientX: number) => {
    const r = box.current!.getBoundingClientRect();
    return w.xmin + ((clientX - r.left) / r.width) * (w.xmax - w.xmin);
  };
  const yAt = (clientY: number) => {
    const r = box.current!.getBoundingClientRect();
    return w.ymax - ((clientY - r.top) / r.height) * (w.ymax - w.ymin);
  };
  /** The trace position under the pointer: x on a function, the nearest point on a curve. */
  const traceAt = (e: ReactPointerEvent): number => {
    const [x, y] = [xAt(e.clientX), yAt(e.clientY)];
    if (curve?.kind === "rel") return relPath ? nearestAlong(relPath, x, y) : NaN;
    if (curve?.kind === "par") {
      const c = parametrics.find((q) => q.n === curve.n);
      const pts = pars.find((q) => q.n === curve.n)?.pts ?? [];
      let [best, gap] = [0, Infinity];
      pts.forEach(([px, py], k) => {
        const d = Math.hypot(px - x, py - y);
        if (d < gap) [gap, best] = [d, k];
      });
      return c ? Math.min(c.tmax, c.tmin + best * c.tstep) : NaN;
    }
    return x;
  };
  /** The function whose curve is under the pointer (within a few pixels), for choosing a graph. */
  const graphAt = (e: ReactPointerEvent): number | undefined => {
    const r = box.current!.getBoundingClientRect();
    const [x, Y] = [xAt(e.clientX), e.clientY - r.top];
    const reach = Math.max(14, r.height * 0.05);
    let [best, gap]: [number | undefined, number] = [undefined, reach];
    for (const s of samples) {
      if (s.xs.length < 2) continue;
      const dx = s.xs[1]! - s.xs[0]!;
      const i = Math.round((x - s.xs[0]!) / dx);
      // The nearest of a few samples either side, so a steep curve is still easy to hit.
      for (let k = Math.max(0, i - 3); k <= Math.min(s.xs.length - 1, i + 3); k++) {
        const y = s.ys[k];
        if (y === undefined || !Number.isFinite(y)) continue;
        const d = Math.hypot(((s.xs[k]! - x) / (w.xmax - w.xmin)) * r.width, ((w.ymax - y) / (w.ymax - w.ymin)) * r.height - Y);
        if (d < gap) [gap, best] = [d, s.n];
      }
    }
    return best;
  };
  const choosing = tool?.kind === "bounds" && tool.stage === "graph";
  const latest = useRef({ w, onWindow });
  latest.current = { w, onWindow };
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const { w: cur, onWindow: set } = latest.current;
      const r = el.getBoundingClientRect();
      const fx = (e.clientX - r.left) / r.width;
      const fy = (e.clientY - r.top) / r.height;
      const x0 = cur.xmin + fx * (cur.xmax - cur.xmin);
      const y0 = cur.ymax - fy * (cur.ymax - cur.ymin);
      const k = e.deltaY > 0 ? 1.15 : 1 / 1.15;
      set({
        ...cur,
        xmin: x0 - (x0 - cur.xmin) * k,
        xmax: x0 + (cur.xmax - x0) * k,
        ymin: y0 - (y0 - cur.ymin) * k,
        ymax: y0 + (cur.ymax - y0) * k,
        xscl: autoScale(x0 - (x0 - cur.xmin) * k, x0 + (cur.xmax - x0) * k),
        yscl: autoScale(y0 - (y0 - cur.ymin) * k, y0 + (cur.ymax - y0) * k),
      });
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, []);
  const pointer = {
    onPointerDown: (e: ReactPointerEvent) => {
      if (e.button !== 0) return;
      if (moving) {
        setMoving(null);
        return;
      }
      if (tool) {
        if (choosing) {
          const n = graphAt(e);
          if (n !== undefined) onToolFn(n, { x: xAt(e.clientX) });
        } else if (tool.kind === "bounds") onConfirm(xAt(e.clientX));
        else onToolX(traceAt(e));
        return;
      }
      drag.current = { x: e.clientX, y: e.clientY, w, moved: false };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    },
    onPointerMove: (e: ReactPointerEvent) => {
      if (moving) {
        const r = box.current!.getBoundingClientRect();
        onSliderPlace(moving, {
          x: Math.min(0.9, Math.max(0, (e.clientX - r.left) / r.width)),
          y: Math.min(0.9, Math.max(0, (e.clientY - r.top) / r.height)),
        });
        return;
      }
      const d = drag.current;
      if (d) {
        const dx = ((e.clientX - d.x) / size.w) * (d.w.xmax - d.w.xmin);
        const dy = ((e.clientY - d.y) / size.h) * (d.w.ymax - d.w.ymin);
        if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 3) d.moved = true;
        if (d.moved)
          onWindow({ ...d.w, xmin: d.w.xmin - dx, xmax: d.w.xmax - dx, ymin: d.w.ymin + dy, ymax: d.w.ymax + dy });
      } else if (choosing) {
        const n = graphAt(e);
        if (n !== undefined && n !== tool.fn) onToolFn(n);
      } else if (tool) onToolX(tool.kind === "bounds" ? xAt(e.clientX) : traceAt(e));
    },
    onPointerUp: () => {
      drag.current = null;
    },
  };

  const px = (x: number) => ((x - w.xmin) / (w.xmax - w.xmin)) * size.w;
  const py = (y: number) => ((w.ymax - y) / (w.ymax - w.ymin)) * size.h;

  useEffect(() => {
    const c = canvas.current;
    if (!c || !size.w) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = size.w * dpr;
    c.height = size.h * dpr;
    const g = c.getContext("2d");
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw(g, size.w, size.h, size.sw, page, samples, toolY, grids, pars, field, solutions);
  }, [size, page, samples, toolY, grids, pars, field, solutions]);

  const labelFor = (n: number) => {
    const s = samples.find((x) => x.n === n);
    if (!s) return null;
    // The handheld writes the label just right of the curve, in the upper
    // part of the window: take the rightmost point there.
    const span = w.ymax - w.ymin;
    for (let i = s.ys.length - 1; i >= 0; i--) {
      const y = s.ys[i];
      if (y !== undefined && Number.isFinite(y) && y > w.ymin + 0.45 * span && y < w.ymax - 0.12 * span) {
        return { x: px(s.xs[i]!) + fs * 0.7, y: py(y) + fs * 1.2 };
      }
    }
    const order = [0.78, 0.7, 0.85, 0.6, 0.9, 0.5, 0.4, 0.3, 0.2];
    for (const frac of order) {
      const i = Math.floor(frac * (s.ys.length - 1));
      const y = s.ys[i];
      if (y !== undefined && Number.isFinite(y) && y < w.ymax && y > w.ymin) return { x: px(s.xs[i]!), y: py(y) };
    }
    return null;
  };

  const fs = Math.max(10, size.sw * 0.04);
  // While a tool runs, a click on a label goes to the graph under it (a bound
  // set where a label sits); the labels edit on double-click otherwise.
  const passThrough = tool ? "pointer-events-none" : undefined;
  return (
    <div ref={root} className="absolute inset-0 flex border-t-[0.6cqw] border-casStrip">
      <div
        ref={box}
        {...pointer}
        className={cn(
          "relative min-w-0 flex-1 touch-none overflow-hidden",
          tool ? "cursor-crosshair" : "cursor-grab active:cursor-grabbing",
        )}
      >
        <canvas ref={canvas} role="img" aria-label={graphSaid(page)} className="absolute inset-0 h-full w-full" />
        {placeLabels(
          page.functions.filter((f) => !f.hidden),
          labelFor,
          size.w,
          fs,
        ).map(({ f, left, top }) => (
          <div
            key={f.n}
            title="Double-click to edit"
            onPointerDown={(e) => e.stopPropagation()}
            onDoubleClick={() => onEditFn(f.n)}
            className={cn("absolute cursor-pointer", passThrough)}
            style={{ left, top, color: curveColour(f.n), fontSize: fs }}
          >
            <span className="inline-flex items-center font-bold">
              <span className="font-casmath">f{f.n}</span>
              <MathView row={[...chars("(x)="), ...f.row]} />
            </span>
          </div>
        ))}
        {relations
          .filter((r) => !r.hidden)
          .map((r, k) => {
            const at = relLabelAt(
              grids.find((g) => g.n === r.n),
              size.w,
              size.h,
              fs,
              k,
            );
            return (
              <div
                key={`rel${r.n}`}
                title="Double-click to edit"
                onPointerDown={(e) => e.stopPropagation()}
                onDoubleClick={() => onEditRel(r.n)}
                className={cn("absolute cursor-pointer whitespace-nowrap", passThrough)}
                style={{ left: at.left, top: at.top, color: relColour(page, r.n), fontSize: fs }}
              >
                <span className="inline-flex items-center">
                  <b className="mr-[0.25em] font-casmath">rel{r.n}:</b>
                  <MathView row={r.row} />
                </span>
              </div>
            );
          })}
        {parametrics
          .filter((c) => !c.hidden)
          .map((c, k) => {
            const at = parLabelAt(
              pars.find((p) => p.n === c.n),
              w,
              size.w,
              size.h,
              fs,
              k + relations.length,
            );
            return (
              <div
                key={`par${c.n}`}
                title="Double-click to edit"
                onPointerDown={(e) => e.stopPropagation()}
                onDoubleClick={() => onEditPar(c.n)}
                className={cn("absolute flex cursor-pointer flex-col whitespace-nowrap", passThrough)}
                style={{ left: at.left, top: at.top, color: parColour(page, c.n), fontSize: fs }}
              >
                <span className="inline-flex items-center">
                  <b className="font-casmath">x{c.n}</b>
                  <MathView row={[...chars("(t)="), ...c.xRow]} />
                </span>
                <span className="inline-flex items-center">
                  <b className="font-casmath">y{c.n}</b>
                  <MathView row={[...chars("(t)="), ...c.yRow]} />
                </span>
              </div>
            );
          })}
        {sliders.map((sl, k) => (
          <SliderView
            key={sl.name}
            slider={sl}
            index={k}
            fs={fs}
            size={size}
            active={sl.name === activeSlider}
            onValue={(v, final) => {
              setUsedSlider(sl.name);
              onSlider(sl.name, v, final);
            }}
            onMenu={(x, y) => {
              const r = box.current!.getBoundingClientRect();
              setUsedSlider(sl.name);
              setSliderMenu({ name: sl.name, x: x - r.left, y: y - r.top });
            }}
          />
        ))}
        {sliderMenu && (
          <SliderMenu
            slider={sliders.find((sl) => sl.name === sliderMenu.name)}
            at={sliderMenu}
            fs={fs}
            onPick={(action) => {
              setSliderMenu(null);
              if (action === "move") setMoving(sliderMenu.name);
              else onSliderAction(sliderMenu.name, action);
            }}
            onClose={() => setSliderMenu(null)}
          />
        )}
        {page.marks.map((m, i) =>
          m.kind === "point" ? (
            <div
              key={i}
              className="pointer-events-none absolute flex items-center whitespace-nowrap font-casui text-casInk"
              style={{ left: px(m.x), top: py(m.y), fontSize: fs * 0.95 }}
            >
              <span className="font-casmath text-[1.3em] leading-none">(</span>
              {fmt3(m.x)},{fmt3(m.y)}
              <span className="font-casmath text-[1.3em] leading-none">)</span>
            </div>
          ) : (
            <div
              key={i}
              className="pointer-events-none absolute whitespace-nowrap font-casui text-casInk"
              style={{
                left: px((m.a + m.b) / 2) + fs * 0.4,
                top: areaLabelY(m, samples, py, size.h) + fs * 0.2,
                fontSize: fs * 0.95,
              }}
            >
              {fmt3(m.value)}
            </div>
          ),
        )}
        {tool && <ToolOverlay page={page} y={toolY} slope={slope} curvePt={curvePt} fs={fs} px={px} py={py} />}
        {page.editing !== null && (
          <div
            onPointerDown={(e) => e.stopPropagation()}
            className="absolute inset-x-0 top-0 flex min-h-[9cqw] cursor-text items-center gap-[0.4em] border-b-[0.3cqw] border-casStrip bg-casScreen py-[1cqw] pl-[4.4cqw] pr-[2cqw] text-[4.4cqw]"
          >
            <span aria-hidden className="mr-[2cqw] h-[4cqw] w-[4cqw] shrink-0 border-[0.25cqw] border-casRule" />
            {page.entryKind === "par" && page.parDraft ? (
              <ParametricEntry page={page} onCursor={onCursor} onSelect={onSelect} />
            ) : page.entryKind === "de" && page.parDraft ? (
              <DEEntry page={page} onCursor={onCursor} onSelect={onSelect} onSettings={onDESettings} />
            ) : (
              <>
                <MathView row={chars(page.entryKind === "rel" ? `rel${page.editing}:` : `f${page.editing}(x)=`)} />
                <MathView
                  row={page.edit.row}
                  cursor={page.edit.cursor}
                  selection={selection(page.edit)}
                  onPick={onCursor}
                  onSelect={onSelect}
                />
              </>
            )}
          </div>
        )}
      </div>
      {page.table && <GraphTable page={page} giac={giac} ready={ready} />}
    </div>
  );
}

/** Label positions beside each curve, nudged down so no two overlap. */
function placeLabels<F extends { n: number }>(
  fns: F[],
  labelFor: (n: number) => { x: number; y: number } | null,
  width: number,
  fs: number,
): { f: F; left: number; top: number }[] {
  const out: { f: F; left: number; top: number }[] = [];
  const lineH = fs * 1.9;
  for (const f of fns) {
    const at = labelFor(f.n);
    if (!at) continue;
    const left = Math.min(at.x, width * 0.62);
    let top = Math.max(2, at.y - fs * 2.1);
    for (let guard = 0; guard < 8; guard++) {
      const clash = out.some((o) => Math.abs(o.top - top) < lineH && Math.abs(o.left - left) < width * 0.35);
      if (!clash) break;
      top += lineH;
    }
    out.push({ f, left, top });
  }
  return out;
}

function ToolOverlay({
  page,
  y,
  slope,
  curvePt,
  fs,
  px,
  py,
}: {
  page: GraphsPage;
  y: number;
  slope: number;
  /** The trace point on a relation or parametric curve. */
  curvePt: [number, number] | null;
  fs: number;
  px: (x: number) => number;
  py: (y: number) => number;
}) {
  const tool = page.tool!;
  const curve = tool.kind === "trace" ? tool.curve : undefined;
  if (curve) {
    const colour = curve.kind === "rel" ? relColour(page, curve.n) : parColour(page, curve.n);
    return (
      <>
        {curvePt && <TraceMark x={px(curvePt[0])} y={py(curvePt[1])} colour={colour} fs={fs} />}
        <div
          className="absolute bottom-[1.2cqw] right-[1.6cqw] whitespace-nowrap"
          style={{ color: colour, fontSize: fs * 1.1 }}
        >
          <span className="flex items-center gap-[0.35em] font-casui">
            <b className="font-casmath">{curve.kind === "rel" ? `rel${curve.n}:` : `x${curve.n},y${curve.n}:`}</b>
            <span className="font-casmath text-[1.25em] leading-none">(</span>
            {curvePt ? `${fmt3(curvePt[0])} , ${fmt3(curvePt[1])}` : "undef"}
            <span className="font-casmath text-[1.25em] leading-none">)</span>
            {curve.kind === "par" && (
              <>
                ,<i className="font-casmath">t</i>= {fmt3(curve.at)}
              </>
            )}
          </span>
        </div>
      </>
    );
  }
  const colour = curveColour(tool.fn);
  if (tool.kind === "bounds") {
    const line = (x: number) => (
      <div
        className="pointer-events-none absolute bottom-0 top-0 border-l-[0.75cqw] border-dotted border-casInk"
        style={{ left: px(x) - 1 }}
      />
    );
    return (
      <>
        {tool.lower !== undefined && line(tool.lower)}
        {tool.stage !== "graph" && line(tool.x)}
        <div
          className="absolute bottom-[1.2cqw] left-[1.2cqw] border border-casInk bg-casScreen px-[1.2cqw] py-[0.4cqw] font-casui"
          style={{ fontSize: fs * 0.9 }}
        >
          {tool.stage === "graph" ? "which graph?" : tool.stage === "lower" ? "lower bound?" : "upper bound?"}
        </div>
      </>
    );
  }
  return (
    <>
      {Number.isFinite(y) && <TraceMark x={px(tool.x)} y={py(y)} colour={colour} fs={fs} />}
      <div
        className="absolute bottom-[1.2cqw] right-[1.6cqw] whitespace-nowrap"
        style={{ color: colour, fontSize: fs * 1.1 }}
      >
        {tool.kind === "dydx" ? (
          <span className="font-casmath">
            <b>dy/dx</b>={fmt3(slope)}
          </span>
        ) : (
          <span className="flex items-center gap-[0.35em] font-casui">
            <b className="font-casmath">f{tool.fn}:</b>
            <span className="font-casmath text-[1.25em] leading-none">(</span>
            {fmt3(tool.x)} , {Number.isFinite(y) ? fmt3(y) : "undef"}
            <span className="font-casmath text-[1.25em] leading-none">)</span>
          </span>
        )}
      </div>
    </>
  );
}

/** The trace point: a ringed cross. */
function TraceMark({ x, y, colour, fs }: { x: number; y: number; colour: string; fs: number }) {
  return (
    <svg
      className="pointer-events-none absolute"
      style={{ left: x - fs * 1.1, top: y - fs * 1.1 }}
      width={fs * 2.2}
      height={fs * 2.2}
      viewBox="0 0 22 22"
    >
      <circle cx="11" cy="11" r="4.6" fill="none" stroke={colour} strokeWidth="1.3" />
      <path d="M2 2 L20 20 M20 2 L2 20" stroke={colour} strokeWidth="1.1" />
    </svg>
  );
}

/** Split-screen table: x from 0 in steps of 1, a column per function. */
function GraphTable({ page, giac, ready }: { page: GraphsPage; giac: Giac | null; ready: boolean }) {
  const [cols, setCols] = useState<{ n: number; ys: number[] }[]>([]);
  const fns = page.functions.filter((f) => !f.hidden);
  const key = fns.map((f) => `${f.n}:${f.text}`).join("|");
  useEffect(() => {
    if (!giac || !ready) return;
    let cancelled = false;
    void (async () => {
      const out = [];
      for (const f of fns)
        out.push({ n: f.n, ys: parseNumbers(await giac(`evalf(seq(${fnName(page.id, f.n)}(k_),k_,0,20))`)) });
      if (!cancelled) setCols(out);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key stands for fns
  }, [giac, ready, key]);
  return (
    <div className="w-1/2 shrink-0 overflow-y-auto border-l-[0.4cqw] border-casF6 font-casui text-[3.6cqw] [scrollbar-width:none]">
      <div className="grid" style={{ gridTemplateColumns: `repeat(${cols.length + 1}, minmax(0, 1fr))` }}>
        {/* Two header rows, as on the handheld: the column name, then its definition. */}
        <div className="row-span-2 flex items-start justify-center border-b-[0.3cqw] border-r border-casRule bg-casRowAlt pt-[1.4cqw]">
          x
        </div>
        {cols.map((c) => (
          <div
            key={c.n}
            className="border-r border-casRule bg-casRowAlt px-[1cqw] pt-[1.2cqw]"
            style={{ color: curveColour(c.n) }}
          >
            f{c.n}(x):=
          </div>
        ))}
        {cols.map((c) => (
          <div
            key={c.n}
            className="truncate border-b-[0.3cqw] border-r border-casRule bg-casRowAlt px-[1cqw] pb-[1.2cqw] pt-[0.6cqw]"
            style={{ color: curveColour(c.n) }}
          >
            {fns.find((f) => f.n === c.n)?.text.replace(/\^\((\w+)\)/g, "^$1")}
          </div>
        ))}
        {Array.from({ length: 21 }, (_, k) => (
          <div key={k} className="contents">
            <div className="border-b border-r border-casRule bg-casTabIdle px-[1cqw] py-[0.9cqw] text-right">{k}.</div>
            {cols.map((c) => (
              <div key={c.n} className="border-b border-r border-casRule px-[1cqw] py-[0.9cqw] text-right">
                {Number.isFinite(c.ys[k]) ? formatFloat(c.ys[k]!, 6) : "undef"}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function niceTicks(lo: number, hi: number, scl: number): number[] {
  if (!(scl > 0) || (hi - lo) / scl > 80) return [];
  const out: number[] = [];
  for (let t = Math.ceil(lo / scl) * scl; t <= hi; t += scl) if (Math.abs(t) > 1e-12) out.push(t);
  return out;
}

const trim = (v: number) => {
  const s = Number(v.toPrecision(3));
  return String(s);
};

/** Where an integral's value goes: just below the curve at the middle of the bounds. */
function areaLabelY(
  m: { fn: number; a: number; b: number },
  samples: Samples[],
  py: (y: number) => number,
  H: number,
): number {
  const s = samples.find((x) => x.n === m.fn);
  const mid = (m.a + m.b) / 2;
  if (!s) return py(0);
  let best = 0;
  let bestD = Infinity;
  s.xs.forEach((x, i) => {
    if (Math.abs(x - mid) < bestD && Number.isFinite(s.ys[i])) {
      bestD = Math.abs(x - mid);
      best = s.ys[i]!;
    }
  });
  return Math.min(H * 0.9, Math.max(py(0), py(best)));
}

/**
 * Where a relation's label goes: just right of the rightmost point of its
 * curve in the upper part of the window, or the top right when no curve
 * shows (a shaded region with its edge off screen). Stacked so labels don't
 * collide.
 */
function relLabelAt(grid: RelGrid | undefined, W: number, H: number, fs: number, k: number) {
  const fallback = { left: W * 0.62, top: fs * 0.6 + k * fs * 1.9 };
  if (!grid) return fallback;
  const { nx, ny, vals } = grid;
  for (let i = nx - 1; i >= 0; i--) {
    for (let j = ny; j >= Math.floor(ny * 0.45); j--) {
      const a = vals[j]?.[i];
      const b = vals[j]?.[i + 1];
      if (a !== undefined && b !== undefined && Number.isFinite(a) && Number.isFinite(b) && a <= 0 !== b <= 0) {
        const left = Math.min(((i + 1) / nx) * W + fs * 0.4, W * 0.62);
        const top = Math.max(2, (1 - j / ny) * H - fs * 2) + k * fs * 1.9;
        return { left, top };
      }
    }
  }
  return fallback;
}

/** A palette colour's red, green and blue. */
function rgb(colour: string): [number, number, number] {
  const n = parseInt(colour.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** What an entry line reports from the mouse: a click places the cursor, a drag selects. */
type EntryHandlers = { onCursor: (c: Cursor) => void; onSelect: (from: Cursor, to: Cursor) => void };

/**
 * The parametric entry line: x(t)= and y(t)= on two lines, then the t range
 * and step, as on the handheld. Tab and the arrows move between the five
 * fields; the one being edited shows the cursor.
 */
function ParametricEntry({ page, onCursor, onSelect }: { page: GraphsPage } & EntryHandlers) {
  const d = page.parDraft!;
  const n = page.editing!;
  const field = (i: number) =>
    i === d.field ? (
      <MathView
        row={page.edit.row}
        cursor={page.edit.cursor}
        selection={selection(page.edit)}
        onPick={onCursor}
        onSelect={onSelect}
        className={d.fresh && page.edit.row.length ? "bg-casSelectSoft" : undefined}
      />
    ) : (
      <MathView row={d.rows[i]!} />
    );
  return (
    <span className="flex flex-col gap-[0.8cqw]">
      <span className="inline-flex items-center">
        <MathView row={chars(`x${n}(t)=`)} />
        {field(0)}
      </span>
      <span className="inline-flex items-center">
        <MathView row={chars(`y${n}(t)=`)} />
        {field(1)}
      </span>
      <span className="inline-flex items-center text-[0.85em]">
        {field(2)}
        <MathView row={chars("≤t≤")} className="mx-[0.2em]" />
        {field(3)}
        <MathView row={chars("tstep=")} className="ml-[1.4em]" />
        {field(4)}
      </span>
    </span>
  );
}

/** The Diff Eq entry line: d1: y1′=f, the initial condition (x0, y10), and … for the settings. */
function DEEntry({ page, onCursor, onSelect, onSettings }: { page: GraphsPage; onSettings: () => void } & EntryHandlers) {
  const d = page.parDraft!;
  const n = page.editing!;
  const y = (page.des ?? []).find((q) => q.n === n)?.y ?? deYFree(page);
  const field = (i: number) =>
    i === d.field ? (
      <MathView
        row={page.edit.row}
        cursor={page.edit.cursor}
        selection={selection(page.edit)}
        onPick={onCursor}
        onSelect={onSelect}
        className={d.fresh && page.edit.row.length ? "bg-casSelectSoft" : undefined}
      />
    ) : (
      <MathView row={d.rows[i]!} />
    );
  // An empty field shows as a box to type in.
  const box = (i: number) =>
    i !== d.field && !d.rows[i]!.length ? (
      <span className="inline-block h-[1em] w-[1.6em] border border-casRule align-middle" />
    ) : (
      field(i)
    );
  return (
    <span className="flex flex-1 flex-col gap-[0.8cqw]">
      <span className="inline-flex items-center">
        <MathView row={chars(`d${n}: y${y}'=`)} />
        {field(0)}
        <button
          type="button"
          aria-label="Differential Equation settings"
          onClick={onSettings}
          className="ml-auto border border-casRule px-[0.5em] font-casui text-[0.8em] leading-tight hover:bg-casRowAlt"
        >
          …
        </button>
      </span>
      <span className="inline-flex items-center text-[0.85em]">
        <MathView row={chars(`(x0,y${y}0): (`)} />
        {box(1)}
        <MathView row={chars(",")} className="mx-[0.2em]" />
        {box(2)}
        <MathView row={chars(")")} />
      </span>
    </span>
  );
}

/** The y a new Diff Eq takes, for the entry line before it's plotted. */
function deYFree(p: GraphsPage): number {
  const used = new Set([...(p.parametrics ?? []).map((c) => c.n), ...(p.des ?? []).map((d) => d.y)]);
  let y = 1;
  while (used.has(y)) y++;
  return y;
}

/** A slider's right-click menu, in the handheld's menu style and order. */
function SliderMenu({
  slider,
  at,
  fs,
  onPick,
  onClose,
}: {
  slider: import("../state/document").Slider | undefined;
  at: { x: number; y: number };
  fs: number;
  onPick: (action: "move" | "settings" | "animate" | "minimize" | "delete") => void;
  onClose: () => void;
}) {
  if (!slider) return null;
  const items: [string, "move" | "settings" | "animate" | "minimize" | "delete"][] = [
    ["Move", "move"],
    ["Settings...", "settings"],
    [slider.minimized ? "Maximize" : "Minimize", "minimize"],
    [slider.animating ? "Stop Animate" : "Animate", "animate"],
    ["Delete", "delete"],
  ];
  return (
    <div className="absolute inset-0" onPointerDown={(e) => (e.stopPropagation(), onClose())}>
      <div
        role="menu"
        className="absolute border border-casRule bg-casScreen font-casui"
        style={{ left: at.x, top: at.y, fontSize: fs * 0.9 }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {items.map(([label, action], i) => (
          <button
            key={action}
            type="button"
            tabIndex={-1}
            role="menuitem"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPick(action)}
            className="flex w-full items-center gap-[0.6em] whitespace-nowrap px-[0.6em] py-[0.25em] text-left hover:bg-casSelect hover:text-casScreen"
          >
            <span>{i + 1}</span>
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Where a parametric curve's label goes: right of its rightmost point in the upper part of the window. */
function parLabelAt(p: ParSamples | undefined, w: GraphWindow, W: number, H: number, fs: number, k: number) {
  const fallback = { left: W * 0.62, top: fs * 0.6 + k * fs * 3.6 };
  if (!p) return fallback;
  let best: [number, number] | null = null;
  const mid = w.ymin + 0.45 * (w.ymax - w.ymin);
  for (const [x, y] of p.pts)
    if (Number.isFinite(x) && Number.isFinite(y) && x < w.xmax && y > mid && y < w.ymax && (!best || x > best[0]))
      best = [x, y];
  if (!best) return fallback;
  const left = Math.min(((best[0] - w.xmin) / (w.xmax - w.xmin)) * W + fs * 0.4, W * 0.62);
  const top = Math.max(2, ((w.ymax - best[1]) / (w.ymax - w.ymin)) * H - fs * 1.6) + k * fs * 1.9;
  return { left, top };
}

/** Does a relation hold where left − right is v? */
function holds(op: GraphRelation["op"], v: number): boolean {
  switch (op) {
    case "<":
      return v < 0;
    case ">":
      return v > 0;
    case "≤":
      return v <= 0;
    case "≥":
      return v >= 0;
    case "≠":
      return v !== 0;
    default:
      return false;
  }
}

/**
 * A relation on the canvas: an inequality's region shaded in its colour,
 * then the edge where left = right, traced cell by cell (marching squares).
 * The edge is solid for =, ≤ and ≥, dashed for <, > and ≠, as on the handheld.
 */
function drawRelation(
  g: CanvasRenderingContext2D,
  W: number,
  H: number,
  grid: RelGrid,
  rel: GraphRelation,
  colour: string,
) {
  const { nx, ny, vals, w } = grid;
  const px = (x: number) => ((x - w.xmin) / (w.xmax - w.xmin)) * W;
  const py = (y: number) => ((w.ymax - y) / (w.ymax - w.ymin)) * H;
  const X = (i: number) => w.xmin + (i / nx) * (w.xmax - w.xmin);
  const Y = (j: number) => w.ymin + (j / ny) * (w.ymax - w.ymin);
  if (rel.op !== "=") {
    // One pixel per grid cell, scaled up with smoothing: a soft edge rather
    // than a staircase.
    const off = document.createElement("canvas");
    off.width = nx;
    off.height = ny;
    const o = off.getContext("2d");
    if (o) {
      const img = o.createImageData(nx, ny);
      const [r, gr, b] = rgb(colour);
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const c = [vals[j]?.[i], vals[j]?.[i + 1], vals[j + 1]?.[i], vals[j + 1]?.[i + 1]].filter(
            (v): v is number => v !== undefined && Number.isFinite(v),
          );
          if (!c.length || !holds(rel.op, c.reduce((s, v) => s + v, 0) / c.length)) continue;
          const k = ((ny - 1 - j) * nx + i) * 4;
          img.data[k] = r;
          img.data[k + 1] = gr;
          img.data[k + 2] = b;
          img.data[k + 3] = 46;
        }
      o.putImageData(img, 0, 0);
      g.imageSmoothingEnabled = true;
      g.drawImage(off, 0, 0, W, H);
    }
  }
  g.strokeStyle = colour;
  g.lineWidth = Math.max(1.2, W * 0.004);
  // The edge is drawn in small pieces, one per cell, so a dash pattern would
  // restart in each; dash by position on screen instead.
  const dashed = rel.op === "<" || rel.op === ">" || rel.op === "≠";
  const dash = Math.max(6, W * 0.014);
  g.beginPath();
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const v00 = vals[j]?.[i];
      const v10 = vals[j]?.[i + 1];
      const v01 = vals[j + 1]?.[i];
      const v11 = vals[j + 1]?.[i + 1];
      if ([v00, v10, v01, v11].some((v) => v === undefined || !Number.isFinite(v))) continue;
      const a = v00!,
        b = v10!,
        c = v01!,
        d = v11!;
      const pts: [number, number][] = [];
      const edge = (p: number, q: number, x0: number, y0: number, x1: number, y1: number) => {
        if (p <= 0 === q <= 0) return;
        const t = p / (p - q);
        pts.push([px(x0 + t * (x1 - x0)), py(y0 + t * (y1 - y0))]);
      };
      edge(a, b, X(i), Y(j), X(i + 1), Y(j));
      edge(b, d, X(i + 1), Y(j), X(i + 1), Y(j + 1));
      edge(d, c, X(i + 1), Y(j + 1), X(i), Y(j + 1));
      edge(c, a, X(i), Y(j + 1), X(i), Y(j));
      // A jump across an asymptote (1/x = y) isn't a crossing: skip cells
      // whose values are huge and of opposite sign.
      const span = Math.max(Math.abs(a), Math.abs(b), Math.abs(c), Math.abs(d));
      if (span > 1e6 * (Math.abs(w.xmax - w.xmin) + Math.abs(w.ymax - w.ymin))) continue;
      for (let k = 0; k + 1 < pts.length; k += 2) {
        const [x0, y0] = pts[k]!;
        const [x1, y1] = pts[k + 1]!;
        if (dashed && (Math.floor((x0 + x1) / 2 / dash) + Math.floor((y0 + y1) / 2 / dash)) % 2) continue;
        g.moveTo(x0, y0);
        g.lineTo(x1, y1);
      }
    }
  g.stroke();
}

function draw(
  g: CanvasRenderingContext2D,
  W: number,
  H: number,
  SW: number,
  page: GraphsPage,
  samples: Samples[],
  toolY: number,
  grids: RelGrid[],
  pars: ParSamples[],
  field: SlopeField | null,
  solutions: { n: number; pts: [number, number][] }[],
) {
  const w: GraphWindow = page.window;
  const px = (x: number) => ((x - w.xmin) / (w.xmax - w.xmin)) * W;
  const py = (y: number) => ((w.ymax - y) / (w.ymax - w.ymin)) * H;
  g.fillStyle = palette.casScreen;
  g.fillRect(0, 0, W, H);
  const fs = Math.max(8, SW * 0.025);

  // Grid.
  if (page.grid !== "none") {
    g.fillStyle = palette.casRule;
    g.strokeStyle = palette.casRule;
    g.lineWidth = 0.6;
    for (const x of niceTicks(w.xmin, w.xmax, w.xscl))
      for (const y of niceTicks(w.ymin, w.ymax, w.yscl)) {
        if (page.grid === "dot") g.fillRect(px(x) - 0.6, py(y) - 0.6, 1.2, 1.2);
      }
    if (page.grid === "line") {
      g.beginPath();
      for (const x of niceTicks(w.xmin, w.xmax, w.xscl)) {
        g.moveTo(px(x), 0);
        g.lineTo(px(x), H);
      }
      for (const y of niceTicks(w.ymin, w.ymax, w.yscl)) {
        g.moveTo(0, py(y));
        g.lineTo(W, py(y));
      }
      g.stroke();
    }
  }

  // Integral shading under the curve.
  for (const m of page.marks) {
    if (m.kind !== "area") continue;
    const s = samples.find((x) => x.n === m.fn);
    if (!s) continue;
    g.fillStyle = palette.casShade;
    g.beginPath();
    g.moveTo(px(m.a), py(0));
    s.xs.forEach((x, i) => {
      const y = s.ys[i]!;
      if (x >= m.a && x <= m.b && Number.isFinite(y)) g.lineTo(px(x), py(y));
    });
    g.lineTo(px(m.b), py(0));
    g.closePath();
    g.fill();
  }

  // A slope field: a short grey segment at the centre of each cell, at the
  // slope's angle on screen, all the same length.
  if (field) {
    const cw = W / field.res;
    const ch = H / field.res;
    const half = Math.min(cw, ch) * 0.36;
    const kx = W / (w.xmax - w.xmin);
    const ky = H / (w.ymax - w.ymin);
    g.strokeStyle = palette.casDim;
    g.lineWidth = Math.max(1, W * 0.0024);
    g.beginPath();
    field.slopes.forEach((row, j) =>
      row.forEach((m, i) => {
        if (!Number.isFinite(m)) return;
        const a = Math.atan2(m * ky, kx);
        const [cx, cy] = [(i + 0.5) * cw, H - (j + 0.5) * ch];
        g.moveTo(cx - half * Math.cos(a), cy + half * Math.sin(a));
        g.lineTo(cx + half * Math.cos(a), cy - half * Math.sin(a));
      }),
    );
    g.stroke();
  }

  // Relations go under the axes, as shading does on the handheld.
  for (const grid of grids) {
    const rel = (page.relations ?? []).find((r) => r.n === grid.n);
    if (rel) drawRelation(g, W, H, grid, rel, relColour(page, rel.n));
  }

  // Axes, a tick per scale unit, the window's end values and the axis names.
  if (page.axes) {
    g.strokeStyle = palette.casInk;
    g.fillStyle = palette.casInk;
    g.lineWidth = 1;
    const ax = Math.min(Math.max(py(0), 0), H);
    const ay = Math.min(Math.max(px(0), 0), W);
    g.beginPath();
    g.moveTo(0, ax);
    g.lineTo(W, ax);
    g.moveTo(ay, 0);
    g.lineTo(ay, H);
    const tick = Math.max(2.5, W * 0.008);
    for (const x of niceTicks(w.xmin, w.xmax, w.xscl)) {
      g.moveTo(px(x), ax - tick);
      g.lineTo(px(x), ax + tick);
    }
    for (const y of niceTicks(w.ymin, w.ymax, w.yscl)) {
      g.moveTo(ay - tick, py(y));
      g.lineTo(ay + tick, py(y));
    }
    g.stroke();
    // Arrowheads at the positive ends.
    const ah = Math.max(3, W * 0.012);
    g.beginPath();
    g.moveTo(W, ax);
    g.lineTo(W - ah * 1.6, ax - ah * 0.8);
    g.lineTo(W - ah * 1.6, ax + ah * 0.8);
    g.closePath();
    g.moveTo(ay, 0);
    g.lineTo(ay - ah * 0.8, ah * 1.6);
    g.lineTo(ay + ah * 0.8, ah * 1.6);
    g.closePath();
    g.fill();
    // End values: x below the axis at each end, y to the left of the axis.
    g.font = `${fs}px Arial, Helvetica, sans-serif`;
    g.textBaseline = "top";
    g.textAlign = "left";
    g.fillText(trim(w.xmin), 2, ax + tick + 1);
    g.textAlign = "right";
    g.fillText(trim(w.xmax), W - 2, ax + tick + 1);
    g.fillText(trim(w.ymax), ay - tick - 2, 2);
    g.textBaseline = "bottom";
    g.fillText(trim(w.ymin), ay - tick - 2, H - 2);
    // The first tick on each positive half is numbered, as on the handheld.
    g.textBaseline = "top";
    g.textAlign = "center";
    if (w.xscl > 0 && w.xscl < w.xmax) g.fillText(trim(w.xscl), px(w.xscl), ax + tick + 1);
    g.textAlign = "right";
    g.textBaseline = "middle";
    if (w.yscl > 0 && w.yscl < w.ymax) g.fillText(trim(w.yscl), ay - tick - 2, py(w.yscl));
    g.font = `${fs * 1.05}px Arial, Helvetica, sans-serif`;
    g.textAlign = "right";
    g.textBaseline = "bottom";
    g.fillText("x", W - 3, ax - tick);
    g.textAlign = "left";
    g.textBaseline = "top";
    g.fillText("y", ay + tick + 2, 1);
  }

  // Curves, broken at gaps and at jumps across an asymptote.
  // An Analyze Graph tool's graph is drawn bolder, so it's clear which one it searches.
  const searched = page.tool?.kind === "bounds" && samples.length > 1 ? page.tool.fn : undefined;
  for (const s of samples) {
    g.strokeStyle = curveColour(s.n);
    g.lineWidth = Math.max(1.2, W * 0.004) * (s.n === searched ? 2 : 1);
    g.beginPath();
    let pen = false;
    for (let i = 0; i < s.xs.length; i++) {
      const y = s.ys[i]!;
      if (!Number.isFinite(y)) {
        pen = false;
        continue;
      }
      const prev = s.ys[i - 1];
      const jump = prev !== undefined && Number.isFinite(prev) && Math.abs(py(y) - py(prev)) > H * 1.5;
      const X = px(s.xs[i]!);
      const Y = Math.max(-H, Math.min(2 * H, py(y)));
      if (!pen || jump) g.moveTo(X, Y);
      else g.lineTo(X, Y);
      pen = true;
    }
    g.stroke();
  }

  // Parametric curves: the points at each t step, joined.
  for (const p of pars) {
    g.strokeStyle = parColour(page, p.n);
    g.lineWidth = Math.max(1.2, W * 0.004);
    g.beginPath();
    let pen = false;
    for (const [x, y] of p.pts) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        pen = false;
        continue;
      }
      const X = px(x);
      const Y = Math.max(-H, Math.min(2 * H, py(y)));
      if (pen) g.lineTo(X, Y);
      else g.moveTo(X, Y);
      pen = true;
    }
    g.stroke();
  }

  // Diff Eq solutions through their initial conditions, with the starting point marked.
  for (const sol of solutions) {
    const de = (page.des ?? []).find((d) => d.n === sol.n);
    g.strokeStyle = g.fillStyle = deColour(page, sol.n);
    g.lineWidth = Math.max(1.2, W * 0.004);
    g.beginPath();
    sol.pts.forEach(([x, y], k) => {
      const [X, Y] = [px(x), Math.max(-H, Math.min(2 * H, py(y)))];
      if (k) g.lineTo(X, Y);
      else g.moveTo(X, Y);
    });
    g.stroke();
    if (de?.x0 !== undefined && de.y0 !== undefined) {
      g.beginPath();
      g.arc(px(de.x0), py(de.y0), Math.max(2.5, SW * 0.007), 0, Math.PI * 2);
      g.fill();
    }
  }

  // Analyze Graph points, and an integral's bounds: black, as on the handheld.
  g.fillStyle = palette.casInk;
  g.strokeStyle = palette.casInk;
  g.lineWidth = 1;
  const dot = (x: number, y: number) => {
    g.beginPath();
    g.arc(x, y, Math.max(2.5, SW * 0.007), 0, Math.PI * 2);
    g.fill();
  };
  for (const m of page.marks) {
    if (m.kind === "point") dot(px(m.x), py(m.y));
    else {
      const s = samples.find((x) => x.n === m.fn);
      for (const b of [m.a, m.b]) {
        const i = s ? s.xs.reduce((best, x, k) => (Math.abs(x - b) < Math.abs(s.xs[best]! - b) ? k : best), 0) : -1;
        const y = s && i >= 0 ? s.ys[i]! : 0;
        if (Number.isFinite(y)) {
          g.beginPath();
          g.moveTo(px(b), py(0));
          g.lineTo(px(b), py(y));
          g.stroke();
        }
        dot(px(b), py(0));
      }
    }
  }
  void toolY;
}
