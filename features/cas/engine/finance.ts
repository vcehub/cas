// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 VCE Hub. Part of the /cas calculator: https://github.com/vcehub/cas
import { amortize, effectiveRate, nominalRate, roundDecimal, solveTvm, type Tvm, type TvmField } from "../finance/tvm";
import { EngineError } from "./format";
import { UnsupportedError } from "./translate";

/**
 * The handheld's finance functions, which Giac has none of: the TVM
 * functions (the Finance Solver as a function), eff and nom, and the
 * amortisation functions amortTbl, bal, ΣInt and ΣPrn. Arguments arrive
 * worked out to numbers; the answer is a number, or amortTbl's table.
 *
 * Defaults: PpY=1, CpY=1 (not PpY, as on the
 * Finance Solver screen), PmtAt=0 (end), and for the amortisation
 * functions FV=0, Pmt=tvmPmt(N,I,PV,FV,PpY,CpY,PmtAt) and roundValue=2.
 * bal(5,6,5.75,5000,,12,12) bears out CpY=1: its 12 is FV and
 * PpY, and only with CpY=1 is the first month's interest 23.35.
 */
export const FINANCE = new Set(["tvmFV", "tvmPV", "tvmPmt", "tvmN", "tvmI", "eff", "nom", "amortTbl", "bal", "ΣInt", "ΣPrn"]);

/** An argument worked out: a number, an empty slot, a matrix of numbers (an amortisation table) or anything else. */
export type FinanceArg = { k: "num"; v: number } | { k: "empty" } | { k: "table"; rows: number[][] } | { k: "other" };

/** amortTbl's answer: rows of payment number, interest, principal and balance. */
export type FinanceValue = number | { table: number[][] };

const TVM: Record<string, TvmField> = { tvmN: "n", tvmI: "i", tvmPV: "pv", tvmPmt: "pmt", tvmFV: "fv" };
const FIELDS: TvmField[] = ["n", "i", "pv", "pmt", "fv"];
/** More rows than any loan has: a guard against a typo running for minutes. */
const MAX_PAYMENTS = 100_000;

/**
 * The function's value, or null when an argument isn't a number (a variable
 * with no value): the call is then left as it was typed. Errors are thrown
 * as the handheld's messages.
 */
export function finance(f: string, args: FinanceArg[]): FinanceValue | null {
  const field = TVM[f];
  if (field) {
    count(args, 4, 7);
    const given = FIELDS.filter((x) => x !== field);
    const values = required(args.slice(0, 4));
    if (!values) return null;
    const rest = options(args.slice(4));
    if (!rest) return null;
    const t = { n: 0, i: 0, pv: 0, pmt: 0, fv: 0, ...Object.fromEntries(given.map((x, k) => [x, values[k]!])), ...rest } as Tvm;
    return finite(solveTvm(t, field));
  }
  if (f === "eff" || f === "nom") {
    count(args, 2, 2);
    const values = required(args);
    if (!values) return null;
    const [rate, cpy] = values as [number, number];
    if (!(cpy > 0)) throw new EngineError("Error: Domain error");
    return finite(f === "eff" ? effectiveRate(rate, cpy) : nominalRate(rate, cpy));
  }
  // The amortisation functions: bal(NPmt,…), amortTbl(NPmt,…), ΣInt(NPmt1,NPmt2,…), ΣPrn(NPmt1,NPmt2,…).
  const ranged = f === "ΣInt" || f === "ΣPrn";
  const lead = ranged ? 2 : 1;
  const table = args[lead];
  if (f !== "amortTbl" && table && args.length === lead + 1) {
    const span = payments(args.slice(0, lead), ranged);
    if (table.k === "num" || table.k === "empty") throw new EngineError("Error: Too few arguments");
    if (!span || table.k !== "table") return null;
    return fromTable(f, span, table.rows);
  }
  count(args, lead + 3, lead + 9);
  const span = payments(args.slice(0, lead), ranged);
  const values = required(args.slice(lead, lead + 3));
  if (!span || !values) return null;
  const [n, i, pv] = values as [number, number, number];
  const [pmtArg, fvArg, ...more] = args.slice(lead + 3);
  const rest = options(more.slice(0, 3));
  const places = more[3] && more[3].k !== "empty" ? whole(more[3], 0, 12) : 2;
  if (!rest || places === null) return null;
  const fv = optional(fvArg, 0);
  if (fv === null) return null;
  // Payments at the start of each period: whether the handheld charges the first period's
  // interest isn't known yet, so no table is made up for them.
  if (rest.begin) throw new UnsupportedError(f);
  const tvm: Tvm = { n, i, pv, pmt: 0, fv, ...rest };
  const pmt = pmtArg && pmtArg.k !== "empty" ? optional(pmtArg, 0) : finite(solveTvm(tvm, "pmt"));
  if (pmt === null) return null;
  const last = span[span.length - 1]!;
  const rows = amortize({ ...tvm, pmt }, last, places);
  if (f === "amortTbl") return { table: rows.map((r) => [r.n, r.interest, r.principal, r.balance]) };
  if (f === "bal") return rows[last]!.balance;
  const from = rows.slice(span[0]!, last + 1);
  return roundDecimal(from.reduce((s, r) => s + (f === "ΣInt" ? r.interest : r.principal), 0), places);
}

