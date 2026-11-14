// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 VCE Hub. Part of the /cas calculator: https://github.com/vcehub/cas
/**
 * Expression AST and a parser for the calculator's linear syntax, the text form a
 * person types on the entry line ("solve(x^2=2,x)", "2x+1|x=3").
 *
 * Everything else meets here: translate.ts turns an AST into a Giac command,
 * format.ts parses Giac's answer back into an AST and rewrites it into the
 * calculator's form, and tree.ts lays an AST out in 2D for display.
 *
 * Precedence follows the handheld: → and := lowest, then "|", or/xor, and,
 * not, relations, + −, × ÷ (implicit multiplication included), negation,
 * ^ (right-associative, so −2^2 = −4 and 2^3^2 = 512), postfix operators,
 * function application.
 */

import { COMMAND_NAMES } from "../catalog/commands";
import { BUILTINS } from "./builtins";

export type Ast =
  /**
   * A number as written. A decimal in an answer is written to the Display
   * Digits setting; `full` keeps the digits it was worked out to when that
   * rounding loses some, for ans to carry on with.
   */
  | { k: "num"; v: string; full?: string }
  | { k: "sym"; name: string }
  | { k: "str"; v: string }
  | { k: "call"; f: string; args: Ast[] }
  | { k: "bin"; op: BinOp; a: Ast; b: Ast; implicit?: boolean }
  | { k: "neg"; a: Ast }
  | { k: "not"; a: Ast }
  | { k: "post"; op: string; a: Ast }
  | { k: "list"; items: Ast[] }
  | { k: "mat"; rows: Ast[][] }
  | { k: "define"; lhs: Ast; rhs: Ast };

export type BinOp =
  | "+"
  | "-"
  | "*"
  | "/"
  | "^"
  | "="
  | "≠"
  | "<"
  | ">"
  | "≤"
  | "≥"
  | "and"
  | "or"
  | "xor"
  | "|"
  | "→"
  | ":="
  /** Several commands on one line, run in turn: 1→a:2→b:a+b. */
  | ":"
  /** Polar form, r∠θ. */
  | "∠";

export class ParseError extends Error {}

// ---------------------------------------------------------------- tokens

type Tok =
  | { t: "num"; v: string }
  | { t: "id"; v: string; space: boolean }
  | { t: "str"; v: string }
  | { t: "op"; v: string; space: boolean }
  | { t: "end" };

/** Characters that are one-character names on their own. */
// ? stands for each element in countIf and sumIf criteria (?<5, 2<?<8).
const SYMBOL_CHARS = new Set(["π", "ℯ", "∞", "𝑖", "θ", "?"]);
/** Prefix operators that take a parenthesised argument: √(x), ∫(…), Σ(…). */
const PREFIX_FUNCS = new Set(["√", "∫", "Σ", "Π", "∂"]);
const POSTFIX = new Set(["!", "%", "°", "'", "ᵀ", "⁻¹", "²", "³"]);
const WORD_OPS = new Set(["and", "or", "xor", "not"]);
/** Commands written without parentheses: "DelVar a,b", "Define f(x)=…". */
export const COMMAND_WORDS = new Set([
  "Define",
  "DelVar",
  "CopyVar",
  "ClearAZ",
  "SortA",
  "SortD",
  "Fill",
  "RandSeed",
  "OneVar",
  "TwoVar",
  "LinRegMx",
  "LinRegBx",
  "QuadReg",
  "ExpReg",
  "PowerReg",
  "LnReg",
  "zInterval_1Prop",
  "zInterval",
  "zTest",
  "Disp",
]);

/** Function names that contain ▶ (exp▶list is a function, x▶Decimal is not). */
const INVERTIBLE = new Set(["sin", "cos", "tan", "csc", "sec", "cot", "sinh", "cosh", "tanh", "csch", "sech", "coth"]);
const ARROW_NAMES = new Set(["list▶mat", "mat▶list", "exp▶list", "freqTable▶list", "P▶Rx", "P▶Ry", "R▶Pr", "R▶Pθ"]);

/**
 * Names aren't case-sensitive, as on the handheld: SOLVE( and Solve( are
 * solve(, and A is the variable a. A command keeps its own spelling (nSolve,
 * OneVar); every other name is lowercased.
 */
