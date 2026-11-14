// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 VCE Hub. Part of the /cas calculator: https://github.com/vcehub/cas
import { useEffect, useRef } from "react";
import type { Cursor } from "../math/cursor";
import { selection, type EditState } from "../math/editor";
import { followDrag, MathView, useCaretInView } from "../math/render";
import type { CalculatorPage } from "../state/document";
import { HistoryRow } from "./history";

/**
 * The Calculator page: history bands above the entry line, which follows the
 * last entry and scrolls with it, as on the handheld.
 */
export function CalculatorApp({
  page,
  onPick,
  onCaret,
  onWarning,
  onCursor,
  onSelect,
}: {
  page: CalculatorPage;
  onPick: (entry: number, part: "input" | "output", paste: boolean) => void;
  /** A click on a history line put the caret in it (or a drag selected part of it). */
  onCaret: (entry: number, part: "input" | "output", caret: EditState) => void;
  /** The ⚠ beside an entry was clicked: show its message. */
  onWarning: (entry: number) => void;
  onCursor: (c: Cursor) => void;
  /** A drag across the entry line selects that stretch of it. */
  onSelect: (from: Cursor, to: Cursor) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const selected = useRef<HTMLDivElement>(null);
  const entry = useRef<HTMLDivElement>(null);
  useCaretInView(entry);

  useEffect(() => {
    const el = scroller.current;
    if (el && !page.sel) el.scrollTop = el.scrollHeight;
  }, [page.history.length, page.edit, page.sel]);

  useEffect(() => {
    selected.current?.scrollIntoView({ block: "nearest" });
  }, [page.sel]);

  return (
    <div className="absolute inset-0 flex">
      <div ref={scroller} className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden text-[4.4cqw] [scrollbar-width:none]">
        {page.history.map((e, i) => (
          <div key={e.id} ref={page.sel?.entry === i ? selected : undefined}>
            <HistoryRow
              entry={e}
              index={i}
              selected={page.sel?.entry === i ? page.sel.part : undefined}
              caret={page.sel?.entry === i ? page.sel.caret : undefined}
              scroll={page.sel?.entry === i ? (page.sel.scroll ?? 0) : 0}
              onPick={(part, paste) => onPick(i, part, paste)}
              onCaret={(part, caret) => onCaret(i, part, caret)}
              onWarning={() => onWarning(i)}
            />
          </div>
        ))}
        {/* The whole entry band takes clicks: past the end puts the cursor at the end, and a drag from there selects back. */}
        <div
          ref={entry}
          className="cursor-text overflow-x-auto px-[2cqw] py-[2.2cqw] [scrollbar-width:none]"
          onMouseDown={(e) => {
            const line = e.currentTarget.firstElementChild;
            if (e.target !== e.currentTarget || !(line instanceof HTMLElement)) return;
            const end = { path: [], index: page.edit.row.length };
            onCursor(end);
            e.preventDefault();
            followDrag(line, page.edit.row, end, onSelect);
          }}
        >
          <MathView
            row={page.edit.row}
            cursor={page.sel ? undefined : page.edit.cursor}
            selection={page.sel ? null : selection(page.edit)}
            onPick={onCursor}
            onSelect={onSelect}
          />
        </div>
      </div>
      <ScrollRail />
    </div>
  );
}

/** The thin rail with arrows down the right edge of the handheld's apps. */
function ScrollRail() {
  return (
    <div aria-hidden className="flex w-[2.2cqw] shrink-0 flex-col items-center justify-between bg-casScreen py-[0.6cqw] text-casDim">
      <svg viewBox="0 0 10 6" className="w-[1.4cqw]">
        <path d="M0 6 L5 0 L10 6 Z" fill="currentColor" />
      </svg>
      <svg viewBox="0 0 10 6" className="w-[1.4cqw]">
        <path d="M0 0 L5 6 L10 0 Z" fill="currentColor" />
      </svg>
    </div>
  );
}
