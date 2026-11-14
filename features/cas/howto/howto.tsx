// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 VCE Hub. Part of the /cas calculator: https://github.com/vcehub/cas
"use client";

import { Fragment, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Button } from "@/shared/ui/button";
import { cn } from "@/shared/lib/utils";
import { CATALOG, catalogInsert } from "../catalog/commands";
import { howToById, HOWTOS } from "./entries";
import { ExampleScreen } from "./example";
import { Keycap } from "./keycap";
import { syntaxOf, wayLine } from "./paths";
import { normalise, searchHowTo } from "./search";
import { GROUPS, SUBJECTS, type HowTo, type Subject } from "./types";

type Props = {
  /** Do it on the calculator: walk the menu, land the command. */
  onShow: (entry: HowTo) => void;
  /** Put text on the entry line. */
  onPaste: (text: string) => void;
};

const SUBJECT_KEY = "cas-howto-subject";
const readSubject = (): Subject | null => {
  try {
    const v = localStorage.getItem(SUBJECT_KEY);
    return v === "methods" || v === "specialist" || v === "general" ? v : null;
  } catch {
    return null;
  }
};

/**
 * "How do I…": a search box over the calculator. Typing lists tasks; the
 * highlighted one shows beside the list on wide screens, in place of it on
 * narrow ones, and fills the screen on phones. Show me does it on the
 * calculator below.
 *
 * Keys: Ctrl+G or F1 from anywhere, / from outside the calculator; ▲ ▼ through
 * the list, Enter shows it, Esc steps back.
 */
