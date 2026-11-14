// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 VCE Hub. Part of the /cas calculator: https://github.com/vcehub/cas
import { createContext, useContext, useLayoutEffect, useRef, type MouseEvent, type ReactNode, type RefObject } from "react";
import { cn } from "@/shared/lib/utils";
import { BUILTINS } from "./builtins";
import { slotsOf, getSlot, type Cursor, type Step } from "./cursor";
import type { Node, Row } from "./tree";

/**
 * Renders a 2D expression tree the way the handheld prints maths: a serif
 * face, italic variables, upright function names and digits, stacked
 * fractions, brackets that grow with their contents, a centred dot for
 * multiplication and a raised short dash for negation. One renderer serves
 * both the entry line (with a caret) and history rows.
 */
export function MathView({
  row,
  cursor,
  selection,
  className,
  onPick,
  onSelect,
  onClick,
  onDoubleClick,
}: {
  row: Row;
  cursor?: Cursor;
  /** A selected stretch of one row, highlighted; the caret is hidden while there is one. */
  selection?: Selection | null;
  className?: string;
  /** Set on an editable line: a click places the cursor where it lands. */
  onPick?: (c: Cursor) => void;
  /** Set on an editable line: a drag from one place to another selects between them. */
  onSelect?: (from: Cursor, to: Cursor) => void;
  onClick?: () => void;
  onDoubleClick?: () => void;
}) {
  const box = useRef<HTMLSpanElement>(null);
  return (
    <span
      ref={box}
      className={cn(
        "inline-flex items-center whitespace-nowrap font-casmath leading-none",
        (onPick || onClick) && "cursor-text",
        onClick && "cursor-pointer",
        className,
      )}
      onMouseDown={
        onPick
          ? (e) => {
              const at = cursorAt(e, row);
              onPick(at);
              if (onSelect && box.current) {
                // Our own selection, not the browser's.
                e.preventDefault();
                followDrag(box.current, row, at, onSelect);
              }
            }
          : undefined
      }
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      <Selected.Provider value={selection ?? null}>
        <RowView row={row} path={[]} cursor={cursor} top pick={Boolean(onPick)} />
      </Selected.Provider>
    </span>
  );
}

type Selection = { path: Step[]; from: number; to: number };

const Selected = createContext<Selection | null>(null);

/**
 * Follows a drag that began at `from` on the line drawn in `box`, reporting
 * the stretch between it and the pointer until the button comes up.
 */
export function followDrag(box: HTMLElement, row: Row, from: Cursor, onSelect: (from: Cursor, to: Cursor) => void) {
  const move = (e: globalThis.MouseEvent) => onSelect(from, cursorAtPoint(box, row, e.clientX, e.clientY));
  const up = () => {
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
}

/**
 * The cursor position under a click: before or after the character hit,
 * by which half of it was clicked; inside an empty slot; or the end of the
 * line when the click is past everything.
 */
function cursorAt(e: MouseEvent, row: Row): Cursor {
  const el = (e.target as Element).closest<HTMLElement>("[data-i]");
  return el ? placeAt(el, e.clientX) : { path: [], index: row.length };
}

/** As cursorAt, for a pointer anywhere: off the line, the nearest place on its top row by x. */
function cursorAtPoint(box: HTMLElement, row: Row, x: number, y: number): Cursor {
  const hit = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-i]");
  if (hit && box.contains(hit)) return placeAt(hit, x);
  for (const el of box.querySelectorAll<HTMLElement>(":scope > [data-i]")) {
    const r = el.getBoundingClientRect();
    if (x < r.left + r.width / 2) return { path: [], index: Number(el.dataset.i) };
  }
  return { path: [], index: row.length };
}

function placeAt(el: HTMLElement, x: number): Cursor {
  const path = JSON.parse(el.dataset.p ?? "[]") as Step[];
  const i = Number(el.dataset.i);
  if (el.dataset.empty) return { path, index: 0 };
  const r = el.getBoundingClientRect();
  return { path, index: x > r.left + r.width / 2 ? i + Number(el.dataset.w ?? 1) : i };
}

