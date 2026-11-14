// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 VCE Hub. Part of the /cas calculator: https://github.com/vcehub/cas
import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "@/shared/lib/utils";
import type { Key } from "../keys";
import { calculatorMenu } from "../menus/calculator-menu";
import { CellGrid, gridMove, PALETTE, PALETTE_COLS, TEMPLATE_CELLS, type GridCell } from "../menus/palette";
import type { MenuAction, MenuItem, TemplateId } from "../menus/types";
import { CATALOG, catalogInsert } from "./commands";

/**
 * The catalog: numbered tabs across the top
 * (1 the A–Z list, 4 symbols, 5 templates; the others aren't built here),
 * the list, a Wizards On box, and a line saying how to call the highlighted
 * command. Number keys change tab; a letter jumps to the commands starting
 * with it; Enter inserts.
 */
export type CatalogState = { tab: number; index: number; symbol: number; template: number; wizards: boolean };

export const openCatalog = (tab = 1): CatalogState => ({ tab, index: 0, symbol: 0, template: 0, wizards: false });

type Wizard = Extract<MenuAction, { kind: "wizard" }>;

/** Commands that also have a dialog, from the Calculator menu: normCdf → its wizard. */
const WIZARDS: Map<string, Wizard> = (() => {
  const out = new Map<string, Wizard>();
  const walk = (items: MenuItem[]) => {
    for (const it of items) {
      if (it.items) walk(it.items);
      const a = it.action;
      if (a?.kind === "wizard") {
        const name = /^([A-Za-z]+)\(/.exec(a.build)?.[1];
        if (name) out.set(`${name}(`, a);
      }
    }
  };
  walk(calculatorMenu);
  return out;
})();

const SYMBOLS = [
  "≠",
  "≤",
  "≥",
  "∞",
  "°",
  "′",
  "″",
  "∠",
  "→",
  "θ",
  "π",
  "ℯ",
  "i",
  "!",
  "%",
  "√",
  "Σ",
  "Π",
  "|",
  "ᵀ",
  "±",
  "α",
  "β",
  "λ",
  "μ",
  "σ",
  "Δ",
  "@",
  "_",
];
const SYMBOL_CELLS: GridCell[] = SYMBOLS.map((c) => ({
  label: c,
  glyph: <span className="text-[4.4cqw]">{c}</span>,
  enabled: true,
}));
const SYMBOL_COLS = 10;

const TABS: { n: number; glyph: ReactNode; label: string; built: boolean }[] = [
  { n: 1, glyph: "A–Z", label: "Commands A to Z", built: true },
  { n: 2, glyph: "∫Σ", label: "Maths expert", built: false },
  { n: 3, glyph: "°C", label: "Units", built: false },
  { n: 4, glyph: "∞β°", label: "Symbols", built: true },
  { n: 5, glyph: "{▢", label: "Templates", built: true },
  { n: 6, glyph: "Lib", label: "Libraries", built: false },
];

const sortKey = (n: string) => n.replace(/^[▶Δ]/, "").toLowerCase();

export type CatalogResult = { state: CatalogState | null; insert?: string; template?: TemplateId; wizard?: Wizard };

export function catalogKeyPress(s: CatalogState, key: Key): CatalogResult {
  if (key.k === "esc") return { state: null };
  if (key.k === "char" && /^[1-6]$/.test(key.c)) return { state: { ...s, tab: Number(key.c) } };
  if (s.tab === 1) {
    switch (key.k) {
      case "up":
        return { state: { ...s, index: Math.max(0, s.index - 1) } };
      case "down":
        return { state: { ...s, index: Math.min(CATALOG.length - 1, s.index + 1) } };
      case "left":
      case "right":
        return { state: { ...s, tab: key.k === "right" ? 2 : 6 } };
      case "char": {
        // A letter jumps to the next command starting with it, wrapping round.
        const c = key.c.toLowerCase();
        if (!/^[a-z]$/.test(c)) return { state: s };
        for (let k = 1; k <= CATALOG.length; k++) {
          const i = (s.index + k) % CATALOG.length;
          if (sortKey(CATALOG[i]!.name).startsWith(c)) return { state: { ...s, index: i } };
        }
        return { state: s };
      }
      case "enter": {
        const e = CATALOG[s.index];
        if (!e?.syntax) return { state: s };
        const wizard = s.wizards ? WIZARDS.get(e.name) : undefined;
        return wizard ? { state: null, wizard } : { state: null, insert: catalogInsert(e) };
      }
      default:
        return { state: s };
    }
  }
  if (s.tab === 4) {
    const r = gridMove(s.symbol, key, SYMBOLS.length, SYMBOL_COLS);
    if (r === "esc") return { state: null };
    if (r === "enter") return { state: null, insert: SYMBOLS[s.symbol] };
    return { state: { ...s, symbol: r } };
  }
  if (s.tab === 5) {
    const r = gridMove(s.template, key, PALETTE.length, PALETTE_COLS);
    if (r === "esc") return { state: null };
    if (r === "enter") {
      const id = PALETTE[s.template]?.id;
      return id ? { state: null, template: id } : { state: s };
    }
    return { state: { ...s, template: r } };
  }
  if (key.k === "left" || key.k === "right")
    return { state: { ...s, tab: ((s.tab - 1 + (key.k === "right" ? 1 : 5)) % 6) + 1 } };
  return { state: s };
}

/** What a screen reader hears for the catalog's current position. */
export function catalogSaid(s: CatalogState): string {
  const tab = TABS[s.tab - 1]!;
  if (s.tab === 1) {
    const e = CATALOG[s.index];
    return e ? `${e.name}${e.syntax ? `. ${e.syntax}` : ", not available"}` : tab.label;
  }
  if (s.tab === 4) return `Symbols. ${SYMBOLS[s.symbol] ?? ""}`;
  if (s.tab === 5) return `Templates. ${PALETTE[s.template]?.label ?? ""}`;
  return `${tab.label}, not available`;
}

export function CatalogOverlay({
  state,
  onChange,
  onKey,
  onResult,
}: {
  state: CatalogState;
  onChange: (s: CatalogState) => void;
  onKey: (k: Key) => void;
  onResult: (r: CatalogResult) => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  // Keep the highlighted command in view.
  useEffect(() => {
    const box = list.current;
    const row = box?.children[state.index] as HTMLElement | undefined;
    if (!box || !row) return;
    if (row.offsetTop < box.scrollTop) box.scrollTop = row.offsetTop;
    else if (row.offsetTop + row.offsetHeight > box.scrollTop + box.clientHeight)
      box.scrollTop = row.offsetTop + row.offsetHeight - box.clientHeight;
  }, [state.index, state.tab]);

  const entry = CATALOG[state.index];
  return (
    <div
      role="dialog"
      aria-label="Catalog"
      className="absolute inset-0 flex flex-col bg-casScreen font-casui text-[3.9cqw]"
    >
      <div role="tablist" className="flex h-[10cqw] shrink-0 items-end gap-[0.4cqw] bg-casRowAlt pl-[1.2cqw]">
        {TABS.map((t) => (
          <button
            key={t.n}
            type="button"
            tabIndex={-1}
            role="tab"
            aria-selected={t.n === state.tab}
            aria-label={t.label}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onChange({ ...state, tab: t.n })}
            className={cn(
              "flex h-[8.4cqw] items-center gap-[1cqw] px-[1.8cqw]",
              t.n === state.tab ? "bg-casScreen" : "bg-casTabIdle",
              t.built ? "text-casInk" : "text-casDim",
            )}
          >
            <span>{t.n}</span>
            <span className="font-casmath text-[3.6cqw] text-casSelect">{t.glyph}</span>
          </button>
        ))}
      </div>

      {state.tab === 1 && (
        <div className="flex min-h-0 flex-1 flex-col px-[6cqw] pb-[1.4cqw] pt-[3.4cqw]">
          <div
            ref={list}
            role="listbox"
            aria-label="Commands"
            className="min-h-0 flex-1 overflow-y-auto border border-casDim [scrollbar-width:thin]"
          >
            {CATALOG.map((e, i) => (
              <button
                key={e.name}
                type="button"
                tabIndex={-1}
                role="option"
                aria-selected={i === state.index}
                aria-disabled={!e.syntax || undefined}
                onMouseDown={(ev) => ev.preventDefault()}
                onClick={() => (i === state.index ? onKey({ k: "enter" }) : onChange({ ...state, index: i }))}
                className={cn(
                  "flex h-[6.2cqw] w-full items-center justify-between px-[1.2cqw] text-left",
                  i === state.index ? "bg-casSelect text-casScreen" : e.syntax ? "text-casInk" : "text-casDim",
                )}
              >
                <span>{e.name}</span>
                {WIZARDS.has(e.name) && <WizardMark />}
              </button>
            ))}
          </div>
          <div className="flex h-[8cqw] shrink-0 items-center justify-end">
            <button
              type="button"
              tabIndex={-1}
              role="checkbox"
              aria-checked={state.wizards}
              onMouseDown={(ev) => ev.preventDefault()}
              onClick={() => onChange({ ...state, wizards: !state.wizards })}
              className="flex items-center gap-[1.4cqw]"
            >
              <span className="flex h-[4cqw] w-[4cqw] items-center justify-center border-[0.25cqw] border-casInk">
                {state.wizards && (
                  <svg aria-hidden viewBox="0 0 10 10" className="h-[3cqw] w-[3cqw]">
                    <path d="M1.5 5.5 L4 8 L8.5 2" fill="none" stroke="currentColor" strokeWidth="1.5" />
                  </svg>
                )}
              </span>
              <WizardMark />
              Wizards On
            </button>
          </div>
          <div className="flex h-[7.4cqw] shrink-0 items-center truncate border border-casDim px-[1.2cqw]">
            {entry?.syntax ?? "Not available here yet."}
          </div>
        </div>
      )}

      {state.tab === 4 && (
        <div className="flex flex-1 items-center justify-center">
          <CellGrid
            cells={SYMBOL_CELLS}
            cols={SYMBOL_COLS}
            index={state.symbol}
            label="Symbols"
            onPick={(i) => onResult({ state: null, insert: SYMBOLS[i] })}
          />
        </div>
      )}
      {state.tab === 5 && (
        <div className="flex flex-1 items-center justify-center">
          <CellGrid
            cells={TEMPLATE_CELLS}
            cols={PALETTE_COLS}
            index={state.template}
            label="Templates"
            onPick={(i) => {
              const id = PALETTE[i]?.id;
              if (id) onResult({ state: null, template: id });
            }}
          />
        </div>
      )}
      {(state.tab === 2 || state.tab === 3 || state.tab === 6) && (
        <div className="flex flex-1 items-center justify-center text-casLabel">Not available here yet.</div>
      )}
    </div>
  );
}

/** Marks a command that also has a dialog. Our own drawing. */
function WizardMark() {
  return (
    <svg aria-hidden viewBox="0 0 12 12" className="h-[3.4cqw] w-[3.4cqw] shrink-0">
      <path d="M2 10 L7 5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8.5 1 L9 3 L11 3.5 L9 4 L8.5 6 L8 4 L6 3.5 L8 3 Z" fill="currentColor" />
    </svg>
  );
}
