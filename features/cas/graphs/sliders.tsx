// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 VCE Hub. Part of the /cas calculator: https://github.com/vcehub/cas
import { useRef, type PointerEvent as ReactPointerEvent } from "react";
import { cn } from "@/shared/lib/utils";
import { formatFloat } from "../engine/format";
import { RENAME_OUT } from "../engine/translate";
import { parse, mapAst, type Ast } from "../math/ast";
import type { Slider } from "../state/document";

/**
 * Sliders on a Graphs page, drawn as the handheld draws them: "a =1." over a
 * track with a pointer for a handle and the minimum and maximum under its
 * ends; vertical, the pointer faces left and the scale sits beside it. The
 * slider in use is blue, the others grey. Drag or click the track to set
 * the value; the graph redraws as it changes. Right-click (or long-press)
 * for the slider's menu. Minimized, it's a pair of step buttons and
 * "a =1.". With no place of its own (Move) it takes the next one down the
 * left of the graph.
 */

/** The step a slider moves by: its own, or "auto", a nice number near a tenth of the range (1 on −5 to 5). */
export function sliderStep(s: Slider): number {
  if (s.step !== "auto" && s.step > 0) return s.step;
  const raw = (s.max - s.min) / 10;
  const p = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((k) => k * p).find((v) => v >= raw) ?? p;
}

/** The Display Digits choices; "Float 3" is the default. */
export const SLIDER_DIGITS = ["Auto", "Float", ...Array.from({ length: 12 }, (_, i) => `Float ${i + 1}`)];

/** A value as the slider prints it: its Display Digits, a true minus. Auto follows the document's Float 6 default. */
export function sliderText(s: Slider, v: number): string {
  const d = s.digits ?? "Float 3";
  const n = d === "Float" ? 12 : d === "Auto" ? 6 : Number(d.slice(6));
  return formatFloat(v, n).replace("-", "−");
}

/** Where a slider sits without a place of its own: down the left, three to a column. */
export function sliderPlace(s: Slider, index: number): { x: number; y: number } {
  return s.at ?? { x: 0.09 + Math.floor(index / 3) * 0.3, y: 0.25 + (index % 3) * 0.27 };
}

/** A value on the slider's step grid, inside its range. */
export function snap(s: Slider, v: number): number {
  const step = sliderStep(s);
  const k = Math.round((v - s.min) / step);
  return Number(Math.min(s.max, Math.max(s.min, s.min + k * step)).toPrecision(12));
}

/**
 * The variables in a definition with no value yet, which would get sliders:
 * every name but the curve's own variables (x, or x and y, or t), constants
 * and names already defined.
 */
export function freeVariables(
  texts: string[],
  bound: string[],
  defined: ReadonlySet<string>,
  functions: ReadonlyMap<string, { params: string[]; body: string }> = new Map(),
): string[] {
  const out = new Set<string>();
  const skip = new Set(["π", "ℯ", "i", "∞", "θ", "", "ans", "Ans"]);
  const seen = new Set<string>();
  const walk = (ast: Ast, own: ReadonlySet<string>): void => {
    mapAst(ast, (a) => {
      // A stored body has Giac's safe names (e_ for e).
      const name = a.k === "sym" ? (RENAME_OUT[a.name] ?? a.name) : "";
      if (a.k === "sym" && !skip.has(name) && !own.has(name) && !defined.has(name) && /^[A-Za-z]\w*$/.test(name)) out.add(name);
      // f1(x)=g(x) with g(x):=x/(x²+k): k is g's, and gets a slider too.
      const fn = a.k === "call" ? functions.get(a.f) : undefined;
      if (a.k === "call" && fn && !seen.has(a.f)) {
        seen.add(a.f);
        try {
          walk(parse(fn.body, { giac: true }), new Set(fn.params));
        } catch {
          // A body we can't read offers nothing.
        }
      }
      return a;
    });
  };
  for (const t of texts) {
    try {
      walk(parse(t), new Set(bound));
    } catch {
      // A definition that doesn't parse gets an error elsewhere.
    }
  }
  return [...out];
}

