// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 VCE Hub. Part of the /cas calculator: https://github.com/vcehub/cas
import type { Key } from "../keys";
import { parse } from "../math/ast";
import * as E from "../math/editor";
import { astToRow, chars } from "../math/tree";
import type { CalculatorPage, HistorySelection } from "../state/document";

/**
 * The Calculator's response to a key, as a pure function. Evaluation is
 * asynchronous, so Enter returns an effect for the app to run.
 */
export type CalcEffect = { evaluate: "exact" | "approx" } | null;

/**
 * Something that needs a left side, put first on an empty entry line, works
 * on the last answer: the handheld writes ans in front of it. The operator
 * keys do it (5, Enter, then +1 reads ans+1 and gives 6, which is how 1000
 * then ×1.05 Enter Enter … steps a recurrence), and so does a conversion
 * such as ▶Decimal from a menu or the catalog. The minus sign is left out: from a computer keyboard
 * a leading - is a negative number, and the keypad's subtraction and
 * negation keys both type it here.
 */
const NEEDS_LEFT = /^[+*/^×÷·▶►]/;
const onAns = (s: E.EditState, typed: string) => (!s.row.length && NEEDS_LEFT.test(typed) ? E.insertText(s, "ans") : s);

export function calcKey(
  page: CalculatorPage,
  key: Key,
  /** How far the selected item can scroll (0 if it fits), measured on screen. */
  maxScroll = 0,
): { page: CalculatorPage; effect: CalcEffect } {
  const done = (p: Partial<CalculatorPage>, effect: CalcEffect = null) => ({ page: { ...page, ...p }, effect });
  const edit = (fn: (s: E.EditState) => E.EditState) => done({ edit: fn(page.edit), sel: null });

  if (page.sel?.caret) return caretKey(page, page.sel, page.sel.caret, key);

  if (page.sel) {
    const sel = page.sel;
    switch (key.k) {
      case "up":
        return done({ sel: stepUp(sel) });
      case "down":
        return done({ sel: stepDown(sel, page.history.length) });
      case "enter":
        // Enter on a history item pastes it at the cursor, as on the handheld.
        return done({ edit: pasteWhole(page, sel), sel: null });
      // A too-wide item scrolls with → and ←; otherwise they leave the history.
      case "right": {
        const at = sel.scroll ?? 0;
        return at < maxScroll ? done({ sel: { ...sel, scroll: at + 1 } }) : done({ sel: null });
      }
      case "left": {
        const at = sel.scroll ?? 0;
        return at > 0 ? done({ sel: { ...sel, scroll: at - 1 } }) : done({ sel: null });
      }
      // Del on a history item removes the entry and its result, as on the handheld.
      case "backspace":
      case "delete": {
        const history = page.history.filter((_, i) => i !== sel.entry);
        const next: HistorySelection | null = history[sel.entry]
          ? { entry: sel.entry, part: sel.part }
          : sel.entry > 0
            ? { entry: sel.entry - 1, part: "output" }
            : null;
        return done({ history, sel: next });
      }
      case "esc":
        return done({ sel: null });
      default:
        // Anything else drops the selection and acts on the entry line.
        return calcKey({ ...page, sel: null }, key);
    }
  }

  if (E.selection(page.edit)) {
    const r = E.keyOnSelection(page.edit, key);
    return r.done ? done({ edit: r.edit }) : calcKey({ ...page, edit: r.edit }, key);
  }

  switch (key.k) {
    case "selectAll":
      return edit(E.selectAll);
    case "selectLeft":
      return edit((s) => E.extendSelection(s, "left"));
    case "selectRight":
      return edit((s) => E.extendSelection(s, "right"));
    case "char":
      return edit((s) => E.typeChar(onAns(s, key.c), key.c));
    case "text":
      return edit((s) => E.insertText(onAns(s, key.text), key.text));
    case "paste":
      return edit((s) => E.insertText(s, key.text));
    case "template":
      return edit((s) => E.insertTemplate(s, key.id));
    case "backspace":
      return edit(E.backspace);
    case "delete":
      return edit(E.deleteForward);
    case "left":
      return edit(E.moveLeft);
    case "right":
      return edit(E.moveRight);
    case "home":
      return edit(E.moveHome);
    case "end":
      return edit(E.moveEnd);
    case "tab":
      return edit(E.nextSlot);
    case "clear":
      return done({ edit: E.emptyEdit(), sel: null });
    case "up": {
      const moved = E.moveVertical(page.edit, "up");
      if (moved) return done({ edit: moved });
      const last = page.history.length - 1;
      return last >= 0 ? done({ sel: { entry: last, part: "output" } }) : done({});
    }
    case "down": {
      const moved = E.moveVertical(page.edit, "down");
      return moved ? done({ edit: moved }) : done({});
    }
    case "enter":
      return done({}, page.edit.row.length ? { evaluate: "exact" } : null);
    case "approx":
      return done({}, page.edit.row.length ? { evaluate: "approx" } : null);
    default:
      return done({});
  }
}

