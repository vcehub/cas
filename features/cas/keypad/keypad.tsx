// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 VCE Hub. Part of the /cas calculator: https://github.com/vcehub/cas
"use client";

import { Fragment, useState, type ReactNode } from "react";
import { cn } from "@/shared/lib/utils";
import type { Key } from "../keys";
import { constantsPanel, punctuationPanel, relationsPanel, trigPanel, type Panel } from "../menus/panels";

/**
 * The on-screen keypad: our own drawing, keys where a student's fingers
 * expect them, and the ctrl function printed above each key. It sends
 * the same Key events as the computer keyboard, so both drive the apps
 * identically. ctrl and shift apply to the next key, as on the handheld;
 * ctrl then shift is caps lock. Sizes are in cqw of the calculator's width,
 * with a floor so keys stay big enough to tap and read on a phone.
 *
 * Keys aren't in the tab order: focus stays on the calculator so typing
 * works, and every key has a keyboard equivalent. Each key's accessible name
 * says what it does and what ctrl makes it do.
 */
/** A screen the app opens: the catalog (on a tab) or the templates palette. */
export type Opener = { open: "catalog" | "templates"; tab?: number };
type Act = Key | Key[] | { panel: Panel } | Opener | "ctrl" | "shift" | null;
type Tone = "fn" | "num" | "light" | "ctrl";
type Spec = {
  face: ReactNode;
  label: string;
  act: Act;
  ctrl?: Act;
  /** What the key does after shift, where that's more than a capital (+ is ∫, − is d/dx). */
  shift?: Act;
  alt?: ReactNode;
  tone?: Tone;
  letter?: boolean;
  /** The computer keyboard's way to do what the key (and its ctrl function) does, shown on hover. */
  kbd?: string;
};

const key = (face: ReactNode, label: string, act: Act, more: Partial<Spec> = {}): Spec => ({
  face,
  label,
  act,
  ...more,
});
const ch = (c: string, face: ReactNode = c, more: Partial<Spec> = {}) => key(face, c, { k: "char", c }, more);
const num = (c: string, more: Partial<Spec> = {}) => ch(c, c, { tone: "num", ...more });
const letter = (c: string) =>
  key(c.toUpperCase(), c, { k: "char", c }, { letter: true, tone: "xyz".includes(c) ? "light" : "fn" });
/** Spoken names, where the face alone reads badly. */
const SAY: Record<string, string> = {
  "=": "equals",
  "*": "times",
  "/": "divide",
  "+": "plus",
  "-": "minus",
  "(": "open bracket",
  ")": "close bracket",
  "^": "power",
  "x²": "squared",
  "eˣ": "e to the power",
  "10ˣ": "10 to the power",
  ".": "decimal point",
  ",": "comma",
  EE: "times 10 to the power",
  π: "pi and constants",
  del: "delete",
  doc: "document menu",
  var: "variables",
  Home: "home, not available",
  Scratchpad: "scratchpad, not available",
  Flag: "flag, not available",
};

/** What ctrl makes a key do, spoken. */
const CTRL_SAY: Record<string, string> = {
  "=": "relations",
  trig: "hints, not available",
  Templates: "colon equals",
  Catalog: "symbols",
  "^": "nth root",
  "x²": "square root",
  "*": "quotes",
  "/": "fraction",
  "eˣ": "ln",
  "10ˣ": "log",
  "(": "square brackets",
  ")": "braces",
  ".": "capture, not available",
  negative: "ans",
  enter: "approximate",
  shift: "caps lock",
  var: "store",
  del: "clear",
  doc: "insert page",
};

/** What shift makes a key do, spoken (letters' capitals aren't listed). */
const SHIFT_SAY: Record<string, string> = { "+": "integral", "-": "derivative" };

const spoken = (s: Spec) => {
  const name = SAY[s.label] ?? s.label;
  const ctrl = CTRL_SAY[s.label];
  const shift = SHIFT_SAY[s.label];
  return [name, ctrl && `ctrl: ${ctrl}`, shift && `shift: ${shift}`].filter(Boolean).join("; ");
};

const typed = (s: string): Key[] => [...s].map((c) => ({ k: "char", c }));
const stacked = (top: string, below: string) => (
  <span className="flex flex-col items-center leading-none">
    {top}
    <span className="text-[max(2.2cqw,9px)]">{below}</span>
  </span>
);

const NAV_LEFT: Spec[] = [
  key("esc", "esc", { k: "esc" }, { kbd: "Esc" }),
  key(<ScratchpadIcon />, "Scratchpad", null, { alt: "save" }),
  key("tab", "tab", { k: "tab" }, { kbd: "Tab" }),
];