/** bal, ΣInt and ΣPrn of a table amortTbl made: its rows read off and added up. */
function fromTable(f: string, span: number[], rows: number[][]): number {
  if (rows.some((r) => r.length !== 4)) throw new EngineError("Error: Dimension error");
  const last = span[span.length - 1]!;
  if (last >= rows.length) throw new EngineError("Error: Dimension error");
  if (f === "bal") return rows[last]![3]!;
  const column = f === "ΣInt" ? 1 : 2;
  const sum = rows.slice(span[0]!, last + 1).reduce((s, r) => s + r[column]!, 0);
  // The handheld adds in decimal: −79.17−72.71−66.23 is −218.11, not −218.10999….
  return Number(sum.toPrecision(14));
}

function count(args: FinanceArg[], min: number, max: number): void {
  if (args.length < min) throw new EngineError("Error: Too few arguments");
  if (args.length > max) throw new EngineError("Error: Too many arguments");
}

/** Arguments that must be given, as numbers; null if one isn't a number. */
function required(args: FinanceArg[]): number[] | null {
  if (args.some((a) => a.k === "empty")) throw new EngineError("Error: Too few arguments");
  if (args.some((a) => a.k !== "num")) return null;
  return args.map((a) => (a as { v: number }).v);
}

function optional(a: FinanceArg | undefined, fallback: number): number | null {
  if (!a || a.k === "empty") return fallback;
  return a.k === "num" ? a.v : null;
}

/** PpY and CpY (whole numbers above 0, default 1) and PmtAt (0 for the end of each period, 1 for the start). */
function options(args: FinanceArg[]): { ppy: number; cpy: number; begin: boolean } | null {
  const [ppy, cpy, at] = [args[0], args[1], args[2]];
  const p = ppy && ppy.k !== "empty" ? whole(ppy, 1, Infinity) : 1;
  const c = cpy && cpy.k !== "empty" ? whole(cpy, 1, Infinity) : 1;
  const a = at && at.k !== "empty" ? whole(at, 0, 1) : 0;
  if (p === null || c === null || a === null) return null;
  return { ppy: p, cpy: c, begin: a === 1 };
}

/** A whole number in [lo, hi], or null if it isn't a number at all. */
function whole(a: FinanceArg, lo: number, hi: number): number | null {
  if (a.k !== "num") return null;
  if (!Number.isInteger(a.v) || a.v < lo || a.v > hi) throw new EngineError("Error: Domain error");
  return a.v;
}

/** The payment numbers asked for: NPmt (1 or more), or NPmt1 to NPmt2. */
function payments(args: FinanceArg[], ranged: boolean): number[] | null {
  if (args.some((a) => a.k === "empty")) throw new EngineError("Error: Too few arguments");
  const span = args.map((a) => whole(a, 1, MAX_PAYMENTS));
  if (span.some((x) => x === null)) return null;
  if (ranged && span[0]! > span[1]!) throw new EngineError("Error: Domain error");
  return span as number[];
}

/** A value the maths can't give (no rate fits, no positive N) is the Finance Solver's error. */
function finite(v: number): number {
  if (!Number.isFinite(v)) throw new EngineError("Error: No solution found");
  return v;
}
