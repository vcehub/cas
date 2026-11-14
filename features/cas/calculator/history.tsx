// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 VCE Hub. Part of the /cas calculator: https://github.com/vcehub/cas
"use client";

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/shared/lib/utils";
import type { Cursor } from "../math/cursor";
import { selectBetween, selection, type EditState } from "../math/editor";
import { MathView, useCaretInView } from "../math/render";
import type { HistoryEntry } from "../state/document";

/** One → moves a too-wide part this fraction of the screen's width. */
const SCROLL_STEP = 0.5;

/**
 * Calculator history: one band per entry, alternating white and light grey,
 * input on the left and the result right-aligned, dropping to its own line
 * when the two don't fit side by side. A part wider than the screen stays
 * full size, left-aligned and cut off, with ▸ (and ◂ once scrolled) at the
 * edge; selected, → and ← scroll it, as on the handheld.
 */
export function HistoryRow({
  entry,
  index,
  selected,
  caret,
  scroll = 0,
  onPick,
  onCaret,
  onWarning,
}: {
  entry: HistoryEntry;
  index: number;
  selected?: "input" | "output";
  /** The caret in the selected part, after a click on it. */
  caret?: EditState;
  /** Steps the selected part has been scrolled. */
  scroll?: number;
  /** A double click pastes the input or the result into the entry line. */
  onPick?: (part: "input" | "output", paste: boolean) => void;
  /** A click puts the caret in the input or the result; a drag selects part of it. */
  onCaret?: (part: "input" | "output", caret: EditState) => void;
  /** A click on the ⚠ shows the warning. */
  onWarning?: () => void;
}) {
  const pick = (part: "input" | "output") => {
    const row = part === "input" ? entry.input : entry.output;
    const mine = selected === part && caret;
    return {
      row,
      onPick: (c: Cursor) => onCaret?.(part, { row, cursor: c }),
      onSelect: (a: Cursor, b: Cursor) => onCaret?.(part, selectBetween({ row, cursor: a }, a, b)),
      onDoubleClick: () => onPick?.(part, true),
      cursor: mine ? caret.cursor : undefined,
      selection: mine ? selection(caret) : null,
      // Picked whole with the arrows, the part is highlighted; with a caret in it, only the selected stretch is.
      className: cn(selected === part && !caret && "bg-casHistorySelect"),
    };
  };
  const band = index % 2 ? "bg-casScreen" : "bg-casRowAlt";
  const row = (
    <div
      // Lines too wide for the screen are shrunk to fit in a picture of it (capture.ts).
      data-cas-fit
      className={cn("flex flex-wrap items-center justify-between gap-x-[3cqw] px-[2cqw] py-[1.8cqw]", band, entry.warning && "min-w-0 flex-1")}
    >
      <Clipped scroll={selected === "input" ? scroll : 0} active={selected === "input"}>
        <MathView {...pick("input")} />
      </Clipped>
      {entry.error ? (
        <span className="ml-auto max-w-full font-casui text-[3.4cqw]">{entry.error}</span>
      ) : (
        <Clipped scroll={selected === "output" ? scroll : 0} active={selected === "output"} right>
          <MathView {...pick("output")} />
        </Clipped>
      )}
    </div>
  );
  if (!entry.warning) return row;
  // A warning moves the whole entry right of a ⚠, centred on the band, as on the handheld.
  return (
    <div className={cn("flex items-center", band)}>
      <button
        type="button"
        onClick={onWarning}
        aria-label={`Warning: ${entry.warning[0]}`}
        className="ml-[1.3cqw] w-[4.2cqw] shrink-0"
      >
        <WarningMark />
      </button>
      {row}
    </div>
  );
}

/** The handheld's ⚠: an amber triangle, dark outline, black "!". */
function WarningMark() {
  return (
    <svg viewBox="0 0 24 21" aria-hidden className="block w-full">
      <path d="M12 1.5 L22.5 19.5 H1.5 Z" strokeLinejoin="round" strokeWidth="1.6" className="fill-casWarn stroke-casInk" />
      <path d="M12 7.5 V13.5" strokeWidth="2.4" strokeLinecap="round" className="stroke-casInk" />
      <circle cx="12" cy="16.6" r="1.3" className="fill-casInk" />
    </svg>
  );
}

/**
 * A history part that may be wider than the screen: cut off at the edge with
 * ▸, scrolled by steps when selected. `right` keeps a part that fits
 * right-aligned (a result); a too-wide one starts at the left.
 */
function Clipped({ children, scroll, active, right }: { children: ReactNode; scroll: number; active: boolean; right?: boolean }) {
  const box = useRef<HTMLSpanElement>(null);
  const [m, setM] = useState({ wide: false, max: 0, step: 0 });
  useLayoutEffect(() => {
    const el = box.current;
    const row = el?.parentElement?.parentElement;
    if (!el || !row) return;
    const measure = () => {
      const style = getComputedStyle(row);
      const avail = row.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const width = (el.firstElementChild as HTMLElement | null)?.scrollWidth ?? 0;
      const step = Math.max(1, avail * SCROLL_STEP);
      const wide = width > avail + 1;
      setM({ wide, max: wide ? Math.ceil((width - avail) / step) : 0, step });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(row);
    return () => ro.disconnect();
  }, [children]);
  const at = Math.min(scroll, m.max);
  useLayoutEffect(() => {
    if (box.current) box.current.scrollLeft = at * m.step;
  }, [at, m.step]);
  // A caret in a too-wide part pulls it along.
  useCaretInView(box);
  const mark = "pointer-events-none absolute top-1/2 -translate-y-1/2 bg-inherit px-[0.6cqw] font-casui text-[3cqw]";
  return (
    <span className={cn("relative max-w-full bg-inherit", right && !m.wide && "ml-auto", m.wide && "w-full")}>
      <span ref={box} data-cas-max-scroll={active ? m.max : undefined} className="block overflow-hidden whitespace-nowrap">
        {children}
      </span>
      {m.wide && at < m.max && (
        <span aria-hidden className={cn(mark, "right-0")}>
          ▸
        </span>
      )}
      {m.wide && at > 0 && (
        <span aria-hidden className={cn(mark, "left-0")}>
          ◂
        </span>
      )}
    </span>
  );
}
