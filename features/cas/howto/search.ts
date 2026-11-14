// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 VCE Hub. Part of the /cas calculator: https://github.com/vcehub/cas
import { typedName } from "./paths";
import type { HowTo, Subject } from "./types";

/**
 * Search in a question's words. Every entry's title, search words, command
 * and "when" line are split into words; each word of the query has to land
 * somewhere, exactly, as the start of a word, as a word with a different
 * ending (differentiate, differentiating) or with one slip in a long word.
 * Title and search words count most. Small words ("how do I find the …")
 * are dropped.
 */

const STOP = new Set(
  "a an and the of to in on for with by is are it my me i do does how what when where which find work out get use using calculate calc cas calculator nspire ti can you value".split(
    " ",
  ),
);

/**
 * Maths a student types into the box, read as the words it stands for:
 * Pr(X = 4) is "exactly", A^-1 "inverse", a.b "dot", u(n+1) "recurrence",
 * f'(x) "prime", f(3) "substitute", > "inequality".
 */
function mathsAsWords(s: string): string {
  return s
    .replace(/\|\s*[a-z~_]+\s*\|/gi, " magnitude ")
    .replace(/\|[^|]+\|/g, " absolute value ")
    .replace(/\d\s*\^\s*\(?\s*[a-z]\s*\)?\s*=?\s*[\d.]*/gi, " exponential equation ")
    .replace(/\b[a-z]\s*\(\s*[a-z]\s*\(/gi, " composite ")
    .replace(/\b[A-Z]{1,2}\s*=\s*[A-Z]\b/g, " matrix equation ")
    .replace(/pr\s*\(\s*[a-z]\s*=/gi, " exactly ")
    .replace(/pr\s*\(\s*[a-z]\s*(≤|<=|<)/gi, " cumulative ")
    .replace(/\b[A-Z]\s*\^\s*\(?\s*-\s*1/g, " matrix inverse ")
    .replace(/\b[a-z]\s*['′]+\s*\(\s*-?[\d.]/gi, " gradient at point ")
    .replace(/\bx\S*\s*[+\-*]\s*\S*y\b|\by\S*\s*[+\-*]\s*\S*x\b/gi, " implicit ")
    .replace(/\^\s*\(?\s*-\s*1\s*\)?|⁻¹/g, " inverse ")
    .replace(/\b[a-z]\s*[.·]\s*[a-z]\b/gi, " dot product ")
    .replace(/\b[a-z]\s*[×]\s*[a-z]\b/gi, " cross product ")
    .replace(/\b[a-z]\s*_?\(?\s*n\s*[+-]\s*1\s*\)?/gi, (m) => (/[a-z]\s*[_(]?\s*n/i.test(m) ? " recurrence " : m))
    .replace(/\b([a-z])\s*['′]+/gi, " $1 prime ")
    .replace(/\b[fgh]\s*\(\s*-?\d/gi, " substitute ")
    .replace(/pr\s*\(\s*[a-z]\s*(≥|>=)\s*1\s*\)|pr\s*\(\s*[a-z]\s*>\s*0\s*\)/gi, " at least one ")
    .replace(/\bp\s*-?\s*values?\b/gi, " pvalue ")
    .replace(/\(\s*[\d.]*\s*[+-]?\s*[\d.]*\s*i\s*\)\s*\^/gi, " complex power ")
    .replace(/\bz\s*\^/gi, " complex ")
    // a ≤ x ≤ b is a domain; a lone < or > is an inequality.
    .replace(/-?[\w.π]+\s*(≤|<=|<)\s*[a-z]\s*(≤|<=|<)\s*-?[\w.π]+/gi, " domain interval ")
    .replace(/\b[a-z]\s*=\s*-?\d/gi, " substitute ")
    .replace(/pr\s*\(\s*[a-z]\s*(≥|>=|>)\s*[\w.]+\s*\)/gi, " probability ")
    .replace(/[<>≤≥]/g, " inequality ");
}

/** Lower case, accents off, maths symbols as words, everything else a space. */
export function normalise(s: string): string {
  return s
    .toLowerCase()
    .replace(/²/g, "2")
    .replace(/³/g, "3")
    .replace(/∫/g, " integral ")
    .replace(/√/g, " root ")
    .replace(/π/g, " pi ")
    .replace(/[σ]/g, " sigma ")
    .replace(/[μ]/g, " mu ")
    .replace(/\|/g, " such that ")
    .replace(/:=/g, " store ")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const wordsOf = (s: string) => normalise(s).split(" ").filter(Boolean);

type Field = { words: string[]; weight: number };
type Indexed = { entry: HowTo; fields: Field[]; phrases: string[]; owned: string[] };

const index = new WeakMap<HowTo, Indexed>();
function indexed(entry: HowTo): Indexed {
  let x = index.get(entry);
  if (!x) {
    const command = typedName(entry)?.replace(/\($/, "") ?? "";
    x = {
      entry,
      fields: [
        { words: wordsOf(entry.title), weight: 7 },
        // Single owned words score as words; owned phrases only as a whole (below).
        { words: (entry.owns ?? []).map(normalise).filter((w) => !w.includes(" ")), weight: 8 },
        { words: entry.words.flatMap(wordsOf), weight: 6 },
        { words: wordsOf(command), weight: 5 },
        { words: wordsOf(entry.when), weight: 2 },
      ],
      phrases: [entry.title, ...entry.words].map(normalise),
      owned: (entry.owns ?? []).map(normalise).filter((w) => w.includes(" ")),
    };
    index.set(entry, x);
  }
  return x;
}

/** One substitution, insertion, deletion or swap apart. */
function oneSlip(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const restA = a.slice(i);
  const restB = b.slice(i);
  if (restA.slice(1) === restB.slice(1)) return true; // substitution
  if (restA.slice(1) === restB || restA === restB.slice(1)) return true; // insertion/deletion
  return restA.length > 1 && restA[0] === restB[1] && restA[1] === restB[0] && restA.slice(2) === restB.slice(2); // swap
}

/** How well a query word matches a word of the entry, 0 to 1. */
function wordScore(q: string, w: string): number {
  if (q === w) return 1;
  if (q.length >= 2 && w.startsWith(q)) return 0.8;
  // The same word with another ending: differentiate, differentiation.
  let p = 0;
  while (p < q.length && p < w.length && q[p] === w[p]) p++;
  if (p >= 5 && p >= Math.min(q.length, w.length) - 3) return 0.7;
  if (q.length >= 5 && oneSlip(q, w)) return 0.5;
  return 0;
}

function score(x: Indexed, terms: string[], whole: string): { score: number; hits: number } {
  let total = 0;
  let hits = 0;
  for (const t of terms) {
    let best = 0;
    for (const f of x.fields) for (const w of f.words) best = Math.max(best, wordScore(t, w) * f.weight);
    if (best > 0) hits++;
    total += best;
  }
  // The whole query as a phrase: "at least one", "area between".
  if (terms.length > 1 && x.phrases.some((p) => p.includes(whole))) total += 8;
  // An owned phrase said in full: "average rate of change" is that entry's.
  if (x.owned.some((p) => ` ${whole} `.includes(` ${p.split(" ").filter((w) => !STOP.has(w)).join(" ")} `))) total += 10;
  // The plainer task first: "binomial" is Binomial: exactly k before Binomial: a range.
  const extra = x.fields[0]!.words.filter((w) => !STOP.has(w) && w.length > 1 && !terms.some((t) => wordScore(t, w) > 0));
  total -= 0.3 * Math.min(3, extra.length);
  return { score: total, hits };
}

/**
 * Entries matching a search, best first. Every word has to land; when no
 * entry takes them all, the ones that take the most are shown instead.
 */
export function searchHowTo(all: HowTo[], query: string, subject: Subject | null = null, limit = 8): HowTo[] {
  // Letters and numbers left from pasted maths (x, 2, x2) are noise, not words.
  const terms = wordsOf(mathsAsWords(query)).filter((t) => !STOP.has(t) && t.length > 1 && !/\d/.test(t));
  if (!terms.length) return [];
  const whole = terms.join(" ");
  const scored = all
    .map((entry) => {
      const s = score(indexed(entry), terms, whole);
      // The student's own subject first, others still found.
      const boost = subject && entry.subjects.includes(subject) ? 1.25 : 1;
      return { entry, score: s.score * boost, hits: s.hits };
    })
    .filter((s) => s.hits > 0);
  const most = Math.max(0, ...scored.map((s) => s.hits));
  // A half-matching query still shows something, but only the entries that match the most words.
  const need = most === terms.length ? terms.length : Math.max(1, most);
  return scored
    .filter((s) => s.hits >= need)
    .sort((p, q) => q.score - p.score)
    .slice(0, limit)
    .map((s) => s.entry);
}
