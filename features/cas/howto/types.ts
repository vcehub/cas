// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 VCE Hub. Part of the /cas calculator: https://github.com/vcehub/cas
import type { Key } from "../keys";

/**
 * "How do I…": a catalogue of what the calculator does, by task. Each entry
 * is a task in a question's words; the command is the answer, not the title.
 */

export type Subject = "methods" | "specialist" | "general";

export type Group =
  | "basics"
  | "algebra"
  | "calculus"
  | "graphs"
  | "probability"
  | "statistics"
  | "vectors"
  | "complex"
  | "de"
  | "matrices"
  | "finance";

/** The menus a way can go through. Paths name items by label, so a moved item fails the check. */
export type MenuName = "calculator" | "graphs" | "doc" | "addPage";

/** One way to do it on the calculator. The first way is what Show me does. */
export type Way =
  /** A trip through a menu, ending on the item that does it; `then` is typed after, for Show me. */
  | { kind: "menu"; menu: MenuName; path: string[]; then?: Key[] }
  /**
   * Keys pressed together or in turn ("ctrl", "enter"), with the computer
   * keyboard's way, and what Show me plays on the calculator.
   */
  | { kind: "keys"; caps: string[]; kbd: string | null; say: string; play: Key[] }
  /** Text typed on the entry line ("|", ":="). */
  | { kind: "type"; text: string; say: string };

export type Example = {
  input: string;
  /** What the engine gives. Empty for a line with no answer (a graph's function). */
  output: string;
  /** Run with ctrl Enter. */
  approx?: boolean;
};

export type HowTo = {
  /** The URL slug: /cas?how=<id>. */
  id: string;
  title: string;
  /** When you'd reach for it, in a question's words. */
  when: string;
  group: Group;
  subjects: Subject[];
  /** Words a student might search with, besides the title. */
  words: string[];
  /**
   * Words this entry is the home for, outranking a title that happens to
   * contain them: "differentiation" is Derivative, not Implicit
   * differentiation. Use sparingly.
   */
  owns?: string[];
  ways: Way[];
  /** How the command is written, where the menu item alone doesn't say. Otherwise taken from the catalog. */
  syntax?: string;
  /** Entries and what the calculator gives them, run in a fresh engine in order. */
  example: Example[];
  /** The mistake this one is prone to, in one short sentence. */
  watch?: string;
  /**
   * A reference list in place of a single task: what to press on a computer
   * keyboard, in titled groups. An entry with these needs no way, and has no Show me.
   */
  shortcuts?: { title: string; rows: { keys: string[]; does: string }[] }[];
};

export const GROUPS: { id: Group; title: string }[] = [
  { id: "basics", title: "Basics" },
  { id: "algebra", title: "Algebra" },
  { id: "calculus", title: "Calculus" },
  { id: "graphs", title: "Graphs" },
  { id: "probability", title: "Probability" },
  { id: "statistics", title: "Statistics" },
  { id: "vectors", title: "Vectors" },
  { id: "complex", title: "Complex numbers" },
  { id: "de", title: "Differential equations" },
  { id: "matrices", title: "Matrices" },
  { id: "finance", title: "Finance and recursion" },
];

export const SUBJECTS: { id: Subject; title: string }[] = [
  { id: "methods", title: "Methods" },
  { id: "specialist", title: "Specialist" },
  { id: "general", title: "General" },
];