const NAV_RIGHT: Spec[] = [
  key(
    <>
      <HomeIcon /> on
    </>,
    "Home",
    null,
    { alt: "off" },
  ),
  key("doc ▾", "doc", { k: "doc" }, { ctrl: { k: "insertPage" }, alt: "+ page", kbd: "Ctrl K. Add a page: Ctrl I" }),
  key("menu", "menu", { k: "menu" }, { ctrl: { k: "menu" }, kbd: "Ctrl M" }),
];

/** The ctrl, shift, var and del row, in the main grid's columns (null is a gap). */
const MODS: (Spec | null)[] = [
  key("ctrl", "ctrl", "ctrl", { tone: "ctrl" }),
  key("⇧ shift", "shift", "shift", { alt: "CAPS" }),
  null,
  key("var", "var", null, { ctrl: { k: "text", text: "→" }, alt: "sto →", kbd: "store is typed ->" }),
  key(stacked("del", "←"), "del", { k: "backspace" }, { ctrl: { k: "clear" }, alt: "clear", kbd: "Backspace" }),
];

/** Main grid rows: a pair of function keys, three keys, then a pair (or enter). */
type Row = {
  left: [Spec, Spec];
  mid: [Spec, Spec, Spec];
  right: [Spec, Spec] | Spec;
};

const MAIN: Row[] = [
  {
    left: [
      ch("=", "=", { ctrl: { panel: relationsPanel }, alt: "|≠≥▸", kbd: "≥ and ≤ are typed >= and <=" }),
      key(stacked("trig", "▸"), "trig", { panel: trigPanel }, { alt: "?" }),
    ],
    mid: [num("7"), num("8"), num("9")],
    right: [
      key(<TemplatesIcon />, "Templates", { open: "templates" }, { ctrl: typed(":="), alt: ":=", kbd: "define is typed :=" }),
      key(<CatalogIcon />, "Catalog", { open: "catalog" }, { ctrl: { open: "catalog", tab: 4 }, alt: "∞β°" }),
    ],
  },
  {
    left: [
      ch("^", "^", { ctrl: { k: "template", id: "nroot" }, alt: "ⁿ√x", kbd: "^" }),
      key(
        <>
          x<sup>2</sup>
        </>,
        "x²",
        { k: "char", c: "²" },
        { ctrl: { k: "template", id: "sqrt" }, alt: "√", kbd: "^2. Square root: Ctrl R" },
      ),
    ],
    mid: [num("4"), num("5"), num("6")],
    right: [
      ch("*", "×", { ctrl: [...typed('""'), { k: "left" }], alt: "“□”", kbd: "*" }),
      ch("/", "÷", {
        ctrl: { k: "template", id: "frac" },
        alt: <FractionGlyph />,
        kbd: "/. Fraction template: Ctrl /",
      }),
    ],
  },
  {
    left: [
      key(
        <>
          e<sup>x</sup>
        </>,
        "eˣ",
        { k: "template", id: "exp" },
        { ctrl: { k: "text", text: "ln(" }, alt: "ln", kbd: "ln is typed ln(" },
      ),
      key(
        <>
          10<sup>x</sup>
        </>,
        "10ˣ",
        typed("10^"),
        // The handheld's log key gives the template with a box for the base.
        { ctrl: { k: "template", id: "logbase" }, alt: "log", kbd: "10^. log is typed log(" },
      ),
    ],
    mid: [num("1"), num("2"), num("3")],
    // Shift then + or − : the integral and derivative templates, the handheld's shortcuts.
    right: [ch("+", "+", { shift: { k: "template", id: "defintegral" } }), ch("-", "−", { shift: { k: "template", id: "deriv" } })],
  },
  {
    left: [
      ch("(", "(", { ctrl: { k: "char", c: "[" }, alt: "[ ]" }),
      ch(")", ")", { ctrl: { k: "char", c: "{" }, alt: "{ }" }),
    ],
    mid: [
      num("0"),
      num(".", { alt: "capture", ctrl: null }),
      key("(−)", "negative", { k: "char", c: "-" }, { tone: "num", ctrl: { k: "text", text: "ans" }, alt: "ans", kbd: "-. The last answer is typed ans" }),
    ],
    right: key("enter", "enter", { k: "enter" }, { ctrl: { k: "approx" }, alt: "≈", kbd: "Enter. Decimal answer: Ctrl Enter" }),
  },
];