export function HowToBar({ onShow, onPaste }: Props) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  // Narrow screens show the card in place of the list.
  const [reading, setReading] = useState(false);
  const [subject, setSubject] = useState<Subject | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();

  useEffect(() => setSubject(readSubject()), []);

  // The examples fit beside a desktop heading; a phone gets the question alone.
  const [placeholder, setPlaceholder] = useState("How do I…");
  useEffect(() => {
    if (window.matchMedia("(min-width: 601px)").matches) setPlaceholder("How do I… solve, integrate, graph");
  }, []);

  // /cas?how=solve-on-a-domain opens on that card.
  useEffect(() => {
    const how = new URLSearchParams(window.location.search).get("how");
    if (how && howToById(how)) {
      setActiveId(how);
      setReading(true);
      setOpen(true);
    }
  }, []);

  // Ctrl+G or F1 from anywhere; / when focus isn't in the calculator or a field.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const inField = t?.closest("input, textarea, select, [contenteditable], [role=application]");
      const ctrlG = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "g";
      if (ctrlG || e.key === "F1" || (e.key === "/" && !inField && !e.ctrlKey && !e.metaKey)) {
        e.preventDefault();
        input.current?.focus();
        input.current?.select();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // A click outside closes it.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const results = useMemo(() => (query.trim() ? searchHowTo(HOWTOS, query, subject) : null), [query, subject]);
  const browse = useMemo(() => HOWTOS.filter((h) => !subject || h.subjects.includes(subject)), [subject]);
  const list = results ?? browse;
  const active = (activeId && list.find((h) => h.id === activeId)) || (activeId && reading ? howToById(activeId) : undefined) || list[0];

  const pickSubject = (s: Subject | null) => {
    setSubject(s);
    try {
      if (s) localStorage.setItem(SUBJECT_KEY, s);
      else localStorage.removeItem(SUBJECT_KEY);
    } catch {
      // Private window: the choice lasts the visit.
    }
  };

  const close = () => {
    setOpen(false);
    setReading(false);
  };
  const show = (h: HowTo) => {
    close();
    input.current?.blur();
    onShow(h);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true);
      if (!list.length) return;
      const i = active ? list.indexOf(active) : -1;
      const n = list.length;
      const next = list[(i + (e.key === "ArrowDown" ? 1 : n - 1) + n) % n]!;
      setActiveId(next.id);
      document.getElementById(`${id}-${next.id}`)?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter" && active) {
      e.preventDefault();
      show(active);
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (reading) setReading(false);
      else if (open) close();
      else input.current?.blur();
    }
  };

  const listbox = `${id}-list`;

  return (
    <div
      ref={box}
      className={cn(
        // Beside the page's heading: a field the width of a toolbar control, not a banner.
        "relative w-[28rem] max-[600px]:w-auto max-[600px]:flex-1",
        open && "max-[600px]:fixed max-[600px]:inset-0 max-[600px]:z-50 max-[600px]:m-0 max-[600px]:flex max-[600px]:flex-col max-[600px]:bg-bg max-[600px]:p-[12px]",
      )}
    >
      <div className="flex items-center gap-[8px]">
        <label
          className={cn(
            "flex h-[44px] flex-1 items-center gap-[10px] rounded-card border border-borderStrong bg-white px-[14px] shadow-card",
            "focus-within:border-ink focus-within:shadow-lift",
          )}
        >
          <SearchIcon />
          <span className="sr-only">How do I</span>
          <input
            ref={input}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveId(null);
              setReading(false);
              setOpen(true);
            }}
            onFocus={(e) => {
              e.target.select();
              setOpen(true);
            }}
            onKeyDown={onKeyDown}
            role="combobox"
            aria-expanded={open}
            aria-controls={open ? listbox : undefined}
            aria-autocomplete="list"
            aria-activedescendant={open && active ? `${id}-${active.id}` : undefined}
            placeholder={placeholder}
            autoComplete="off"
            spellCheck={false}
            className="h-full min-w-0 flex-1 bg-transparent text-body text-ink placeholder:text-inkMuted focus:outline-none"
          />
          {!open && (
            <kbd className="shrink-0 rounded-card border border-hairline px-[6px] py-[1px] font-sans text-meta text-inkMuted max-[1024px]:hidden">
              Ctrl G
            </kbd>
          )}
        </label>
        {open && (
          <button
            type="button"
            onClick={close}
            className="hidden h-[44px] shrink-0 items-center px-[10px] text-ui text-ink max-[600px]:flex"
          >
            Close
          </button>
        )}
      </div>

      {/* Read out how many tasks match, as the list changes. */}
      <p role="status" aria-live="polite" className="sr-only">
        {open && results ? (results.length ? `${results.length} found. ${results[0]!.title}.` : "Nothing found.") : ""}
      </p>

      {open && (
        <div
          className={cn(
            // Hangs from the field's right edge, wider than it, over the calculator.
            "absolute right-0 top-[calc(100%+8px)] z-40 grid h-[min(36rem,calc(100dvh-12rem))] w-[56rem] max-w-[calc(100vw-32px)] overflow-hidden rounded-hero border border-hairline bg-white shadow-lift",
            "grid-cols-[minmax(0,5fr)_minmax(0,7fr)] max-[1024px]:w-[36rem] max-[1024px]:grid-cols-1",
            "max-[600px]:w-auto max-[600px]:max-w-none",
            "max-[600px]:static max-[600px]:mt-[8px] max-[600px]:h-auto max-[600px]:min-h-0 max-[600px]:flex-1",
          )}
        >
          <div className={cn("flex min-h-0 flex-col border-r border-hairline max-[1024px]:border-r-0", reading && "max-[1024px]:hidden")}>
            {!results && (
              <div className="px-[16px] pb-[8px] pt-[16px]">
                <SubjectSwitch value={subject} onChange={pickSubject} />
              </div>
            )}
            <div id={listbox} role="listbox" aria-label="How do I" className="min-h-0 flex-1 overflow-y-auto px-[8px] pb-[16px] pt-[4px]">
              {results ? (
                results.length ? (
                  results.map((h) => (
                    <Row key={h.id} id={`${id}-${h.id}`} entry={h} active={h === active} onHover={() => setActiveId(h.id)} onOpen={() => open1(h)} />
                  ))
                ) : (
                  <NoResults query={query} onPaste={(t) => (close(), onPaste(t))} />
                )
              ) : (
                GROUPS.map((g) => {
                  const rows = browse.filter((h) => h.group === g.id);
                  if (!rows.length) return null;
                  return (
                    <div key={g.id} role="group" aria-labelledby={`${id}-g-${g.id}`} className="mt-[16px] first:mt-[8px]">
                      <h3 id={`${id}-g-${g.id}`} className="px-[12px] pb-[4px] text-ui font-semibold text-inkStrong">
                        {g.title}
                      </h3>
                      {rows.map((h) => (
                        <Row key={h.id} id={`${id}-${h.id}`} entry={h} active={h === active} onHover={() => setActiveId(h.id)} onOpen={() => open1(h)} />
                      ))}
                    </div>
                  );
                })
              )}
            </div>
          </div>
          <div className={cn("min-h-0", !reading && "max-[1024px]:hidden")}>
            {active && (
              <Card
                entry={active}
                onBack={() => setReading(false)}
                onShow={() => show(active)}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );

  // A click opens the card: beside the list it's already showing, in place of it on narrow screens.
  function open1(h: HowTo) {
    setActiveId(h.id);
    setReading(true);
  }
}

/** The syntax of what Show me put on the line, shown until the next enter. */
export function SyntaxHint({ text, onHide, className }: { text: string; onHide: () => void; className?: string }) {
  return (
    <div className={cn("flex min-w-0 items-center gap-[12px]", className)}>
      <span className="min-w-0 truncate font-casmath text-body text-inkStrong">{text}</span>
      <button type="button" onClick={onHide} className="min-h-[36px] shrink-0 text-ui text-inkMuted hover:text-ink max-[600px]:min-h-[44px]">
        Hide
      </button>
    </div>
  );
}

function Row({ id, entry, active, onHover, onOpen }: { id: string; entry: HowTo; active: boolean; onHover: () => void; onOpen: () => void }) {
  return (
    <div
      id={id}
      role="option"
      aria-selected={active}
      onMouseEnter={onHover}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onOpen}
      className={cn("cursor-pointer rounded-card px-[12px] py-[8px]", active && "bg-surface")}
    >
      <span className="block text-body font-semibold text-inkStrong">{entry.title}</span>
      <span className="block text-ui text-inkMuted">{entry.when}</span>
    </div>
  );
}

/** All, Methods, Specialist, General: a view switch, so a segmented track. The choice lifts. */
function SubjectSwitch({ value, onChange }: { value: Subject | null; onChange: (s: Subject | null) => void }) {
  const options: { id: Subject | null; title: string }[] = [{ id: null, title: "All" }, ...SUBJECTS];
  return (
    <div role="radiogroup" aria-label="Subject" className="flex rounded-card bg-surface p-[3px]">
      {options.map((o) => (
        <button
          key={o.title}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onChange(o.id)}
          className={cn(
            "h-[36px] flex-1 rounded-card text-ui max-[600px]:h-[44px]",
            value === o.id ? "border border-hairline bg-white font-semibold text-inkStrong shadow-card" : "text-inkMuted hover:text-ink",
          )}
        >
          {o.title}
        </button>
      ))}
    </div>
  );
}

