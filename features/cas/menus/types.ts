// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 VCE Hub. Part of the /cas calculator: https://github.com/vcehub/cas
/**
 * Menu data for the CAS apps. Each app's menu is a tree whose order is the
 * point: an item's key (1–9, then A–Z) comes from its position, so a
 * student's keystrokes ("menu 3 1") reach the command they expect. Items
 * we haven't built yet stay in the tree with no action and render greyed,
 * so those keystrokes keep working.
 */

/** 2D templates the editor can insert (see math/tree.ts). */
export type TemplateId =
  | "frac"
  | "pow"
  | "sqrt"
  | "nroot"
  | "abs"
  | "exp"
  | "logbase"
  | "deriv"
  | "nderiv"
  | "integral"
  | "defintegral"
  | "limit"
  | "sum"
  | "product"
  | "piecewise2"
  | "system2"
  | "matrix";

/** A field in a wizard dialog: a label, its starting value, and grey text shown while it's empty. */
export type WizardField = {
  label: string;
  value?: string;
  options?: string[];
  hint?: string;
  /** A dropdown that also takes typing, such as Window Settings' XScale (Auto, or a number). */
  free?: boolean;
  /** A checkbox with its label beside it; the value is "Yes" or "No". */
  check?: boolean;
};

export type MenuAction =
  /** Type text at the cursor. A trailing "(" gets its ")" auto-paired. */
  | { kind: "insert"; text: string }
  | { kind: "template"; template: TemplateId }
  /**
   * A dialog that builds the call from its fields: `build` has {0}, {1} …
   * for the field values. Fields left blank are dropped from the end.
   */
  | {
      kind: "wizard";
      title: string;
      fields: WizardField[];
      build: string;
      /** false: the arrow button only on dropdown fields (Window Settings). */
      arrows?: boolean;
    }
  /** An app-level action handled by the app, e.g. "clearHistory". */
  | { kind: "app"; id: string };

export type MenuItem = {
  label: string;
  action?: MenuAction;
  items?: MenuItem[];
  /** Set when the label or position is a guess. */
  unverified?: boolean;
  /** A rule drawn above this item, between groups. */
  rule?: boolean;
  /** A keyboard shortcut shown at the right of the row, e.g. "Ctrl+T". */
  hint?: string;
};

export type Menu = MenuItem[];

const KEYS = "123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** The shortcut key for the item at `index` in its list. */
export function menuKey(index: number): string {
  return KEYS[index] ?? "";
}

/** Index of the item a pressed key selects, or -1. */
export function menuIndexForKey(key: string): number {
  return KEYS.indexOf(key.toUpperCase());
}

/** A submenu always opens, as on the handheld, even when everything in it is greyed. */
export function isEnabled(item: MenuItem): boolean {
  return Boolean(item.action) || Boolean(item.items);
}

// Builders keep the data files short.
export const ins = (label: string, text: string): MenuItem => ({
  label,
  action: { kind: "insert", text },
});
export const tpl = (label: string, template: TemplateId): MenuItem => ({
  label,
  action: { kind: "template", template },
});
export const app = (label: string, id: string): MenuItem => ({
  label,
  action: { kind: "app", id },
});
export const wiz = (
  label: string,
  title: string,
  fields: WizardField[],
  build: string,
): MenuItem => ({ label, action: { kind: "wizard", title, fields, build } });
export const sub = (label: string, items: MenuItem[]): MenuItem => ({ label, items });
/** Present on the handheld, not built here yet: shown greyed. */
export const off = (label: string): MenuItem => ({ label });
/** Starts a new group: a rule above it. */
export const rule = (item: MenuItem): MenuItem => ({ ...item, rule: true });