export function SliderView({
  slider,
  index,
  fs,
  size,
  active,
  onValue,
  onMenu,
}: {
  slider: Slider;
  index: number;
  fs: number;
  /** The graph area, which a slider's place is a fraction of. */
  size: { w: number; h: number };
  /** The slider last used, drawn in blue. */
  active: boolean;
  /** final: the drag or step has finished, so the value can be kept. */
  onValue: (v: number, final: boolean) => void;
  onMenu: (x: number, y: number) => void;
}) {
  const track = useRef<HTMLDivElement>(null);
  const s = slider;
  const frac = s.max > s.min ? (s.value - s.min) / (s.max - s.min) : 0;
  const place = sliderPlace(s, index);
  const valueAt = (e: ReactPointerEvent) => {
    const r = track.current!.getBoundingClientRect();
    const f = s.vertical ? 1 - (e.clientY - r.top) / r.height : (e.clientX - r.left) / r.width;
    return snap(s, s.min + Math.min(1, Math.max(0, f)) * (s.max - s.min));
  };
  const colour = active ? "text-casSelect" : "text-casLabel";
  const label = !s.hideName && (
    <span className="whitespace-nowrap leading-tight text-casLabel">
      <b className="font-casmath">{s.name}</b>
      <span className="font-casmono"> ={sliderText(s, s.value)}</span>
    </span>
  );
  const scale = (v: number) => <span className="font-casmono leading-none text-casLabel">{sliderText(s, v)}</span>;
  const step = (dir: 1 | -1) => (
    <button
      type="button"
      tabIndex={-1}
      aria-label={`${s.name} ${dir > 0 ? "up" : "down"}`}
      disabled={dir > 0 ? s.value >= s.max : s.value <= s.min}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onValue(snap(s, s.value + dir * sliderStep(s)), true)}
      className="flex h-[1.3em] w-[1.6em] items-center justify-center border border-casRule bg-casRowAlt text-casLabel disabled:text-casRule"
    >
      <svg aria-hidden viewBox="0 0 6 10" className="h-[0.6em]">
        <path d={dir > 0 ? "M1 1 L5 5 L1 9" : "M5 1 L1 5 L5 9"} fill="none" stroke="currentColor" strokeWidth={1.2} />
      </svg>
    </button>
  );
  const bar = (
    <div
      ref={track}
      onPointerDown={(e) => {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        onValue(valueAt(e), false);
      }}
      onPointerMove={(e) => {
        if (e.buttons) onValue(valueAt(e), false);
      }}
      onPointerUp={(e) => onValue(valueAt(e), true)}
      className={cn("relative shrink-0 cursor-pointer touch-none", colour, s.vertical ? "h-[6em] w-[1.6em]" : "h-[1.6em] w-[7.5em]")}
    >
      <span
        className={cn(
          "absolute bg-current",
          s.vertical ? "inset-y-0 left-1/2 w-[0.15em] -translate-x-1/2" : "inset-x-0 top-1/2 h-[0.15em] -translate-y-1/2",
        )}
      />
      {/* The handle: a pointer onto the track, down from above or left from the right. */}
      <svg
        aria-hidden
        viewBox="0 0 10 12"
        className={cn("absolute h-[1.1em] w-[0.9em]", s.vertical ? "-translate-y-1/2 rotate-90" : "-translate-x-1/2")}
        style={s.vertical ? { left: "50%", top: `${(1 - frac) * 100}%` } : { left: `${frac * 100}%`, top: "0.1em" }}
      >
        <path d="M1 0 H9 V8 L5 12 L1 8 Z" fill="currentColor" />
      </svg>
    </div>
  );

  return (
    <div
      role="group"
      aria-label={`Slider ${s.name}, ${sliderText(s, s.value)}`}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e.clientX, e.clientY);
      }}
      className="absolute flex select-none flex-col items-start font-casui"
      style={{ left: place.x * size.w, top: place.y * size.h, fontSize: fs * 0.85 }}
    >
      {s.minimized ? (
        <div className="flex items-center gap-[0.4em]">
          <div className="flex">
            {step(-1)}
            {step(1)}
          </div>
          {label}
        </div>
      ) : s.vertical ? (
        <>
          {label}
          <div className="mt-[0.3em] flex">
            {!s.hideScale && (
              <div className="flex flex-col justify-between py-[0.1em] text-right">
                {scale(s.max)}
                {scale(s.min)}
              </div>
            )}
            {bar}
          </div>
        </>
      ) : (
        <>
          {label}
          {bar}
          {!s.hideScale && (
            <div className="-ml-[0.6em] flex w-[8.4em] justify-between">
              {scale(s.min)}
              {scale(s.max)}
            </div>
          )}
        </>
      )}
    </div>
  );
}