/** Nothing found: say so, and offer catalog commands whose names match. */
function NoResults({ query, onPaste }: { query: string; onPaste: (text: string) => void }) {
  const q = normalise(query).replace(/ /g, "");
  const near = q.length >= 2 ? CATALOG.filter((c) => c.syntax && normalise(c.name).replace(/ /g, "").includes(q)).slice(0, 5) : [];
  return (
    <div className="px-[12px] py-[16px]">
      <p className="text-body text-ink">Nothing for “{query.trim()}”. Try a word from the question: maximum, solve, normal.</p>
      {near.length > 0 && (
        <>
          <h3 className="mt-[16px] text-ui font-semibold text-inkStrong">In the catalog</h3>
          <ul className="mt-[4px]">
            {near.map((c) => (
              <li key={c.name}>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => onPaste(catalogInsert(c))}
                  className="w-full rounded-card px-[0px] py-[6px] text-left hover:bg-surface"
                >
                  <span className="font-casmath text-body text-inkStrong">{c.syntax}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function Card({ entry, onBack, onShow }: { entry: HowTo; onBack: () => void; onShow: () => void }) {
  const syntax = syntaxOf(entry);
  const lines = entry.ways.map(wayLine).filter((l) => l !== null);
  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-[24px] pb-[24px] pt-[20px] max-[600px]:px-[16px]">
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={onBack}
          className="mb-[8px] hidden min-h-[44px] items-center gap-[6px] text-ui text-ink max-[1024px]:flex"
        >
          <svg aria-hidden viewBox="0 0 12 12" className="size-[12px]">
            <path d="M8 2 L4 6 L8 10" fill="none" stroke="currentColor" strokeWidth="1.6" />
          </svg>
          Back
        </button>
        <h2 className="font-serif text-displayXs text-ink">{entry.title}</h2>
        {syntax && <Syntax text={syntax} />}
        {entry.example.length > 0 && (
          <div className="mt-[24px]">
            <ExampleScreen example={entry.example} />
          </div>
        )}
        {entry.watch && <p className="mt-[16px] text-body text-ink">{entry.watch}</p>}
        {entry.shortcuts?.map((g) => (
          <section key={g.title} className="mt-[24px]">
            <h3 className="text-ui font-semibold text-inkStrong">{g.title}</h3>
            <dl className="mt-[8px] grid grid-cols-[6.5rem_minmax(0,1fr)] items-center gap-x-[16px] gap-y-[8px]">
              {g.rows.map((r) => (
                <Fragment key={r.keys.join(" ")}>
                  <dt className="flex gap-[4px]">
                    {r.keys.map((k) => (
                      <kbd key={k} className="rounded-card border border-hairline px-[6px] py-[1px] font-sans text-meta text-ink">
                        {k}
                      </kbd>
                    ))}
                  </dt>
                  <dd className="text-ui text-ink">{r.does}</dd>
                </Fragment>
              ))}
            </dl>
          </section>
        ))}
      </div>
      {/* How to do it: the keys, and the calculator doing it. A reference list has neither. */}
      {entry.ways.length > 0 && <div className="flex items-center justify-between gap-[16px] border-t border-hairline px-[24px] py-[16px] max-[600px]:flex-col max-[600px]:items-stretch max-[600px]:px-[16px]">
        {lines.length > 0 && (
          <ul className="flex min-w-0 flex-col gap-[8px]">
            {lines.map((l, i) => (
              <Step key={i} caps={l.caps}>
                {l.say}
              </Step>
            ))}
          </ul>
        )}
        <Button variant="primary" onMouseDown={(e) => e.preventDefault()} onClick={onShow} className="ml-auto shrink-0 max-[600px]:ml-0">
          Show me
        </Button>
      </div>}
    </div>
  );
}

/**
 * The command, the biggest thing on the card: command names bold (normCdf,
 * solve, d, ∫), what goes in them regular, all in the calculator's maths face.
 */
function Syntax({ text }: { text: string }) {
  // Lines break only after a comma, never inside an argument ("first n").
  const parts = text.replace(/(?<![,|]) (?![|])/g, "\u00a0").split(/((?:[A-Za-z][A-Za-z0-9⁻¹▶]+|[d∫√])(?=\()|\bDefine\b)/);
  return (
    <p className="mt-[16px] break-words font-casmath text-displaySm text-inkStrong">
      {parts.map((part, i) => (i % 2 ? <b key={i} className="font-bold">{part}</b> : part))}
    </p>
  );
}

function Step({ caps, children }: { caps: string[]; children: ReactNode }) {
  return (
    <li className="flex flex-wrap items-center gap-x-[10px] gap-y-[4px]">
      {caps.length > 0 && (
        <span className="flex gap-[3px]" aria-hidden>
          {caps.map((k, j) => (
            <Keycap key={j} k={k} />
          ))}
        </span>
      )}
      <span className="text-ui text-ink">{children}</span>
    </li>
  );
}

function SearchIcon() {
  return (
    <svg aria-hidden viewBox="0 0 16 16" className="size-[18px] shrink-0 text-inkMuted">
      <circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M11 11 L14.5 14.5" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}
