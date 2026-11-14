// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 VCE Hub. Part of the /cas calculator: https://github.com/vcehub/cas
import { useEffect, useRef } from "react";
import { cn } from "@/shared/lib/utils";
import type { Key } from "../keys";
import type { MenuAction } from "./types";

/**
 * Wizard dialogs ("Normal Cdf…", "Solve System of Equations…"): labelled
 * fields, Tab or the arrows between them, Enter for OK. OK pastes the built
 * command into the entry line, as the handheld does.
 */
type Wizard = Extract<MenuAction, { kind: "wizard" }>;
/** `fresh`: the focused field's contents are selected, so typing replaces them. */
export type WizardState = { wizard: Wizard; values: string[]; focus: number; fresh: boolean };

export const openWizard = (wizard: Wizard): WizardState => ({
  wizard,
  values: wizard.fields.map((f) => f.value ?? f.options?.[0] ?? ""),
  focus: 0,
  fresh: true,
});

/** The command text a filled-in wizard builds, empty trailing arguments dropped. */
export function buildWizard(w: WizardState): string {
  let out = w.wizard.build.replace(/\{(\d)\}/g, (_, i: string) => w.values[Number(i)]?.trim() ?? "");
  out = out.replace(/,+\)/g, ")");
  return out;
}

export function wizardKeyPress(w: WizardState, key: Key): { state: WizardState | null; done?: string } {
  const field = w.wizard.fields[w.focus];
  const set = (v: string) => ({ state: { ...w, fresh: false, values: w.values.map((x, i) => (i === w.focus ? v : x)) } });
  const current = w.fresh ? "" : (w.values[w.focus] ?? "");
  const n = w.wizard.fields.length;
  switch (key.k) {
    case "esc":
      return { state: null };
    case "enter":
      return { state: null, done: buildWizard(w) };
    case "tab":
    case "down":
      return { state: { ...w, focus: (w.focus + 1) % n, fresh: true } };
    case "up":
      return { state: { ...w, focus: (w.focus - 1 + n) % n, fresh: true } };
    case "left":
    case "right": {
      if (field?.check) return set(w.values[w.focus] === "Yes" ? "No" : "Yes");
      if (!field?.options) return { state: w };
      const opts = field.options;
      const i = opts.indexOf(w.values[w.focus] ?? "");
      return set(opts[(i + (key.k === "right" ? 1 : opts.length - 1)) % opts.length]!);
    }
    case "backspace":
      return field?.check || (field?.options && !field.free) ? { state: w } : set(current.slice(0, -1));
    case "char":
      if (field?.check) return key.c === " " ? set(w.values[w.focus] === "Yes" ? "No" : "Yes") : { state: w };
      return field?.options && !field.free ? { state: w } : set(current + key.c);
    case "text":
      return field?.check || (field?.options && !field.free) ? { state: w } : set(current + key.text);
    default:
      return { state: w };
  }
}