/** Words shown upright even when not followed by brackets. */
const UPRIGHT = new Set([
  "true",
  "false",
  "undef",
  "and",
  "or",
  "xor",
  "not",
  "Define",
  "DelVar",
  "CopyVar",
  "Error",
  "OneVar",
  "TwoVar",
  "LinRegMx",
  "LinRegBx",
  "QuadReg",
  "ExpReg",
  "PowerReg",
  "LnReg",
  "zInterval_1Prop",
]);
const NEG_AFTER = new Set(["+", "-", "*", "/", "^", "=", "(", ",", "<", ">", "≤", "≥", "≠", "|", "→", ":", " "]);
const isLetter = (c: string) => /\p{L}/u.test(c) && c !== "π" && c !== "ℯ" && c !== "∞";
const isDigitLike = (c: string) => /[0-9.]/.test(c);

/**
 * Names that currently have a definition. The handheld prints these in bold
 * wherever they appear, as it does arbitrary constants (c1, n1) and i.
 */
export const DefinedNames = createContext<ReadonlySet<string>>(new Set());

type Style = "var" | "fn" | "up" | "def";

/** Decide per character whether letters are a variable (italic), a defined name (bold), or a built-in name. */
function letterStyles(row: Row, defined: ReadonlySet<string>): Style[] {
  const out: Style[] = row.map(() => "up");
  // Text in quotes ("Title") stays upright.
  const quoted = new Set<number>();
  let open = false;
  row.forEach((n, k) => {
    if (n.t === "ch" && n.c === '"') open = !open;
    else if (open) quoted.add(k);
  });
  let i = 0;
  while (i < row.length) {
    if (quoted.has(i)) {
      i++;
      continue;
    }
    const n = row[i];
    if (n?.t === "ch" && isLetter(n.c)) {
      let j = i;
      let word = "";
      for (; j < row.length; j++) {
        const m = row[j];
        if (m?.t !== "ch" || !(isLetter(m.c) || /[0-9_▶]/.test(m.c))) break;
        word += m.c;
      }
      const next = row[j];
      // Built-in names are upright; a user's own function stays italic.
      const builtin = BUILTINS.has(word.replace(/⁻¹$/, ""));
      const style: Style =
        next?.t === "group" && next.open === "(" && builtin
          ? "fn"
          : UPRIGHT.has(word) || word.startsWith("▶")
            ? "up"
            : defined.has(word) || /^[cn]\d+$/.test(word) || word === "i"
              ? "def"
              : "var";
      for (let k = i; k < j; k++) out[k] = style;
      i = j;
    } else i++;
  }
  return out;
}

const samePath = (a: Step[], b: Step[]) =>
  a.length === b.length && a.every((s, i) => s.node === b[i]!.node && s.slot === b[i]!.slot);

/**
 * Keeps the caret in view on an entry line wider than its box: the line
 * scrolls sideways as the cursor reaches either edge, as on the handheld.
 */
export function useCaretInView(box: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const el = box.current;
    const caret = el?.querySelector("[data-cas-caret]");
    if (!el || !caret) return;
    const b = el.getBoundingClientRect();
    const c = caret.getBoundingClientRect();
    const margin = b.width * 0.04;
    if (c.right > b.right - margin) el.scrollLeft += c.right - (b.right - margin);
    else if (c.left < b.left + margin) el.scrollLeft -= b.left + margin - c.left;
  });
}

/** The blinking caret; while there's a selection it stays in place unseen, so the line still scrolls to it. */
function Caret({ hidden }: { hidden?: boolean }) {
  return (
    <span
      aria-hidden
      data-cas-caret
      className={cn("mx-[-0.5px] inline-block h-[1.15em] w-px self-center", hidden ? "opacity-0" : "motion-safe:animate-casblink bg-casInk")}
    />
  );
}