const COMMANDS = new Map<string, string>();
for (const n of [
  "ans",
  ...BUILTINS,
  ...COMMAND_WORDS,
  ...WORD_OPS,
  ...INVERTIBLE,
  ...ARROW_NAMES,
  ...COMMAND_NAMES.map((name) => name.replace(/^▶/, "").replace(/\($/, "")),
  // The handheld's, but not in the catalog yet.
  ...(
    "newList seqGen deltaList ifFn isVoid delVoid getVarInfo getLockInfo getKey warnCodes Lock Unlock Func EndFunc Prgm " +
    "EndPrgm Local Return If Then Else ElseIf EndIf For EndFor While EndWhile Loop EndLoop Exit Stop Goto Lbl Send"
  ).split(" "),
])
  if (!COMMANDS.has(n.toLowerCase())) COMMANDS.set(n.toLowerCase(), n);
const canonicalName = (v: string) => COMMANDS.get(v.toLowerCase()) ?? v.toLowerCase();
/** One of the handheld's own commands or functions, not a user's name. */
export const isCommand = (name: string) => COMMANDS.get(name.toLowerCase()) === name;

const isDigit = (c: string) => c >= "0" && c <= "9";
const isIdStart = (c: string) =>
  /\p{L}/u.test(c) && !SYMBOL_CHARS.has(c) && !PREFIX_FUNCS.has(c) && c !== "ᵀ" && c !== "ᴇ";
const isIdPart = (c: string) => isIdStart(c) || isDigit(c) || c === "_";

/**
 * The member of a variable group, after the dot in stat.x̄ or aa.b: the
 * handheld's statistics results are named with accents (x̄, p̂), subscripts
 * (Q₁X) and Greek capitals (Σx), so those are part of the name there.
 * U+F003 is TI's own x̄.
 */
const isMemberStart = (c: string) => /\p{L}/u.test(c) || c === "";
const isMemberPart = (c: string) => isMemberStart(c) || isDigit(c) || c === "_" || /\p{M}/u.test(c) || (c >= "₀" && c <= "ₜ");
/** Results whose name ends in a square (stat.r², stat.Σx²): there the ² is part of the name, not a power. */
const SQUARED_MEMBERS = new Set(["r", "adjr", "Σx", "Σy", "χ"]);
/**
 * Group and member names fold A–Z to lower case, as every name does on the
 * handheld (stat.RegEqn is stat.regeqn), but nothing else: stat.Σx (a sum)
 * and stat.σx (a standard deviation) are different results. ȳ typed as y and
 * a combining bar is the one character.
 */
const foldMember = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase()).replace(//g, "x̄").normalize("NFC");

/** `asTyped` leaves names' case alone: Giac's answers (Gamma) aren't a person's typing. */
export function tokenize(src: string, asTyped = false): Tok[] {
  const out: Tok[] = [];
  const chars = Array.from(src);
  let i = 0;
  let space = false;
  const peek = (n = 0) => chars[i + n] ?? "";
  const take = () => chars[i++] ?? "";
  while (i < chars.length) {
    const c = peek();
    if (c === " " || c === "\t" || c === "\n") {
      space = true;
      i++;
      continue;
    }
    // Numbers: 12, 1.5, .5, 1.2E-6 (E or the small-cap ᴇ the handheld uses).
    if (isDigit(c) || (c === "." && isDigit(peek(1)))) {
      let v = "";
      while (isDigit(peek()) || peek() === ".") v += take();
      if ((peek() === "E" || peek() === "ᴇ") && (isDigit(peek(1)) || ((peek(1) === "-" || peek(1) === "−") && isDigit(peek(2))))) {
        i++;
        v += "E";
        if (peek() === "-" || peek() === "−") {
          v += "-";
          i++;
        }
        while (isDigit(peek())) v += take();
      }
      out.push({ t: "num", v });
      space = false;
      continue;
    }
    if (c === '"') {
      let v = "";
      i++;
      while (i < chars.length && peek() !== '"') v += take();
      i++;
      out.push({ t: "str", v });
      space = false;
      continue;
    }
    if (isIdStart(c)) {
      let v = "";
      while (i < chars.length && isIdPart(peek())) v += take();
      // list▶mat, P▶Rx …: names with the arrow inside, not a conversion.
      while (peek() === "▶" || peek() === "►") {
        let rest = "";
        let j = i + 1;
        while (j < chars.length && isIdPart(chars[j] ?? "")) rest += chars[j++];
        if (!ARROW_NAMES.has(`${v}▶${rest}`)) break;
        v = `${v}▶${rest}`;
        i = j;
      }
      // sin⁻¹, cosh⁻¹ …: the inverse is part of the name, not a power.
      if (INVERTIBLE.has(v) && peek() === "⁻" && peek(1) === "¹") {
        v += "⁻¹";
        i += 2;
      }
      // stat.x̄, aa.b: a member of a variable group is one name.
      if (!asTyped && peek() === "." && isMemberStart(peek(1))) {
        i++;
        let m = "";
        while (i < chars.length && isMemberPart(peek())) m += take();
        if (peek() === "²" && SQUARED_MEMBERS.has(foldMember(m))) m += take();
        out.push({ t: "id", v: `${foldMember(v)}.${foldMember(m)}`, space });
        space = false;
        continue;
      }
      if (!asTyped) v = canonicalName(v);
      if (WORD_OPS.has(v)) out.push({ t: "op", v, space });
      else out.push({ t: "id", v, space });
      space = false;
      continue;
    }
    // ΣInt and ΣPrn (amortisation) are names, not Σ of int(…).
    if (c === "Σ" && /^(int|prn)$/i.test(chars.slice(i + 1, i + 4).join("")) && !isIdPart(peek(4))) {
      out.push({ t: "id", v: /^int$/i.test(chars.slice(i + 1, i + 4).join("")) ? "ΣInt" : "ΣPrn", space });
      i += 4;
      space = false;
      continue;
    }
    if (SYMBOL_CHARS.has(c)) {
      out.push({ t: "id", v: c === "𝑖" ? "i" : c, space });
      i++;
      space = false;
      continue;
    }
    // ▶Decimal, ▶Polar …: one postfix token. ► is the same arrow drawn wider.
    if (c === "▶" || c === "►") {
      let v = "▶";
      i++;
      while (i < chars.length && isIdPart(peek())) v += take();
      // ▶approxFraction() is written with empty brackets.
      if (peek() === "(" && peek(1) === ")") i += 2;
      out.push({ t: "op", v, space });
      space = false;
      continue;
    }
    const two = c + peek(1);
    const TWO: Record<string, string> = { ":=": ":=", "<=": "≤", ">=": "≥", "/=": "≠", "->": "→", "⁻¹": "⁻¹" };
    const twoOp = TWO[two];
    if (twoOp) {
      out.push({ t: "op", v: twoOp, space });
      i += 2;
      space = false;
      continue;
    }
    const ONE: Record<string, string> = { "−": "-", "·": "*", "×": "*", "÷": "/", "–": "-" };
    out.push({ t: "op", v: ONE[c] ?? c, space });
    i++;
    space = false;
  }
  out.push({ t: "end" });
  return out;
}

// ---------------------------------------------------------------- parser

const BIN_PREC: Record<string, number> = {
  ":": 0.5,
  "→": 1.5,
  ":=": 1.5,
  "|": 2,
  or: 3,
  xor: 3,
  and: 4,
  "=": 6,
  "≠": 6,
  "<": 6,
  ">": 6,
  "≤": 6,
  "≥": 6,
  // (4∠π/3): the angle takes the whole product or quotient after it.
  "∠": 6.5,
  "+": 7,
  "-": 7,
  "*": 8,
  "/": 8,
  "^": 10,
};
/** Everything binds tighter than the ":" between commands. */
const STATEMENT_PREC = 1;
const PREC_NOT = 5;
const PREC_NEG = 9;
const PREC_MUL = 8;

export function parse(src: string, { giac = false }: { giac?: boolean } = {}): Ast {
  const p = new Parser(tokenize(src, giac));
  const ast = p.statement();
  p.expectEnd();
  return ast;
}

const END: Tok = { t: "end" };
const spaced = (tok: Tok) => "space" in tok && tok.space;

class Parser {
  private i = 0;
  constructor(private toks: Tok[]) {}

  private get tok(): Tok {
    return this.toks[this.i] ?? END;
  }
  private next(): Tok {
    return this.toks[this.i++] ?? END;
  }
  private isOp(v: string, tok: Tok = this.tok): boolean {
    return tok.t === "op" && tok.v === v;
  }
  private eat(v: string): void {
    if (!this.isOp(v)) throw new ParseError(`expected ${v}`);
    this.i++;
  }
  expectEnd(): void {
    if (this.tok.t !== "end") throw new ParseError("unexpected input");
  }

  /**
   * One or more commands joined by ":" (OneVar ages,1: stat.results). A
   * command's arguments and a Define's body end at the ":", so a command can
   * be followed by another, as the handheld's wizards write them.
   */
  statement(): Ast {
    let a = this.command();
    while (this.isOp(":")) {
      this.next();
      a = { k: "bin", op: ":", a, b: this.command() };
    }
    return a;
  }

  private command(): Ast {
    const t = this.tok;
    if (t.t === "id" && t.v === "Define") {
      this.next();
      const body = this.expr(STATEMENT_PREC);
      if (body.k === "bin" && body.op === "=") return { k: "define", lhs: body.a, rhs: body.b };
      // Define f(x)=x²|x≥0: the condition belongs to the body.
      if (body.k === "bin" && body.op === "|" && body.a.k === "bin" && body.a.op === "=")
        return { k: "define", lhs: body.a.a, rhs: { ...body, a: body.a.b } };
      throw new ParseError("Define needs name=expression");
    }
    if (t.t === "id" && COMMAND_WORDS.has(t.v) && !this.isOp("(", this.toks[this.i + 1])) {
      this.next();
      const args: Ast[] = [];
      if (this.tok.t !== "end" && !this.isOp(":")) {
        args.push(this.expr(STATEMENT_PREC));
        while (this.isOp(",")) {
          this.next();
          args.push(this.expr(STATEMENT_PREC));
        }
      }
      return { k: "call", f: t.v, args };
    }
    return this.expr(STATEMENT_PREC);
  }

  expr(minPrec: number): Ast {
    let left = this.prefix();
    for (;;) {
      const t = this.tok;
      // ▶Decimal, ▶cos …: applies to everything before it, like →.
      if (t.t === "op" && t.v.startsWith("▶") && minPrec <= 2) {
        this.next();
        left = { k: "post", op: t.v, a: left };
        continue;
      }
      const prec = t.t === "op" ? BIN_PREC[t.v] : undefined;
      if (t.t === "op" && prec !== undefined) {
        if (prec < minPrec) break;
        this.next();
        // ^ is right-associative; its exponent may carry a sign (2^-3). So is :=,
        // whose right side takes a "|": f(t):=ℯ^(−kt)|k=ln(3).
        const right = t.v === "^" || t.v === ":=" ? this.expr(prec) : this.expr(prec + 1);
        left = { k: "bin", op: t.v as BinOp, a: left, b: right };
        continue;
      }
      if (PREC_MUL >= minPrec && this.startsPrimary(t)) {
        // Implicit multiplication: 2x, 3(x+1), (x+1)(x-1), 2π.
        const right = this.expr(PREC_MUL + 1);
        left = { k: "bin", op: "*", a: left, b: right, implicit: true };
        continue;
      }
      break;
    }
    return left;
  }

  private startsPrimary(t: Tok): boolean {
    if (t.t === "num" || t.t === "id" || t.t === "str") return true;
    if (t.t === "op") return t.v === "(" || t.v === "{" || t.v === "[" || PREFIX_FUNCS.has(t.v);
    return false;
  }

  private prefix(): Ast {
    const t = this.tok;
    if (this.isOp("-")) {
      this.next();
      return { k: "neg", a: this.expr(PREC_NEG) };
    }
    if (this.isOp("+")) {
      this.next();
      return this.expr(PREC_NEG);
    }
    if (this.isOp("not")) {
      this.next();
      return { k: "not", a: this.expr(PREC_NOT) };
    }
    return this.postfix(this.primary(t));
  }

  private postfix(base: Ast): Ast {
    let a = base;
    for (;;) {
      const t = this.tok;
      if (t.t !== "op") break;
      if (POSTFIX.has(t.v)) {
        this.next();
        if (t.v === "²") a = { k: "bin", op: "^", a, b: { k: "num", v: "2" } };
        else if (t.v === "³") a = { k: "bin", op: "^", a, b: { k: "num", v: "3" } };
        else if (t.v === "⁻¹") a = { k: "bin", op: "^", a, b: { k: "neg", a: { k: "num", v: "1" } } };
        else a = { k: "post", op: t.v, a };
        // y'(0), y''(2): a derivative's value, as deSolve's conditions write it.
        const name = primed(a);
        if (name && this.isOp("(") && !spaced(this.tok)) {
          this.next();
          a = { k: "call", f: name, args: this.args(")") };
        }
        continue;
      }
      // Indexing a list or matrix: m[2], m[1,2], and a bracketed one, (am^3)[1,4]
      // (the handheld answers 5 there, so it's an index, not a product with [1,4]).
      const closed = this.i > 0 && this.isOp(")", this.toks[this.i - 1]);
      if (t.v === "[" && !t.space && (a.k === "sym" || a.k === "list" || a.k === "mat" || a.k === "call" || closed)) {
        this.next();
        const args = this.args("]");
        a = { k: "call", f: "index", args: [a, ...args] };
        continue;
      }
      break;
    }
    return a;
  }

  private args(close: string): Ast[] {
    const args: Ast[] = [];
    if (this.isOp(close)) {
      this.next();
      return args;
    }
    // An empty slot (amortTbl(12,60,10,5000,,,12,12)) is an empty name.
    const arg = () => (this.isOp(",") || this.isOp(close) ? sym("") : this.expr(0));
    args.push(arg());
    while (this.isOp(",")) {
      this.next();
      args.push(arg());
    }
    this.eat(close);
    return args;
  }

  private primary(t: Tok): Ast {
    if (t.t === "num") {
      this.next();
      return { k: "num", v: t.v };
    }
    if (t.t === "str") {
      this.next();
      return { k: "str", v: t.v };
    }
    if (t.t === "id") {
      this.next();
      if (this.isOp("(") && !spaced(this.tok)) {
        this.next();
        return { k: "call", f: t.v, args: this.args(")") };
      }
      return { k: "sym", name: t.v };
    }
    if (t.t === "op") {
      if (PREFIX_FUNCS.has(t.v)) {
        this.next();
        if (this.isOp("(")) {
          this.next();
          return { k: "call", f: t.v, args: this.args(")") };
        }
        // √x without brackets: the root of the next primary.
        return { k: "call", f: t.v, args: [this.postfix(this.primary(this.tok))] };
      }
      if (t.v === "(") {
        this.next();
        const e = this.expr(0);
        this.eat(")");
        return e;
      }
      if (t.v === "{") {
        this.next();
        return { k: "list", items: this.args("}") };
      }
      if (t.v === "[") return this.matrix();
    }
    throw new ParseError(this.tok.t === "end" ? "unexpected end" : "unexpected input");
  }

  /** [[1,2][3,4]] or [[1,2],[3,4]] (matrix), [1,2,3] (row vector). */
  private matrix(): Ast {
    this.eat("[");
    if (this.isOp("[")) {
      const rows: Ast[][] = [];
      while (this.isOp("[")) {
        this.next();
        rows.push(this.args("]"));
        if (this.isOp(",")) this.next();
      }
      this.eat("]");
      return { k: "mat", rows };
    }
    return { k: "mat", rows: [this.args("]")] };
  }
}

// ---------------------------------------------------------------- helpers

export const num = (v: string | number): Ast => ({ k: "num", v: String(v) });
export const sym = (name: string): Ast => ({ k: "sym", name });
export const call = (f: string, ...args: Ast[]): Ast => ({ k: "call", f, args });
export const bin = (op: BinOp, a: Ast, b: Ast): Ast => ({ k: "bin", op, a, b });

/** Depth-first rewrite, children first. */
export function mapAst(a: Ast, fn: (a: Ast) => Ast): Ast {
  const m = (x: Ast) => mapAst(x, fn);
  switch (a.k) {
    case "call":
      return fn({ ...a, args: a.args.map(m) });
    case "bin":
      return fn({ ...a, a: m(a.a), b: m(a.b) });
    case "neg":
    case "not":
    case "post":
      return fn({ ...a, a: m(a.a) });
    case "list":
      return fn({ ...a, items: a.items.map(m) });
    case "mat":
      return fn({ ...a, rows: a.rows.map((r) => r.map(m)) });
    case "define":
      return fn({ ...a, lhs: m(a.lhs), rhs: m(a.rhs) });
    default:
      return fn(a);
  }
}

/** y′ or y″ as a name ("y'", "y''"), or null. */
function primed(a: Ast): string | null {
  if (a.k !== "post" || a.op !== "'") return null;
  if (a.a.k === "sym") return `${a.a.name}'`;
  const inner = primed(a.a);
  return inner ? `${inner}'` : null;
}