/** The letter block: a function key, seven letters, a function key; space ends the last row. */
const ALPHA: (Spec | null)[][] = [
  [
    key("EE", "EE", { k: "char", c: "E" }),
    ..."abcdefg".split("").map(letter),
    key("?!▸", "Punctuation", { panel: punctuationPanel }),
  ],
  [key("π▸", "π", { panel: constantsPanel }, { kbd: "π is typed pi" }), ..."hijklmn".split("").map(letter), key(<FlagIcon />, "Flag", null)],
  [ch(",", ","), ..."opqrstu".split("").map(letter), key("↵", "Return", { k: "enter" })],
  [null, ..."vwxyz".split("").map(letter)],
];
const SPACE = key(<SpaceIcon />, "Space", { k: "char", c: " " });

const GRID = "grid grid-cols-[1.55fr_1fr_1fr_1fr_1.55fr] gap-x-[2.6cqw] gap-y-[0.6cqw]";
const SMALL = "h-[max(6.2cqw,32px)] text-[max(3.4cqw,14px)]";

export function Keypad({
  onKey,
  onKeys,
  onPanel,
  onOpen,
}: {
  onKey: (k: Key) => void;
  /** Several keys from one press (":=", "10^"), applied in order. */
  onKeys: (ks: Key[]) => void;
  onPanel: (p: Panel) => void;
  onOpen: (o: Opener) => void;
}) {
  const [ctrl, setCtrl] = useState(false);
  const [shift, setShift] = useState(false);
  const [caps, setCaps] = useState(false);

  const press = (s: Spec) => {
    if (s.act === "ctrl") {
      setCtrl((v) => !v);
      return;
    }
    if (s.act === "shift") {
      if (ctrl) {
        setCaps((v) => !v);
        setCtrl(false);
      } else setShift((v) => !v);
      return;
    }
    // Shift, not caps lock: with caps on, + still types +.
    const act = ctrl && s.ctrl !== undefined ? s.ctrl : shift && s.shift !== undefined ? s.shift : s.act;
    setCtrl(false);
    setShift(false);
    if (act === null || act === "ctrl" || act === "shift") return;
    if ("panel" in act) onPanel(act.panel);
    else if ("open" in act) onOpen(act);
    else if (Array.isArray(act)) onKeys(act);
    else if (s.letter && act.k === "char" && shift !== caps) onKey({ k: "char", c: act.c.toUpperCase() });
    else onKey(act);
  };
  const isOn = (s: Spec) => (s.act === "ctrl" && ctrl) || (s.act === "shift" && (shift || caps));
  const k = (s: Spec, className?: string) => <KeyButton spec={s} onPress={press} on={isOn(s)} className={className} />;
  const cell = (s: Spec, className?: string) => (
    <Cell key={s.label} alt={s.alt}>
      {k(s, className)}
    </Cell>
  );

  return (
    <div
      role="group"
      aria-label="Keypad"
      className="mt-[3cqw] select-none rounded-hero bg-casBody p-[2.5cqw] font-casui text-casKeyFnText lg:mt-0"
    >
      {/* Touchpad, with esc, scratchpad and tab on the left and on, doc and menu on the right. */}
      <div className="grid grid-cols-[17cqw_1fr_17cqw] items-center gap-x-[4cqw] px-[2cqw] pb-[3cqw] pt-[2cqw]">
        <div className="flex flex-col gap-y-[1.4cqw]">{NAV_LEFT.map((s) => cell(s))}</div>
        <Touchpad onKey={onKey} ctrl={ctrl} clearCtrl={() => setCtrl(false)} />
        <div className="flex flex-col gap-y-[1.4cqw]">{NAV_RIGHT.map((s) => cell(s))}</div>
      </div>

      <div className="rounded-hero bg-casBodyLow px-[3cqw] pb-[4cqw] pt-[2cqw]">
        <div className={GRID}>
          {MODS.map((s, i) => (s ? cell(s, s.tone === "ctrl" ? "w-[80%] self-start" : undefined) : <span key={i} />))}
        </div>
        <div className={cn(GRID, "mt-[0.6cqw]")}>
          {MAIN.map((row, r) => (
            <Fragment key={r}>
              <Pair specs={row.left} render={k} />
              {row.mid.map((s) => cell(s))}
              {Array.isArray(row.right) ? <Pair specs={row.right} render={k} /> : cell(row.right)}
            </Fragment>
          ))}
        </div>

        <div className="mt-[5cqw] grid grid-cols-9 gap-x-[1.8cqw] gap-y-[2cqw]">
          {ALPHA.flatMap((row, r) => row.map((s, c) => <div key={`${r}-${c}`}>{s && k(s, SMALL)}</div>))}
          <div className="col-span-2">{k(SPACE, SMALL)}</div>
        </div>
      </div>
    </div>
  );
}