export function WizardDialog({
  state,
  onFocus,
  onOk,
  onCancel,
  onArrow,
}: {
  state: WizardState;
  onFocus: (i: number) => void;
  onOk: () => void;
  onCancel: () => void;
  /** The arrow button on a dropdown field: the next option. A checkbox's click toggles it the same way. */
  onArrow: (i: number) => void;
}) {
  const arrows = state.wizard.arrows ?? true;
  const fields = useRef<HTMLDivElement>(null);
  // A long dialog (Document Settings) scrolls; keep the focused field in view.
  useEffect(() => {
    const box = fields.current;
    const el = box?.querySelector<HTMLElement>(`[data-field="${state.focus}"]`);
    if (!box || !el) return;
    if (el.offsetTop < box.scrollTop) box.scrollTop = el.offsetTop - 4;
    else if (el.offsetTop + el.offsetHeight > box.scrollTop + box.clientHeight)
      box.scrollTop = el.offsetTop + el.offsetHeight - box.clientHeight + 4;
  }, [state.focus]);
  // A box floating over the page, as on the handheld, with a flat offset shadow.
  return (
    <div className="absolute inset-0 flex items-start justify-center py-[3.4cqw] font-casui text-[3.9cqw]">
      <div className="relative flex max-h-full w-[76%]">
        <div aria-hidden className="absolute inset-0 translate-x-[0.6cqw] translate-y-[0.6cqw] bg-casRule" />
        <div role="dialog" aria-label={state.wizard.title} className="relative flex min-h-0 w-full flex-col border border-casRule bg-casScreen">
          <div className="px-[2cqw] pb-[2.4cqw] pt-[1.6cqw] text-[4.3cqw] font-bold">{state.wizard.title}</div>
          <div
            ref={fields}
            className="relative grid min-h-0 grid-cols-[auto_1fr] items-center gap-x-[2cqw] gap-y-[1.8cqw] overflow-y-auto px-[2cqw] py-[0.4cqw] [scrollbar-width:thin]"
          >
            {state.wizard.fields.map((f, i) =>
              f.check ? (
                <button
                  key={f.label}
                  type="button"
                  tabIndex={-1}
                  role="checkbox"
                  aria-checked={state.values[i] === "Yes"}
                  data-field={i}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    onFocus(i);
                    onArrow(i);
                  }}
                  className={cn(
                    "col-span-2 flex items-center gap-[1.4cqw] justify-self-start border-[0.4cqw] p-[0.6cqw] text-casLabel",
                    i === state.focus ? "border-casSelect" : "border-transparent",
                  )}
                >
                  <CheckBox on={state.values[i] === "Yes"} />
                  {f.label}
                </button>
              ) : (
              <div key={f.label} className="contents">
                <label className="whitespace-nowrap text-right text-casLabel">{f.label}</label>
                <button
                  type="button"
                  tabIndex={-1}
                  data-field={i}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => onFocus(i)}
                  className={cn(
                    "flex h-[6.6cqw] items-center justify-between text-left",
                    i === state.focus ? "border-[0.4cqw] border-casSelect" : "border-[0.25cqw] border-casInk",
                  )}
                >
                  <span className="flex min-w-0 flex-1 items-center px-[1.2cqw]">
                    <span className={cn(i === state.focus && state.fresh && state.values[i] && "bg-casSelectSoft")}>
                      {state.values[i] || (f.hint && i !== state.focus && <span className="text-casDim">{f.hint}</span>)}
                    </span>
                    {i === state.focus && !(f.options && !f.free) && (
                      <span className="ml-px h-[4cqw] w-px bg-casInk motion-safe:animate-casblink" />
                    )}
                  </span>
                  {(arrows || f.options) && (
                    <span
                      onClick={(e) => {
                        e.stopPropagation();
                        onFocus(i);
                        if (f.options) onArrow(i);
                      }}
                      className="flex h-full w-[5cqw] shrink-0 items-center justify-center border-l-[0.25cqw] border-casInk"
                    >
                      <svg aria-hidden viewBox="0 0 6 10" className="h-[2cqw]">
                        <path d="M0.5 0.5 L5.5 5 L0.5 9.5 Z" fill="currentColor" />
                      </svg>
                    </span>
                  )}
                </button>
              </div>
              ),
            )}
          </div>
          <div className="flex justify-end gap-[2cqw] px-[2cqw] pb-[2cqw] pt-[2.4cqw]">
            <button
              type="button"
              tabIndex={-1}
              onMouseDown={(e) => e.preventDefault()}
              onClick={onOk}
              className="border-[0.25cqw] border-casRule px-[4.4cqw] py-[1cqw]"
            >
              OK
            </button>
            <button
              type="button"
              tabIndex={-1}
              onMouseDown={(e) => e.preventDefault()}
              onClick={onCancel}
              className="px-[2cqw] py-[1cqw]"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** The handheld's checkbox: a square, with a tick when on. */
export function CheckBox({ on }: { on: boolean }) {
  return (
    <svg aria-hidden viewBox="0 0 10 10" className="h-[4cqw] w-[4cqw] shrink-0">
      <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth={0.8} className="text-casInk" />
      {on && <path d="M2 5.2 L4.2 7.4 L8.2 2.6" fill="none" strokeWidth={1.3} className="stroke-casSelect" />}
    </svg>
  );
}
