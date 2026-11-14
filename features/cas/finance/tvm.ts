// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 VCE Hub. Part of the /cas calculator: https://github.com/vcehub/cas
/**
 * Time value of money, as the handheld's Finance Solver works it: cash in
 * is positive, cash out negative, interest I(%) is a nominal annual rate
 * compounded CpY times a year, with PpY payments a year made at the end
 * (or start) of each period. Any one of N, I(%), PV, Pmt and FV is found
 * from the other four by
 *
 *   0 = PV + (1 + i·k)·Pmt·(1 − (1+i)^−N)/i + FV·(1+i)^−N
 *
 * where i is the interest per payment period and k is 1 for payments at
 * the start of each period, else 0.
 */
export type Tvm = {
  n: number;
  i: number;
  pv: number;
  pmt: number;
  fv: number;
  ppy: number;
  cpy: number;
  begin: boolean;
};
export type TvmField = "n" | "i" | "pv" | "pmt" | "fv";

/** Interest per payment period from the nominal annual rate. */
export function periodRate(t: Pick<Tvm, "i" | "ppy" | "cpy">): number {
  const x = t.i / 100 / t.cpy;
  // One compounding per payment needs no power: (1.005)¹−1 in binary is 0.0049999999999999,
  // which is enough to tip a half cent the wrong way in an amortisation table.
  return t.cpy === t.ppy ? x : Math.expm1((t.cpy / t.ppy) * Math.log1p(x));
}

/** The equation's right-hand side: zero when the five values agree. */
function balance(t: Tvm): number {
  const r = periodRate(t);
  if (Math.abs(r) < 1e-15) return t.pv + t.pmt * t.n + t.fv;
  const v = (1 + r) ** -t.n;
  return t.pv + (1 + r * (t.begin ? 1 : 0)) * t.pmt * ((1 - v) / r) + t.fv * v;
}

/** Solve for one field; NaN when there's no answer (no sign change, division by zero). */
export function solveTvm(t: Tvm, field: TvmField): number {
  const r = periodRate(t);
  const k = t.begin ? 1 : 0;
  const zero = Math.abs(r) < 1e-15;
  switch (field) {
    case "fv": {
      if (zero) return -(t.pv + t.pmt * t.n);
      const g = (1 + r) ** t.n;
      return -(t.pv * g + (1 + r * k) * t.pmt * ((g - 1) / r));
    }
    case "pv": {
      if (zero) return -(t.pmt * t.n + t.fv);
      const v = (1 + r) ** -t.n;
      return -((1 + r * k) * t.pmt * ((1 - v) / r) + t.fv * v);
    }
    case "pmt": {
      if (zero) return t.n ? -(t.pv + t.fv) / t.n : NaN;
      const v = (1 + r) ** -t.n;
      const d = (1 + r * k) * (1 - v);
      return d ? (-(t.pv + t.fv * v) * r) / d : NaN;
    }
    case "n": {
      if (zero) return t.pmt ? -(t.pv + t.fv) / t.pmt : NaN;
      const a = ((1 + r * k) * t.pmt) / r;
      const q = (a - t.fv) / (t.pv + a);
      return q > 0 ? Math.log(q) / Math.log(1 + r) : NaN;
    }
    case "i":
      return solveRate(t);
  }
}

/** I(%) has no closed form: bracket a sign change, then bisect. */
function solveRate(t: Tvm): number {
  const f = (i: number) => balance({ ...t, i });
  // No interest at all (−1000 now, 1000 later): exactly 0, which bisection only gets near (−1.3E−13).
  if (Math.abs(f(0)) <= 1e-12 * (Math.abs(t.pv) + Math.abs(t.pmt * t.n) + Math.abs(t.fv))) return 0;
  const grid = [-99, -50, -20, -5, -1, 1e-9, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
  for (let g = 0; g + 1 < grid.length; g++) {
    let lo = grid[g]!;
    let hi = grid[g + 1]!;
    let flo = f(lo);
    const fhi = f(hi);
    if (!Number.isFinite(flo) || !Number.isFinite(fhi) || Math.sign(flo) === Math.sign(fhi)) continue;
    for (let it = 0; it < 200; it++) {
      const mid = (lo + hi) / 2;
      const fm = f(mid);
      if (Math.sign(fm) === Math.sign(flo)) {
        lo = mid;
        flo = fm;
      } else hi = mid;
      if (hi - lo < 1e-13 * Math.max(1, Math.abs(mid))) break;
    }
    return (lo + hi) / 2;
  }
  return NaN;
}

/**
 * x rounded to `places` decimals, halves away from zero, as the handheld
 * rounds: it works in decimal (14 significant digits), so 1234.565 is
 * 1234.57 though in binary it's 1234.56499…. Rounding is done on the 14
 * significant digits the handheld would hold.
 */
export function roundDecimal(x: number, places: number): number {
  if (!Number.isFinite(x) || x === 0) return x;
  const [m, e] = Math.abs(x).toExponential(13).split("e") as [string, string];
  const sign = x < 0 ? -1 : 1;
  const digits = m.replace(".", "");
  // Digits before the decimal point, plus the decimals kept.
  const keep = Number(e) + 1 + places;
  if (keep >= digits.length) return sign * Number(`${m}e${e}`);
  if (keep < 0) return 0;
  const kept = (keep ? Number(digits.slice(0, keep)) : 0) + (digits[keep]! >= "5" ? 1 : 0);
  return sign * Number(`${kept}e${-places}`);
}

/** One line of an amortisation table: the payment number, its interest and principal, and the balance after it. */
export type AmortRow = { n: number; interest: number; principal: number; balance: number };

/**
 * The amortisation schedule behind amortTbl, bal, ΣInt and ΣPrn, payments
 * at the end of each period. The payment and the opening balance are
 * rounded to `places` decimals, and each period's interest is worked out on
 * the balance before it and rounded the same way; the rest of the payment
 * goes to principal. So the schedule is what's actually paid, cent by cent,
 * and the last balance is off by the payment's rounding (−0.01 on a
 * 12-month loan). Row 0 is the loan itself.
 */
export function amortize(t: Tvm, payments: number, places: number): AmortRow[] {
  const r = periodRate(t);
  const pmt = roundDecimal(t.pmt, places);
  let balance = roundDecimal(t.pv, places);
  const rows: AmortRow[] = [{ n: 0, interest: 0, principal: 0, balance }];
  for (let n = 1; n <= payments; n++) {
    // Interest owed is −r·balance (cash out on a loan); held to 12 decimals, then rounded.
    const interest = roundDecimal(roundDecimal(-r * balance, 12), places);
    const principal = roundDecimal(pmt - interest, places);
    balance = roundDecimal(balance + principal, places);
    rows.push({ n, interest, principal, balance });
  }
  return rows;
}

/** The effective annual rate (%) of a nominal rate compounded `cpy` times a year. */
export function effectiveRate(nominal: number, cpy: number): number {
  return 100 * Math.expm1(cpy * Math.log1p(nominal / 100 / cpy));
}

/** The nominal rate (%), compounded `cpy` times a year, with the given effective annual rate. */
export function nominalRate(effective: number, cpy: number): number {
  return 100 * cpy * Math.expm1(Math.log1p(effective / 100) / cpy);
}