function RowView({
  row,
  path,
  cursor,
  top,
  pick,
}: {
  row: Row;
  path: Step[];
  cursor?: Cursor;
  top?: boolean;
  pick?: boolean;
}) {
  const here = cursor && samePath(cursor.path, path) ? cursor.index : -1;
  const p = pick ? JSON.stringify(path) : undefined;
  const defined = useContext(DefinedNames);
  const sel = useContext(Selected);
  const lit = sel && samePath(sel.path, path) ? sel : null;
  // On an editable line each node carries its place, for clicks (see cursorAt).
  const tag = (key: string, i: number, el: ReactNode, w = 1) =>
    pick ? (
      <span
        key={key}
        data-p={p}
        data-i={i}
        data-w={w}
        className={cn("inline-flex items-center", lit && i < lit.to && i + w > lit.from && "self-stretch bg-casHistorySelect")}
      >
        {el}
      </span>
    ) : (
      el
    );
  if (!row.length) {
    // An empty slot shows the template's dotted box; the top-level entry
    // line shows nothing but the caret.
    if (top) return here === 0 ? <Caret hidden={Boolean(sel)} /> : null;
    return (
      <span className="inline-flex items-center">
        {here === 0 && <Caret hidden={Boolean(sel)} />}
        <span
          data-p={p}
          data-i={pick ? 0 : undefined}
          data-empty={pick ? 1 : undefined}
          className="inline-block h-[0.8em] w-[0.55em] border border-dotted border-casDim"
        />
      </span>
    );
  }
  const styles = letterStyles(row, defined);
  const items: ReactNode[] = [];
  for (let i = 0; i < row.length; i++) {
    if (here === i) items.push(<Caret key={`c${i}`} hidden={Boolean(sel)} />);
    const n = row[i]!;
    const next = row[i + 1];
    const childPath = (slot: string): Step[] => [...path, { node: i, slot }];
    const view = (
      <NodeView
        key={i}
        node={n}
        prev={row[i - 1]}
        style={styles[i]!}
        slot={(slot) => <RowView row={getSlot(n, slot)} path={childPath(slot)} cursor={cursor} pick={pick} />}
      />
    );
    // A power hangs off the node before it: draw the pair together.
    if (next?.t === "sup") {
      items.push(
        tag(
          `p${i}`,
          i,
          <span key={`p${i}`} className="inline-flex items-start">
            {view}
            {here === i + 1 && <Caret hidden={Boolean(sel)} />}
            <span className="-mt-[0.15em] inline-flex items-center text-[0.72em]">
              <RowView row={next.exp} path={childPath2(path, i + 1)} cursor={cursor} pick={pick} />
            </span>
          </span>,
          2,
        ),
      );
      i++;
      continue;
    }
    items.push(tag(`n${i}`, i, view));
  }
  if (here === row.length) items.push(<Caret key="end" hidden={Boolean(sel)} />);
  return <>{items}</>;
}

const childPath2 = (path: Step[], node: number): Step[] => [...path, { node, slot: "exp" }];

function Bracket({ kind }: { kind: string }) {
  const d: Record<string, string> = {
    "(": "M8 2 Q1 50 8 98",
    ")": "M2 2 Q9 50 2 98",
    "[": "M8 2 H3 V98 H8",
    "]": "M2 2 H7 V98 H2",
    "{": "M9 2 Q4 2 4 10 V42 Q4 50 1 50 Q4 50 4 58 V90 Q4 98 9 98",
    "}": "M1 2 Q6 2 6 10 V42 Q6 50 9 50 Q6 50 6 58 V90 Q6 98 1 98",
    "|": "M5 2 V98",
  };
  // The SVG sits absolutely inside a span so it takes the height of what it
  // brackets instead of lending its own aspect-ratio height to the row.
  return (
    <span aria-hidden className="relative inline-block min-h-[1.1em] w-[0.32em] self-stretch">
      <svg viewBox="0 0 10 100" preserveAspectRatio="none" className="absolute inset-0 h-full w-full">
        <path d={d[kind]} fill="none" stroke="currentColor" strokeWidth={1.1} vectorEffect="non-scaling-stroke" />
      </svg>
    </span>
  );
}

const CLOSE: Record<string, string> = { "(": ")", "{": "}", "[": "]", "|": "|" };

function Grouped({ open, children }: { open: string; children: ReactNode }) {
  return (
    <span className="inline-flex items-stretch">
      <Bracket kind={open} />
      <span className="inline-flex items-center px-[0.04em] py-[0.08em]">{children}</span>
      <Bracket kind={CLOSE[open] ?? ")"} />
    </span>
  );
}

/**
 * The integral sign: the maths font's own ∫, stretched to the height it
 * needs. The view box is the glyph's ink box in STIX Two Text at 100px
 * (measured in the browser), so the sign fills the box top to bottom.
 */