/** A key with its ctrl function printed above it. */
function Cell({ alt, children }: { alt?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col items-center">
      <AltLabel>{alt}</AltLabel>
      {children}
    </div>
  );
}

function AltLabel({ children }: { children?: ReactNode }) {
  return (
    <span
      aria-hidden
      className="flex h-[max(3.8cqw,15px)] items-end justify-center whitespace-nowrap pb-[0.4cqw] text-[max(2.5cqw,10.5px)] leading-none text-casKeyAlt"
    >
      {children}
    </span>
  );
}

/** Two keys moulded together, as the handheld's function-key pairs are. */
function Pair({ specs, render }: { specs: [Spec, Spec]; render: (s: Spec, className?: string) => ReactNode }) {
  return (
    <div className="flex flex-col">
      <div className="grid grid-cols-2">
        {specs.map((s) => (
          <AltLabel key={s.label}>{s.alt}</AltLabel>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-card bg-casKeyLip">
        {specs.map((s) => (
          <Fragment key={s.label}>{render(s, "rounded-none")}</Fragment>
        ))}
      </div>
    </div>
  );
}

function KeyButton({
  spec,
  onPress,
  on,
  className,
}: {
  spec: Spec;
  onPress: (s: Spec) => void;
  on?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-label={spoken(spec)}
      title={spec.kbd ? `Keyboard: ${spec.kbd}` : undefined}
      aria-pressed={spec.act === "ctrl" || spec.act === "shift" ? Boolean(on) : undefined}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onPress(spec)}
      className={cn(
        "flex h-[max(7.4cqw,38px)] w-full items-center justify-center whitespace-nowrap rounded-card border-b-[0.5cqw] border-casKeyLip text-[max(3.9cqw,15px)] leading-none active:translate-y-px",
        (spec.tone ?? "fn") === "fn" && "bg-casKeyFn text-casKeyFnText",
        spec.tone === "num" && "bg-casKeyNum text-[max(4.6cqw,17px)] text-casKeyNumText",
        spec.tone === "light" && "bg-casKeyLight text-casKeyLightText",
        spec.tone === "ctrl" && "bg-casCtrl text-casCtrlText",
        on && "ring-[0.6cqw] ring-inset ring-casKeyAlt",
        className,
      )}
    >
      {spec.face}
    </button>
  );
}

/**
 * The touchpad: the edges are the arrows and the centre selects. With ctrl,
 * left and right change page, as the page icons printed beside it show.
 */
function Touchpad({ onKey, ctrl, clearCtrl }: { onKey: (k: Key) => void; ctrl: boolean; clearCtrl: () => void }) {
  const edge = (k: Key, ctrlKey: Key | null, d: string, cls: string, label: string) => (
    <button
      type="button"
      tabIndex={-1}
      aria-label={label}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        const use = ctrl ? ctrlKey : k;
        clearCtrl();
        if (use) onKey(use);
      }}
      className={cn("absolute flex items-center justify-center text-casPadText active:bg-casPadRim", cls)}
    >
      <svg viewBox="0 0 10 10" className="h-[max(1.8cqw,8px)] w-[max(1.8cqw,8px)]" aria-hidden>
        <path d={d} fill="currentColor" />
      </svg>
    </button>
  );
  return (
    <div className="flex items-center">
      <PageIcon dir="left" />
      <div className="relative mx-[1.5cqw] aspect-[1.3] flex-1 overflow-hidden rounded-hero border-[0.8cqw] border-casPadRim bg-casPad">
        {edge({ k: "up" }, null, "M5 2 L9 8 L1 8 Z", "inset-x-[25%] top-0 h-[30%]", "Up")}
        {edge({ k: "down" }, null, "M5 8 L9 2 L1 2 Z", "inset-x-[25%] bottom-0 h-[30%]", "Down")}
        {edge({ k: "left" }, { k: "prevPage" }, "M2 5 L8 1 L8 9 Z", "inset-y-[25%] left-0 w-[25%]", "Left; ctrl: previous page")}
        {edge({ k: "right" }, { k: "nextPage" }, "M8 5 L2 1 L2 9 Z", "inset-y-[25%] right-0 w-[25%]", "Right; ctrl: next page")}
        <button
          type="button"
          tabIndex={-1}
          aria-label="Select"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            clearCtrl();
            onKey({ k: "enter" });
          }}
          className="absolute left-1/2 top-1/2 flex h-[36%] w-[30%] -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-card border-[0.4cqw] border-casPadRim bg-casKeyFn active:bg-casPadRim"
        >
          <svg viewBox="0 0 12 12" className="h-[3cqw] w-[3cqw] text-casKeyFnText" aria-hidden>
            <path d="M3 2 L3 10 L5.4 7.8 L7 11 L8.4 10.3 L6.8 7.2 L9.8 7 Z" fill="currentColor" />
          </svg>
        </button>
      </div>
      <PageIcon dir="right" />
    </div>
  );
}

