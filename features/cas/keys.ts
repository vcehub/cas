// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 VCE Hub. Part of the /cas calculator: https://github.com/vcehub/cas
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { TemplateId } from "./menus/types";

/**
 * One key press, from the keyboard or the on-screen keypad. Apps handle
 * these rather than raw DOM events, so the keypad and the keyboard can't
 * drift apart.
 */
export type Key =
  | { k: "char"; c: string }
  | { k: "text"; text: string }
  | { k: "template"; id: TemplateId }
  | { k: "enter" }
  | { k: "approx" }
  | { k: "backspace" }
  | { k: "delete" }
  | { k: "left" }
  | { k: "right" }
  | { k: "up" }
  | { k: "down" }
  | { k: "home" }
  | { k: "end" }
  | { k: "tab" }
  | { k: "esc" }
  | { k: "menu" }
  | { k: "doc" }
  | { k: "clear" }
  | { k: "insertPage" }
  | { k: "prevPage" }
  | { k: "nextPage" }
  | { k: "table" }
  | { k: "copy" }
  | { k: "cut" }
  | { k: "selectAll" }
  | { k: "undo" }
  | { k: "redo" }
  | { k: "selectLeft" }
  | { k: "selectRight" }
  | { k: "paste"; text: string };

/** Keyboard → Key, following the handheld's computer software where it has a shortcut. */
export function keyFromEvent(e: KeyboardEvent | ReactKeyboardEvent): Key | null {
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl) {
    switch (e.key.toLowerCase()) {
      case "enter":
        return { k: "approx" };
      case "m":
        return { k: "menu" };
      case "k":
        return { k: "doc" };
      case "i":
        return { k: "insertPage" };
      case "arrowleft":
        return { k: "prevPage" };
      case "arrowright":
        return { k: "nextPage" };
      case "t":
        return { k: "table" };
      case "/":
        return { k: "template", id: "frac" };
      case "r":
        return { k: "template", id: "sqrt" };
      case "c":
        return { k: "copy" };
      case "x":
        return { k: "cut" };
      case "a":
        return { k: "selectAll" };
      case "z":
        return e.shiftKey ? { k: "redo" } : { k: "undo" };
      case "y":
        return { k: "redo" };
      default:
        return null;
    }
  }
  switch (e.key) {
    case "Enter":
      return { k: "enter" };
    case "Backspace":
      return { k: "backspace" };
    case "Delete":
      return { k: "delete" };
    case "ArrowLeft":
      return e.shiftKey ? { k: "selectLeft" } : { k: "left" };
    case "ArrowRight":
      return e.shiftKey ? { k: "selectRight" } : { k: "right" };
    case "ArrowUp":
      return { k: "up" };
    case "ArrowDown":
      return { k: "down" };
    case "Home":
      return { k: "home" };
    case "End":
      return { k: "end" };
    case "Tab":
      return { k: "tab" };
    case "Escape":
      return { k: "esc" };
    case "ContextMenu":
      return { k: "menu" };
  }
  if (e.key.length === 1 && !e.altKey) return { k: "char", c: e.key };
  return null;
}