function IntegralSign() {
  return (
    <svg aria-hidden viewBox="0 -95.4 28.7 106.7" preserveAspectRatio="none" className="w-[0.4em] shrink-0 self-stretch">
      <text x="0" y="0" fontSize="100" fill="currentColor" className="font-casmath">
        ∫
      </text>
    </svg>
  );
}

function Stack({ top, bottom, children }: { top?: ReactNode; bottom?: ReactNode; children: ReactNode }) {
  return (
    <span className="inline-flex flex-col items-center leading-none">
      {top !== undefined && <span className="inline-flex items-center pb-[0.1em] text-[0.62em]">{top}</span>}
      {children}
      {bottom !== undefined && <span className="inline-flex items-center pt-[0.1em] text-[0.62em]">{bottom}</span>}
    </span>
  );
}

function NodeView({
  node,
  prev,
  style,
  slot,
}: {
  node: Node;
  prev?: Node;
  style: Style;
  slot: (s: string) => ReactNode;
}) {
  switch (node.t) {
    case "ch":
      return <Char c={node.c} prev={prev} style={style} />;
    case "frac":
      return (
        <span className="mx-[0.1em] inline-flex flex-col items-center align-middle text-[0.92em]">
          <span className="inline-flex items-center px-[0.15em] pb-[0.12em]">{slot("num")}</span>
          <span className="h-px w-full bg-casInk" />
          <span className="inline-flex items-center px-[0.15em] pt-[0.12em]">{slot("den")}</span>
        </span>
      );
    case "sup":
      return <span className="inline-flex items-center text-[0.72em]">{slot("exp")}</span>;
    case "exp":
      return (
        <span className="inline-flex items-start">
          {/* Euler's number is a bold upright e on the handheld, unlike an italic variable e. */}
          <span className="font-casmath font-bold">e</span>
          <span className="-mt-[0.15em] inline-flex items-center text-[0.72em]">{slot("exp")}</span>
        </span>
      );
    case "sqrt":
    case "root":
      return (
        <span className="inline-flex items-stretch">
          {node.t === "root" && (
            <span className="-mr-[0.35em] inline-flex items-center self-start text-[0.55em]">{slot("idx")}</span>
          )}
          <span aria-hidden className="relative inline-block min-h-[1.2em] w-[0.6em] self-stretch">
            <svg viewBox="0 0 20 100" preserveAspectRatio="none" className="absolute inset-0 h-full w-full">
              <path d="M1 62 L6 56 L11 96 L19.5 1" fill="none" stroke="currentColor" strokeWidth={1.4} vectorEffect="non-scaling-stroke" />
            </svg>
          </span>
          <span className="inline-flex items-center border-t-[1.4px] border-casInk px-[0.08em] pt-[0.12em]">{slot("arg")}</span>
        </span>
      );
    case "group":
      return <Grouped open={node.open}>{slot("arg")}</Grouped>;
    case "matrix":
      return (
        <Grouped open="[">
          <span
            className="inline-grid gap-x-[0.7em] gap-y-[0.25em] px-[0.2em]"
            style={{ gridTemplateColumns: `repeat(${node.cells[0]?.length ?? 1}, auto)` }}
          >
            {slotsOf(node).map((s) => (
              <span key={s} className="inline-flex items-center justify-start">
                {slot(s)}
              </span>
            ))}
          </span>
        </Grouped>
      );
    case "piecewise":
      return (
        <span className="inline-flex items-stretch">
          <Bracket kind="{" />
          <span className="inline-grid grid-cols-[auto_auto] gap-x-[0.2em] gap-y-[0.25em] pl-[0.15em]">
            {node.rows.map((_, i) => [
              <span key={`e${i}`} className="inline-flex items-center">
                {slot(`p.${i}.0`)}
                <span>,</span>
              </span>,
              <span key={`c${i}`} className="inline-flex items-center">
                {slot(`p.${i}.1`)}
              </span>,
            ])}
          </span>
        </span>
      );
    case "system":
      return (
        <span className="inline-flex items-stretch">
          <Bracket kind="{" />
          <span className="inline-flex flex-col gap-y-[0.25em] pl-[0.15em]">
            {node.rows.map((_, i) => (
              <span key={i} className="inline-flex items-center">
                {slot(`s.${i}`)}
              </span>
            ))}
          </span>
        </span>
      );
    case "integral":
      return (
        <span className="inline-flex items-center">
          {/* The font's sign, at least two lines tall and stretching with the body, the limits at its top and foot, so a filled-in integral doesn't read as squashed. */}
          <span className="inline-flex min-h-[2.3em] items-stretch self-stretch py-[0.1em]">
            <IntegralSign />
            {node.lo && (
              <span className="inline-flex flex-col justify-between text-[0.62em]">
                <span className="ml-[0.1em] inline-flex">{slot("hi")}</span>
                <span className="ml-[0.05em] inline-flex">{slot("lo")}</span>
              </span>
            )}
          </span>
          <span className="inline-flex items-center pl-[0.1em]">{slot("body")}</span>
          <span className="inline-flex items-center pl-[0.15em]">
            <span>d</span>
            <span className="inline-flex items-center italic">{slot("v")}</span>
          </span>
        </span>
      );
    case "deriv":
      return (
        <span className="inline-flex items-center">
          <span className="mx-[0.1em] inline-flex flex-col items-center text-[0.92em]">
            <span className="inline-flex items-start px-[0.1em] pb-[0.1em]">
              d{node.n && <span className="inline-flex items-center text-[0.72em]">{slot("n")}</span>}
            </span>
            <span className="h-px w-full bg-casInk" />
            <span className="inline-flex items-start px-[0.1em] pt-[0.1em]">
              d{slot("v")}
              {node.n && <span className="inline-flex items-center text-[0.72em]">{slot("n")}</span>}
            </span>
          </span>
          <Grouped open="(">{slot("body")}</Grouped>
        </span>
      );
    case "bigop":
      return (
        <span className="inline-flex items-center">
          <Stack
            top={slot("hi")}
            bottom={
              <>
                {slot("v")}
                <span>=</span>
                {slot("lo")}
              </>
            }
          >
            <span className="text-[1.4em] leading-none">{node.op}</span>
          </Stack>
          <Grouped open="(">{slot("body")}</Grouped>
        </span>
      );
    case "limit":
      return (
        <span className="inline-flex items-center">
          <Stack
            bottom={
              <>
                {slot("v")}
                <span>→</span>
                {slot("to")}
              </>
            }
          >
            <span>lim</span>
          </Stack>
          <Grouped open="(">{slot("body")}</Grouped>
        </span>
      );
    case "logbase":
      return (
        <span className="inline-flex items-end">
          <span>log</span>
          <span className="-mb-[0.55em] inline-flex items-center text-[0.62em]">{slot("base")}</span>
          <Grouped open="(">{slot("arg")}</Grouped>
        </span>
      );
  }
}