function PageIcon({ dir }: { dir: "left" | "right" }) {
  return (
    <svg viewBox="0 0 12 10" className="h-[2.6cqw] w-[3cqw] shrink-0 text-casKeyAlt" aria-hidden>
      <rect x="1" y="1" width="10" height="8" fill="none" stroke="currentColor" strokeWidth="1" />
      <path d={dir === "left" ? "M4 5 L7.5 2.5 L7.5 7.5 Z" : "M8 5 L4.5 2.5 L4.5 7.5 Z"} fill="currentColor" />
    </svg>
  );
}

function ScratchpadIcon() {
  return (
    <svg viewBox="0 0 14 14" className="h-[3.4cqw] w-[3.4cqw]" aria-hidden>
      <rect x="4" y="1" width="8" height="12" rx="1" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <rect x="5.6" y="2.6" width="4.8" height="2.4" fill="currentColor" />
      {[0, 1, 2].flatMap((r) =>
        [0, 1].map((c) => (
          <rect key={`${r}${c}`} x={5.8 + c * 2.6} y={6.4 + r * 2} width="1.6" height="1.2" fill="currentColor" />
        )),
      )}
      <path d="M1.5 3 L1.5 12 M3 2 L3 13" stroke="currentColor" strokeWidth="0.8" />
    </svg>
  );
}

function HomeIcon() {
  return (
    <svg viewBox="0 0 12 12" className="mr-[0.6cqw] inline h-[3cqw] w-[3cqw]" aria-hidden>
      <path
        d="M1 6 L6 1.5 L11 6 M2.5 5 L2.5 10.5 L9.5 10.5 L9.5 5 M5 10.5 L5 7.5 L7 7.5 L7 10.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.1"
      />
    </svg>
  );
}

function TemplatesIcon() {
  return (
    <svg viewBox="0 0 16 12" className="h-[3.2cqw] w-[4.2cqw]" aria-hidden>
      <rect x="1" y="3" width="4" height="6" fill="none" stroke="currentColor" strokeWidth="1" />
      <path
        d="M8 2 Q7 2 7 4 L7 5 Q7 6 6.4 6 Q7 6 7 7 L7 8 Q7 10 8 10"
        fill="none"
        stroke="currentColor"
        strokeWidth="0.9"
      />
      <rect x="9" y="1.5" width="3" height="3.5" fill="none" stroke="currentColor" strokeWidth="0.9" />
      <rect x="9" y="7" width="3" height="3.5" fill="none" stroke="currentColor" strokeWidth="0.9" />
    </svg>
  );
}

function CatalogIcon() {
  return (
    <svg viewBox="0 0 16 12" className="h-[3.2cqw] w-[4.2cqw]" aria-hidden>
      <path
        d="M8 3 Q5 1.5 1.5 2 L1.5 10 Q5 9.5 8 11 Q11 9.5 14.5 10 L14.5 2 Q11 1.5 8 3 Z M8 3 L8 11"
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
      />
    </svg>
  );
}

function FlagIcon() {
  return (
    <svg viewBox="0 0 12 12" className="h-[3cqw] w-[3cqw]" aria-hidden>
      <path d="M3 11 L3 1.5 L9.5 1.5 L8 4 L9.5 6.5 L3 6.5" fill="none" stroke="currentColor" strokeWidth="1.1" />
    </svg>
  );
}

function SpaceIcon() {
  return (
    <svg viewBox="0 0 12 6" className="h-[1.6cqw] w-[3.6cqw]" aria-hidden>
      <path d="M1 1 L1 5 L11 5 L11 1" fill="none" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function FractionGlyph() {
  return (
    <svg viewBox="0 0 8 12" className="h-[2.6cqw] w-[1.8cqw]" aria-hidden>
      <rect x="2" y="0.8" width="4" height="3.6" fill="none" stroke="currentColor" strokeWidth="0.9" />
      <path d="M0.5 6 L7.5 6" stroke="currentColor" strokeWidth="0.9" />
      <rect x="2" y="7.6" width="4" height="3.6" fill="none" stroke="currentColor" strokeWidth="0.9" />
    </svg>
  );
}