/** A history item's text as a row for the entry line. */
function pasteWhole(page: CalculatorPage, sel: HistorySelection): E.EditState {
  const h = page.history[sel.entry];
  if (!h) return page.edit;
  const text = sel.part === "input" ? h.inputText : h.outputText;
  let row;
  try {
    row = astToRow(parse(text));
  } catch {
    row = chars(text);
  }
  return E.insertRow(page.edit, row);
}

/**
 * A key while a clicked history line holds the caret. The arrows move it,
 * shift+arrows and Ctrl+A select, Enter pastes the selection (or the whole
 * line) into the entry line. The line itself can't be changed: del does
 * nothing, and typing goes to the entry line.
 */
function caretKey(page: CalculatorPage, sel: HistorySelection, c: E.EditState, key: Key) {
  const done = (p: Partial<CalculatorPage>) => ({ page: { ...page, ...p }, effect: null });
  const move = (caret: E.EditState) => done({ sel: { ...sel, caret } });
  const plain = { row: c.row, cursor: c.cursor };
  const r = E.selection(c);
  const whole: HistorySelection = { entry: sel.entry, part: sel.part };
  switch (key.k) {
    case "left":
      return move(r ? { row: c.row, cursor: { path: r.path, index: r.from } } : E.moveLeft(plain));
    case "right":
      return move(r ? { row: c.row, cursor: { path: r.path, index: r.to } } : E.moveRight(plain));
    case "selectLeft":
      return move(E.extendSelection(c, "left"));
    case "selectRight":
      return move(E.extendSelection(c, "right"));
    case "selectAll":
      return move(E.selectAll(c));
    case "home":
      return move(E.moveHome(plain));
    case "end":
      return move(E.moveEnd(plain));
    case "up":
    case "down": {
      const v = E.moveVertical(plain, key.k);
      if (v) return move(v);
      return done({ sel: key.k === "up" ? stepUp(whole) : stepDown(whole, page.history.length) });
    }
    case "enter":
      return done({ edit: r ? E.insertRow(page.edit, E.selectedNodes(c)) : pasteWhole(page, sel), sel: null });
    case "backspace":
    case "delete":
    case "cut":
      return done({});
    case "esc":
      return done({ sel: null });
    default:
      return calcKey({ ...page, sel: null }, key);
  }
}

function stepUp(sel: HistorySelection): HistorySelection {
  if (sel.part === "output") return { entry: sel.entry, part: "input" };
  return sel.entry > 0 ? { entry: sel.entry - 1, part: "output" } : sel;
}

function stepDown(sel: HistorySelection, count: number): HistorySelection | null {
  if (sel.part === "input") return { entry: sel.entry, part: "output" };
  return sel.entry < count - 1 ? { entry: sel.entry + 1, part: "input" } : null;
}

/**
 * What OK on a wizard puts in the entry line. Most wizards build plain text;
 * a few build a template with the cursor in its first box.
 */
export function wizardInsert(s: E.EditState, built: string): E.EditState {
  const [kind, ...parts] = built.split(":");
  if (kind === "system" || kind === "linsystem") {
    const n = Math.max(1, Math.min(6, Number(parts[0]) || 2));
    const vars = parts[1] ?? "x,y";
    const opened = E.insertText(s, kind === "system" ? "solve(" : "linSolve(");
    const rows = Array.from({ length: n }, () => []);
    return E.insertNodes(opened, [{ t: "system", rows }, ...chars(`,{${vars}}`)], { offset: 0, slot: "s.0" });
  }
  if (kind === "polyroots") return E.insertText(s, parts[1] === "Complex" ? "cPolyRoots(" : "polyRoots(");
  if (kind === "derivat") {
    const [v = "x", at = "", order = ""] = parts;
    const second = order.startsWith("2");
    return E.insertNodes(
      s,
      [{ t: "deriv", v: chars(v), body: [], ...(second ? { n: chars("2") } : {}) }, ...chars(`|${v}=${at}`)],
      { offset: 0, slot: "body" },
    );
  }
  return E.insertText(s, built);
}