function Char({ c, prev, style }: { c: string; prev?: Node; style: Style }) {
  if (c === "*") return <span className="px-[0.06em]">·</span>;
  if (c === "-") {
    const neg = !prev || (prev.t === "ch" && NEG_AFTER.has(prev.c));
    // Negation: the handheld's short raised dash, a bold minus narrowed (a
    // hyphen all but vanished in an exponent). Subtraction: a full-width minus.
    return neg ? (
      <span className="relative -top-[0.13em] -mx-[0.06em] inline-block scale-x-[0.66]">−</span>
    ) : (
      <span className="px-[0.1em]">−</span>
    );
  }
  if (c === "+" || c === "→") return <span className="px-[0.1em]">{c}</span>;
  // A little room after a comma: {−1.,2.,−3.5} ran together.
  if (c === ",") return <span className="pr-[0.12em]">,</span>;
  if (c === " ") return <span className="inline-block w-[0.3em]" />;
  if (isLetter(c) && style === "var") return <span className="italic">{c}</span>;
  if (isLetter(c) && style === "def") return <span className="font-bold italic">{c}</span>;
  if (style === "def") return <span className="font-bold">{c}</span>;
  // Euler's number, typed or in an answer: a bold upright e, as the handheld draws it.
  if (c === "ℯ") return <span className="font-bold">e</span>;
  if (isDigitLike(c) || c === "π" || c === "∞") return <span>{c}</span>;
  return <span>{c}</span>;
}
