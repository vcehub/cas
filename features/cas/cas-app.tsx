// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 VCE Hub. Part of the /cas calculator: https://github.com/vcehub/cas
"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Copy, Download, MessageSquare, Trash2 } from "lucide-react";
import { Button } from "@/shared/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";
import { cn } from "@/shared/lib/utils";
import { historySaid, markSaid, menuSaid, pageSaid, toolSaid, wizardSaid } from "./a11y";
import { calcKey, wizardInsert } from "./calculator/calc-keys";
import { CalculatorApp } from "./calculator/calculator-app";
import { CasEngine, definedFunctions, definedNames, type EngineStatus } from "./engine/client";
import { DEFAULT_SETTINGS, evaluate, type Settings } from "./engine/evaluate";
import { unrounded } from "./engine/format";
import { analyze } from "./graphs/analyze";
import {
  graphKey,
  nextFree,
  deY,
  openDE,
  openEntry,
  openParametric,
  openRelation,
  startTool,
  type GraphEffect,
} from "./graphs/graph-keys";
import { GraphsApp } from "./graphs/graphs-app";
import { autoScale, deName, fnName, parNames, relName, zoomed, type Samples } from "./graphs/model";
import { Keypad } from "./keypad/keypad";
import { keyFromEvent, type Key } from "./keys";
import { mapAst, parse, sym, type Ast } from "./math/ast";
import { print } from "./math/print";
import { RENAME_IN, translate } from "./engine/translate";
import { DE_DEFAULTS, type RelationOp, type Slider } from "./state/document";
import { emptyEdit, selectBetween, selection, selectionText, type EditState } from "./math/editor";
import { DefinedNames } from "./math/render";
import { astToRow, chars, rowToLinear, type Row } from "./math/tree";
import { calculatorMenu } from "./menus/calculator-menu";
import { graphsMenu } from "./menus/graphs-menu";
import { MenuOverlay, menuKeyPress, openMenu, type MenuState } from "./menus/menu";
import { type Menu, type MenuAction, type MenuItem } from "./menus/types";
import {
  CatalogOverlay,
  catalogKeyPress,
  catalogSaid,
  openCatalog,
  type CatalogResult,
  type CatalogState,
} from "./catalog/catalog";
import { PALETTE, paletteKeyPress, TemplatePalette } from "./menus/palette";
import { FinanceSolver, financeKeyPress, newFinance, type FinanceState } from "./finance/finance-solver";
import { CheckBox, openWizard, WizardDialog, wizardKeyPress, type WizardState } from "./menus/wizard";
import { download, screenPng } from "./screen/capture";
import { FeedbackDialog, KINDS, type FeedbackKind, type ReportSource } from "./report";
import { ADD_PAGE, DOC_MENU } from "./menus/doc-menus";
import { HowToBar, SyntaxHint } from "./howto/howto";
import { landedSyntax, resolve } from "./howto/paths";
import type { HowTo } from "./howto/types";
import { freeVariables, SLIDER_DIGITS, sliderStep, snap } from "./graphs/sliders";
import { Screen } from "./screen/screen";
import { load, save } from "./state/persist";
import {
  insertProblem,
  newDocument,
  newId,
  newPage,
  pageLabel,
  problemOf,
  type CalculatorPage,
  type CasDocument,
  type GraphsPage,
  type HistoryEntry,
  type Page,
} from "./state/document";

/**
 * The engine definitions that give one Graphs page its own copies of its
 * curves (see fnName in graphs/model.ts). Used when a curve is entered and
 * when a saved document is opened.
 */
function pageDefinitions(page: GraphsPage, settings: Settings): string[] {
  const t = (text: string) => translate(parse(text), settings).giac;
  const out: string[] = [];
  for (const f of page.functions) {
    try {
      out.push(`${fnName(page.id, f.n)}(x):=${t(f.text)}`);
    } catch {
      // A function that no longer parses just isn't drawn.
    }
  }
  for (const r of page.relations ?? []) {
    try {
      const ast = parse(r.text);
      if (ast.k === "bin")
        out.push(
          `${relName(page.id, r.n)}(x,y):=(${translate(ast.a, settings).giac})-(${translate(ast.b, settings).giac})`,
        );
    } catch {
      // As above.
    }
  }
  for (const c of page.parametrics ?? []) {
    try {
      const [xn, yn] = parNames(page.id, c.n);
      out.push(`${xn}(t):=${t(c.x)}`, `${yn}(t):=${t(c.y)}`);
    } catch {
      // As above.
    }
  }
  for (const d of page.des ?? []) {
    try {
      out.push(deDefinition(page.id, d.n, d.y, d.rhs, settings));
    } catch {
      // As above.
    }
  }
  return out;
}

/** d1: y1′ = x·y1 becomes the slope function g…d1_(x,y) = x·y. */
function deDefinition(page: number, n: number, y: number, rhs: string, settings: Settings): string {
  const body = mapAst(parse(rhs), (a) => (a.k === "sym" && a.name === `y${y}` ? sym("y") : a));
  return `${deName(page, n)}(x,y):=${translate(body, settings).giac}`;
}

/**
 * The calculator's width: the page's own column on phones; on wide screens
 * the keypad, the gap and the screen at their largest (sizes from the row in
 * CasApp), so the heading, the bar and the notes line up with its edges.
 */
const DEVICE_WIDTH = "mx-auto max-w-[34rem] lg:max-w-[calc(min(21rem,(100vh-11rem)/2)+1.5rem+(100vh-11rem)*4/3)]";

/** This calculator's source, published under the GPL (scripts/publish-cas-source.mjs). */
const CAS_SOURCE = "https://github.com/vcehub/cas";
/** Giac's source for the build in public/cas/giac, mirrored as a release there (see its SOURCE.md). */
const GIAC_SOURCE = "https://github.com/vcehub/cas/releases/tag/giac-1.9.0";

/** Feedback beside "How do I…", opening a short menu of the three kinds. */
function FeedbackMenu({ onPick }: { onPick: (kind: FeedbackKind) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" className="ml-auto max-lg:hidden">
          <MessageSquare aria-hidden="true" className="size-[16px]" />
          Feedback
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[320px] p-[6px]">
        {KINDS.map((k) => (
          <button
            key={k.id}
            type="button"
            onClick={() => {
              setOpen(false);
              onPick(k.id);
            }}
            className="block w-full rounded-[6px] px-[12px] py-[10px] text-left hover:bg-surfaceHover focus-visible:bg-surfaceHover"
          >
            <span className="block text-ui font-semibold text-ink">{k.label}</span>
            <span className="block text-uiSm text-inkBody">{k.says}</span>
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

/**
 * The fine print: free, not for SACs or exams, unaffiliated, and the GPL's notices (the
 * licence, no warranty, where the source is), for this calculator and for Giac.
 */
function Legal({ className }: { className?: string }) {
  return (
    <>
      <p className={cn("m-0 text-sm text-inkMuted", className)}>
        Free for educational use. Not allowed in SACs or VCAA exams. Not affiliated with or endorsed by Texas Instruments.
      </p>
      <p className="m-0 text-sm text-inkMuted">
        This calculator is free software under the GNU GPL v3 or later, with no warranty (
        <a href="/cas/giac/COPYING" className="underline underline-offset-2 hover:text-ink">
          licence
        </a>
        ,{" "}
        <a href={CAS_SOURCE} className="underline underline-offset-2 hover:text-ink">
          source
        </a>
        ). The maths runs on Giac, by Bernard Parisse and Renée De Graeve (
        <a href={GIAC_SOURCE} className="underline underline-offset-2 hover:text-ink">
          source
        </a>
        ).
      </p>
    </>
  );
}

/**
 * The last answer on the page, for ans when this visit has none yet (after a
 * reload, or on coming back to a problem). The handheld keeps ans with the
 * document, as it does its other system variables.
 */
function shownAnswer(page: CalculatorPage): Ast | undefined {
  const last = page.history.at(-1);
  // At full precision, as the handheld keeps it, when the shown answer is rounded.
  const text = last?.ansText ?? last?.outputText;
  if (!text) return undefined;
  try {
    return parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Slider Settings; Insert Slider
 * opens it for a new slider (v1, v2 …). OK builds "slider:<old name>:<fields>",
 * handled in wizardDone.
 */
function sliderSettings(sl: Slider | null, newName = "v1") {
  const s: Slider = sl ?? { name: newName, value: 1, min: -5, max: 5, step: "auto" };
  const yes = (on: boolean) => (on ? "Yes" : "No");
  return openWizard({
    kind: "wizard",
    title: "Slider Settings",
    arrows: false,
    fields: [
      { label: "Variable:", value: s.name },
      { label: "Value:", value: String(s.value) },
      { label: "Minimum:", value: String(s.min) },
      { label: "Maximum:", value: String(s.max) },
      { label: "Step Size:", value: s.step === "auto" ? "Automatic" : String(s.step), options: ["Automatic"], free: true },
      { label: "Style:", value: s.vertical ? "Vertical" : "Horizontal", options: ["Horizontal", "Vertical"] },
      { label: "Display Digits:", value: s.digits ?? "Float 3", options: SLIDER_DIGITS },
      { label: "Minimized", value: yes(Boolean(s.minimized)), check: true },
      { label: "Show Variable", value: yes(!s.hideName), check: true },
      { label: "Show Scale", value: yes(!s.hideScale), check: true },
    ],
    build: `slider:${sl?.name ?? ""}:{0}:{1}:{2}:{3}:{4}:{5}:{6}:{7}:{8}:{9}`,
  });
}

/** Where Insert Slider puts a new slider, as fractions of the graph, as the handheld does. */
const INSERTED_AT = { x: 0.69, y: 0.26 };

const FINANCE_NAMES = ["N", "I(%)", "PV", "Pmt", "FV", "PpY", "CpY", "PmtAt"];

const DIGIT_OPTIONS = ["Float", ...Array.from({ length: 12 }, (_, i) => `Float${i + 1}`)];

/** What undo puts back on a page: its entry line, and on a Calculator page its history. */
type UndoSnap = { edit: EditState; history?: HistoryEntry[] };
type UndoStacks = { past: UndoSnap[]; future: UndoSnap[]; typing: boolean };
const UNDO_LIMIT = 200;

/** One step of undo (back) or redo on the active page, moving the snapshot between the stacks. */
function undoStep(d: CasDocument, back: boolean, all: Map<number, UndoStacks>): CasDocument {
  const p = d.pages[d.active];
  if (!p || (p.kind !== "calculator" && p.kind !== "graphs")) return d;
  const stacks = all.get(p.id);
  const from = back ? stacks?.past : stacks?.future;
  const snap = from?.pop();
  if (!stacks || !snap) return d;
  (back ? stacks.future : stacks.past).push({ edit: p.edit, ...(p.kind === "calculator" ? { history: p.history } : {}) });
  stacks.typing = false;
  const pages = d.pages.slice();
  pages[d.active] =
    p.kind === "calculator"
      ? { ...p, edit: snap.edit, history: snap.history ?? p.history, sel: null }
      : { ...p, edit: snap.edit };
  return { ...d, pages };
}

/**
 * The whole calculator: one document, its pages, the engine, and the key
 * routing that sends every key press (keyboard or keypad) to the active
 * page, or to whichever menu or dialog is open over it.
 */
export function CasApp() {
  const [doc, setDoc] = useState<CasDocument>(newDocument);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  // "Report a wrong answer": the page as it was when the form opened.
  const [report, setReport] = useState<{ source: ReportSource; kind: FeedbackKind | null } | null>(null);
  // "How do I…": the command's syntax, under the screen until the next Enter.
  const [hint, setHint] = useState<string | null>(null);
  const [status, setStatus] = useState<EngineStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  /** The message of the ⚠ last clicked, while its dialog is open. */
  const [warning, setWarning] = useState<string[] | null>(null);
  const [menu, setMenu] = useState<{ items: Menu; state: MenuState } | null>(null);
  const [wizard, setWizard] = useState<WizardState | null>(null);
  /** The templates palette's selected cell, or null when it's closed. */
  const [palette, setPalette] = useState<number | null>(null);
  /** Names with a definition, shown in bold wherever they appear. */
  const [defined, setDefined] = useState<ReadonlySet<string>>(new Set());
  const [catalog, setCatalog] = useState<CatalogState | null>(null);
  /** Variables in a new graph with no value yet: Create Sliders, a box ticked for each. */
  const [sliderPrompt, setSliderPrompt] = useState<SliderAsk | null>(null);
  /** Finance Solver while it's open; its values stay for the next opening. */
  const [finance, setFinance] = useState<FinanceState | null>(null);
  const lastFinance = useRef<FinanceState>(newFinance());
  const engine = useRef<CasEngine | null>(null);
  const lastAns = useRef<Ast | undefined>(undefined);
  const samples = useRef<Samples[]>([]);
  const busy = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  const screenBox = useRef<HTMLDivElement>(null);
  // Read out through the live region; n changes so a repeat is read again.
  const [said, setSaid] = useState({ text: "", n: 0 });
  const say = useCallback((text: string) => setSaid((s) => ({ text, n: s.n + 1 })), []);
  // A focus ring for keyboard focus only: clicking a key also focuses the calculator.
  const pointerFocus = useRef(false);
  const [keyboardFocus, setKeyboardFocus] = useState(false);

  const restored = useRef(false);
  /** The problem whose definitions the engine holds now. */
  const shownProblem = useRef(1);
  /** The saved document's problem until that document is on screen (the first render still shows the default one). */
  const opening = useRef<number | null>(null);
  useEffect(() => {
    // Pick up the document from this browser's last visit, if there is one.
    const saved = load();
    const e = new CasEngine(saved?.settings ?? DEFAULT_SETTINGS);
    engine.current = e;
    if (saved) {
      // The engine is given the active problem's definitions below: no swap on opening.
      shownProblem.current = problemOf(saved.doc.pages[saved.doc.active]);
      opening.current = shownProblem.current;
      setDoc(saved.doc);
      setSettings(saved.settings);
      void e.restore(saved.definitions).then(async () => {
        // Each Graphs page's own names, for documents saved before pages had them.
        for (const pg of saved.doc.pages)
          if (pg.kind === "graphs")
            for (const d of pageDefinitions(pg, saved.settings)) {
              await e.giac(d);
              e.remember(d);
            }
      });
      setDefined(definedNames(saved.definitions));
    }
    restored.current = true;
    const unsubscribe = e.onStatus(setStatus);
    return () => {
      unsubscribe();
      e.dispose();
    };
  }, []);

  useEffect(() => {
    if (!restored.current) return;
    const t = setTimeout(() => save({ doc, settings, definitions: engine.current?.saved ?? [] }), 400);
    return () => clearTimeout(t);
  }, [doc, settings]);

  const page = doc.pages[doc.active];
  // Function numbers in use across the problem: every Graphs page's, and
  // f1, f2 … defined anywhere (the Calculator, a regression). The next graph
  // takes the lowest free one.
  const takenFns = useMemo(() => {
    const out = new Set<number>();
    for (const name of defined) {
      const m = /^f(\d+)$/.exec(name);
      if (m) out.add(Number(m[1]));
    }
    const here = problemOf(doc.pages[doc.active]);
    for (const pg of doc.pages) if (pg.kind === "graphs" && problemOf(pg) === here) for (const f of pg.functions) out.add(f.n);
    return out;
  }, [defined, doc.pages, doc.active]);

  // Each problem has its own variables: moving to a page of another problem
  // puts the current problem's definitions in the document, restarts the
  // engine and replays the other problem's.
  const activeProblem = problemOf(doc.pages[doc.active]);
  const latestDoc = useRef(doc);
  latestDoc.current = doc;
  useEffect(() => {
    const e = engine.current;
    if (opening.current !== null) {
      if (opening.current === activeProblem) opening.current = null;
      return;
    }
    const from = shownProblem.current;
    if (!e || from === activeProblem) return;
    shownProblem.current = activeProblem;
    const leaving = e.saved;
    const arriving: string[] = latestDoc.current.problems?.[String(activeProblem)] ?? [];
    setDoc((d) => {
      const problems: Record<string, string[]> = { ...(d.problems ?? {}), [String(from)]: leaving };
      delete problems[String(activeProblem)];
      return { ...d, problems };
    });
    lastAns.current = undefined;
    void (async () => {
      await e.clearAll();
      await e.restore(arriving);
      setDefined(definedNames(arriving));
    })();
  }, [activeProblem]);

  /**
   * Undo and redo, per page: the entry line, and history lines removed with
   * del. An evaluated line (or a function entered on a Graphs page) is a
   * wall: what it defined is already in the engine, so undo stops there.
   */
  const undo = useRef(new Map<number, UndoStacks>());
  /** The change being made comes from typing a character: a run of them undoes as one step. */
  const typing = useRef(false);
  const recordUndo = useCallback((p: Page, n: Page) => {
    if (p.kind !== n.kind) return;
    const stacks = undo.current.get(p.id) ?? { past: [], future: [], typing: false };
    undo.current.set(p.id, stacks);
    const wall =
      p.kind === "calculator" && n.kind === "calculator"
        ? n.history.length > p.history.length
        : p.kind === "graphs" &&
          n.kind === "graphs" &&
          (n.editing !== p.editing ||
            n.functions !== p.functions ||
            n.relations !== p.relations ||
            n.parametrics !== p.parametrics ||
            n.des !== p.des);
    if (wall) {
      stacks.past = [];
      stacks.future = [];
      stacks.typing = false;
      return;
    }
    const removed = p.kind === "calculator" && n.kind === "calculator" && n.history.length < p.history.length;
    // Moving the cursor ends a run of typing.
    if (!typing.current) stacks.typing = false;
    if (n.edit.row === p.edit.row && !removed) return;
    const top = stacks.past[stacks.past.length - 1];
    stacks.future = [];
    // The same change seen twice (React runs state updaters twice in development) is one step.
    if (top?.edit === p.edit) return;
    if (typing.current && stacks.typing && top) return;
    stacks.past.push({ edit: p.edit, ...(p.kind === "calculator" ? { history: p.history } : {}) });
    if (stacks.past.length > UNDO_LIMIT) stacks.past.shift();
    stacks.typing = typing.current;
  }, []);

  /** Update the active page if it's of the given kind. */
  const update = useCallback(
    <K extends Page["kind"]>(kind: K, fn: (p: Extract<Page, { kind: K }>) => Page) => {
      setDoc((d) => {
        const p = d.pages[d.active];
        if (!p || p.kind !== kind) return d;
        const pages = d.pages.slice();
        const next = fn(p as Extract<Page, { kind: K }>);
        recordUndo(p, next);
        pages[d.active] = next;
        return { ...d, pages };
      });
    },
    [recordUndo],
  );

  /** Ctrl+Z (back) and Ctrl+Shift+Z or Ctrl+Y (forward) on the active page. */
  const lastStep = useRef<{ from: CasDocument; to: CasDocument } | null>(null);
  const stepUndo = useCallback((back: boolean) => {
    setDoc((d) => {
      // React runs this twice in development; the second run must not take a second step.
      if (lastStep.current?.from === d) return lastStep.current.to;
      const to = undoStep(d, back, undo.current);
      lastStep.current = { from: d, to };
      return to;
    });
  }, []);
  const setCalc = useCallback((fn: (p: CalculatorPage) => CalculatorPage) => update("calculator", fn), [update]);
  const setGraphs = useCallback((fn: (p: GraphsPage) => GraphsPage) => update("graphs", fn), [update]);

  const runEvaluate = useCallback(
    async (p: CalculatorPage, approx: boolean) => {
      const e = engine.current;
      if (!e || busy.current) return;
      busy.current = true;
      const text = rowToLinear(p.edit.row);
      try {
        const res = await evaluate(text, e.giac, { settings, ans: lastAns.current ?? shownAnswer(p), approx });
        if (!res.ok) {
          setError(res.error);
          return;
        }
        // A recursive function's helper (in definitions) comes before the function itself.
        const defs = [...(res.definitions ?? []), ...(res.definition ? [res.definition] : [])];
        if (defs.length) {
          for (const d of defs) e.remember(d);
          setDefined(definedNames(e.saved));
        }
        lastAns.current = res.output;
        const full = print(unrounded(res.output));
        const entry = {
          id: newId(),
          input: astToRow(res.input),
          inputText: text,
          output: astToRow(res.output),
          outputText: res.outputText,
          ...(full !== print(res.output) ? { ansText: full } : {}),
          ...(res.warning && { warning: res.warning.text }),
        };
        setCalc((cur) => ({ ...cur, edit: emptyEdit(), history: [...cur.history, entry] }));
        say(historySaid(entry));
        if (res.regEqn) {
          // A regression copied to f1 (CopyVar stat.RegEqn,f1, which defines
          // f1) is plotted on every Graphs page, as the handheld's shared
          // functions are.
          const { n, text } = res.regEqn;
          let row: Row;
          try {
            row = astToRow(parse(text));
          } catch {
            row = chars(text);
          }
          for (const pg of doc.pages)
            if (pg.kind === "graphs") {
              const own = `${fnName(pg.id, n)}(x):=${translate(parse(text), settings).giac}`;
              await e.giac(own);
              e.remember(own);
            }
          setDoc((d) => ({
            ...d,
            pages: d.pages.map((pg) =>
              pg.kind === "graphs"
                ? {
                    ...pg,
                    functions: [...pg.functions.filter((f) => f.n !== n), { n, text, row }].sort((a, b) => a.n - b.n),
                  }
                : pg,
            ),
          }));
        }
      } finally {
        busy.current = false;
      }
    },
    [settings, setCalc, say, doc.pages],
  );

  /** The trace point or bound moved: x on a function, the position along a relation or parametric curve. */
  const onToolX = useCallback(
    (x: number) =>
      setGraphs((g) => {
        const t = g.tool;
        if (!t) return g;
        if (t.kind === "trace" && t.curve) return { ...g, tool: { ...t, curve: { ...t.curve, at: x } } };
        return { ...g, tool: { ...t, x } };
      }),
    [setGraphs],
  );

  // A graph using variables with no value (a in a·x) offers sliders for them.
  const offerSliders = useCallback((texts: string[], bound: string[], p: GraphsPage) => {
    const e = engine.current;
    if (!e) return;
    const have = new Set([...definedNames(e.saved), ...(p.sliders ?? []).map((sl) => sl.name)]);
    const names = freeVariables(texts, bound, have, definedFunctions(e.saved));
    if (names.length) setSliderPrompt({ names, on: names.map(() => true), focus: 0 });
  }, []);

  /** Give a variable its slider's value in the engine; kept (replayed after a restart) once final. */
  const assign = useCallback((name: string, value: number, final: boolean) => {
    const e = engine.current;
    if (!e) return;
    const cmd = `${RENAME_IN[name] ?? name}:=${value}`;
    void e.giac(cmd);
    if (final) {
      e.remember(cmd);
      setDefined(definedNames(e.saved));
    }
  }, []);

  const setSlider = useCallback(
    (name: string, change: (sl: Slider) => Slider | null) =>
      setGraphs((g) => ({
        ...g,
        sliders: (g.sliders ?? []).flatMap((sl) => {
          if (sl.name !== name) return [sl];
          const next = change(sl);
          return next ? [next] : [];
        }),
      })),
    [setGraphs],
  );

  const createSliders = useCallback(
    (names: string[]) => {
      const made: Slider[] = names.map((name) => ({ name, value: 1, min: -5, max: 5, step: "auto" }));
      for (const sl of made) assign(sl.name, sl.value, true);
      setGraphs((g) => ({ ...g, sliders: [...(g.sliders ?? []), ...made] }));
      say(`Sliders added for ${names.join(", ")}`);
    },
    [assign, setGraphs, say],
  );

  // Animating sliders step every 150 ms, starting over from the minimum at the end.
  const animating = page?.kind === "graphs" ? (page.sliders ?? []).filter((sl) => sl.animating) : [];
  const animKey = animating.map((sl) => sl.name).join(",");
  useEffect(() => {
    if (!animKey) return;
    const t = setInterval(() => {
      setGraphs((g) => ({
        ...g,
        sliders: (g.sliders ?? []).map((sl) => {
          if (!sl.animating) return sl;
          const next = sl.value + sliderStep(sl) > sl.max + 1e-12 ? sl.min : snap(sl, sl.value + sliderStep(sl));
          assign(sl.name, next, false);
          return { ...sl, value: next };
        }),
      }));
    }, 150);
    return () => clearInterval(t);
  }, [animKey, setGraphs, assign]);

  const runGraphEffect = useCallback(
    async (p: GraphsPage, effect: GraphEffect) => {
      const e = engine.current;
      if (!e || !effect) return;
      if ("define" in effect) {
        const { n, text } = effect.define;
        // The label shows the definition laid out afresh, as the handheld does (a*x^2 → a·x²).
        let row = p.edit.row;
        try {
          row = astToRow(parse(text));
        } catch {
          // Evaluating it reports the error.
        }
        const res = await evaluate(`Define f${n}(x)=${text}`, e.giac, { settings });
        if (!res.ok) {
          setError(res.error);
          setGraphs((g) => ({ ...g, editing: n }));
          return;
        }
        if (res.definition) {
          e.remember(res.definition);
          setDefined(definedNames(e.saved));
        }
        // This page's own copy, so other pages' f1 never changes its curve.
        const own = `${fnName(p.id, n)}(x):=${translate(parse(text), settings).giac}`;
        await e.giac(own);
        e.remember(own);
        say(`Plotted f${n}(x)=${text}`);
        offerSliders([text], ["x"], p);
        setGraphs((g) => {
          const rest = g.functions.filter((f) => f.n !== n);
          return { ...g, functions: [...rest, { n, text, row }].sort((a, b) => a.n - b.n) };
        });
      } else if ("relation" in effect) {
        // rel1: x²+y²=4 becomes rel1_(x,y) = left − right, which the graph
        // evaluates over a grid: its zero line is the curve, its sign the shading.
        const { n, text } = effect.relation;
        const row = p.edit.row;
        const reopen = () => setGraphs((g) => ({ ...g, editing: n, entryKind: "rel" }));
        let ast: Ast;
        try {
          ast = parse(text);
        } catch {
          setError("Error: Syntax");
          reopen();
          return;
        }
        const ops: RelationOp[] = ["=", "<", ">", "≤", "≥", "≠"];
        if (!(ast.k === "bin" && (ops as string[]).includes(ast.op))) {
          setError("Error: A relation needs =, <, >, ≤, ≥ or ≠");
          reopen();
          return;
        }
        const op = ast.op as RelationOp;
        let def: string;
        try {
          def = `${relName(p.id, n)}(x,y):=(${translate(ast.a, settings).giac})-(${translate(ast.b, settings).giac})`;
        } catch {
          setError("Error: Invalid relation");
          reopen();
          return;
        }
        const raw = await e.giac(def);
        if (/error/i.test(raw)) {
          setError("Error: Invalid relation");
          reopen();
          return;
        }
        e.remember(def);
        setDefined(definedNames(e.saved));
        say(`Plotted rel${n}: ${text}`);
        offerSliders([text], ["x", "y"], p);
        setGraphs((g) => {
          const rest = (g.relations ?? []).filter((r) => r.n !== n);
          return { ...g, relations: [...rest, { n, text, row, op }].sort((a, b) => a.n - b.n) };
        });
      } else if ("parametric" in effect) {
        // x1(t), y1(t) become xp1_(t), yp1_(t); the t range is worked out to numbers.
        const { n, texts } = effect.parametric;
        const rowOf = (t: string): Row => {
          try {
            return astToRow(parse(t));
          } catch {
            return chars(t);
          }
        };
        const fail = (msg: string) => {
          setError(msg);
          setGraphs((g) => ({
            ...g,
            editing: n,
            entryKind: "par",
            parDraft: { field: 0, rows: texts.map(rowOf) },
            edit: { row: rowOf(texts[0]!), cursor: { path: [], index: rowOf(texts[0]!).length } },
          }));
        };
        let defs: string[];
        let range: number[];
        try {
          defs = [
            `${parNames(p.id, n)[0]}(t):=${translate(parse(texts[0]!), settings).giac}`,
            `${parNames(p.id, n)[1]}(t):=${translate(parse(texts[1]!), settings).giac}`,
          ];
          range = [];
          for (const t of texts.slice(2))
            range.push(Number((await e.giac(`evalf(${translate(parse(t), settings).giac})`)).trim()));
        } catch {
          fail("Error: Syntax");
          return;
        }
        const [tmin, tmax, tstep] = range as [number, number, number];
        if (![tmin, tmax, tstep].every(Number.isFinite) || tmax <= tmin || tstep <= 0) {
          fail("Error: Invalid t range");
          return;
        }
        for (const d of defs) {
          if (/error/i.test(await e.giac(d))) {
            fail("Error: Invalid expression");
            return;
          }
          e.remember(d);
        }
        say(`Plotted x${n}(t)=${texts[0]}, y${n}(t)=${texts[1]}`);
        offerSliders(texts.slice(0, 2), ["t"], p);
        setGraphs((g) => {
          const rest = (g.parametrics ?? []).filter((c) => c.n !== n);
          const curve = {
            n,
            x: texts[0]!,
            y: texts[1]!,
            xRow: rowOf(texts[0]!),
            yRow: rowOf(texts[1]!),
            tmin,
            tmax,
            tstep,
          };
          return { ...g, parametrics: [...rest, curve].sort((a, b) => a.n - b.n) };
        });
      } else if ("de" in effect) {
        // d1: y1′ = f(x, y1), with (x0, y10) optional: the field always, the solution through it when given.
        const { n, texts } = effect.de;
        const y = deY(p, n);
        const rowOf = (t: string): Row => {
          try {
            return astToRow(parse(t));
          } catch {
            return chars(t);
          }
        };
        const fail = (msg: string) => {
          setError(msg);
          setGraphs((g) => ({
            ...g,
            editing: n,
            entryKind: "de",
            parDraft: { field: 0, rows: texts.map(rowOf) },
            edit: { row: rowOf(texts[0]!), cursor: { path: [], index: rowOf(texts[0]!).length } },
          }));
        };
        let def: string;
        const start: (number | undefined)[] = [];
        try {
          def = deDefinition(p.id, n, y, texts[0]!, settings);
          for (const t of texts.slice(1, 3))
            start.push(t?.trim() ? Number((await e.giac(`evalf(${translate(parse(t), settings).giac})`)).trim()) : undefined);
        } catch {
          fail("Error: Syntax");
          return;
        }
        const [x0, y0] = start;
        if ((x0 === undefined) !== (y0 === undefined) || [x0, y0].some((v) => v !== undefined && !Number.isFinite(v))) {
          fail("Error: Invalid initial condition");
          return;
        }
        if (/error/i.test(await e.giac(def))) {
          fail("Error: Invalid expression");
          return;
        }
        e.remember(def);
        say(`Plotted y${y}'=${texts[0]}`);
        offerSliders([texts[0]!], ["x", `y${y}`], p);
        setGraphs((g) => {
          const rest = (g.des ?? []).filter((d) => d.n !== n);
          const de = { n, y, rhs: texts[0]!, row: rowOf(texts[0]!), ...(x0 !== undefined ? { x0, y0 } : {}) };
          return { ...g, des: [...rest, de].sort((a, b) => a.n - b.n) };
        });
      } else {
        const { type, fn, a, b } = effect.analyze;
        const other = p.functions.find((f) => !f.hidden && f.n !== fn)?.n;
        const mark = await analyze(
          e.giac,
          type,
          fn,
          fnName(p.id, fn),
          other === undefined ? undefined : fnName(p.id, other),
          a,
          b,
        );
        if (!mark) setError("Error: Nothing found between the bounds");
        else {
          setGraphs((g) => ({ ...g, marks: [...g.marks, mark] }));
          say(markSaid(mark));
        }
      }
    },
    [settings, setGraphs, say, offerSliders],
  );

  const pageKey = useCallback(
    (key: Key) => {
      typing.current = key.k === "char";
      // A panel or the catalog opened over a dialog (∞ into Normal Cdf's
      // bound): its text goes into the focused field, not the page behind.
      if (wizard || finance) {
        if (key.k !== "text" && key.k !== "char") return;
        if (wizard) setWizard((w) => (w ? (wizardKeyPress(w, key).state ?? w) : w));
        else
          setFinance((f) => {
            const next = f ? (financeKeyPress(f, key).state ?? f) : f;
            if (next) lastFinance.current = next;
            return next;
          });
        return;
      }
      if (page?.kind === "calculator") {
        // The selected history item says how far it can scroll (history.tsx).
        const max = Number(document.querySelector("[data-cas-max-scroll]")?.getAttribute("data-cas-max-scroll") ?? 0);
        const { page: next, effect } = calcKey(page, key, max);
        setCalc(() => next);
        if (effect) void runEvaluate(next, effect.evaluate === "approx");
      } else if (page?.kind === "graphs") {
        const { page: next, effect } = graphKey(page, key, takenFns);
        setGraphs(() => next);
        if (effect) void runGraphEffect(next, effect);
      }
    },
    [wizard, finance, page, runEvaluate, runGraphEffect, setCalc, setGraphs, takenFns],
  );

  /** Clear all: one empty Calculator page and no variables. The settings stay. */
  const clearAll = useCallback(() => {
    shownProblem.current = 1;
    opening.current = null;
    setDoc(newDocument());
    setMenu(null);
    setWizard(null);
    setPalette(null);
    setCatalog(null);
    setFinance(null);
    setSliderPrompt(null);
    setError(null);
    setDefined(new Set());
    lastAns.current = undefined;
    samples.current = [];
    void engine.current?.clearAll();
    root.current?.focus();
  }, []);

  // A new page is a clean sheet: a new Graphs page has no curves on it.
  const addPage = useCallback(
    (kind: "calculator" | "graphs") => {
      setDoc((d) => {
        const pages = d.pages.slice();
        const page = newPage(kind, problemOf(d.pages[d.active]));
        // Its entry line starts on the problem's next free function number.
        if (page.kind === "graphs") page.editing = nextFree(page, takenFns);
        pages.splice(d.active + 1, 0, page);
        return { ...d, pages, active: d.active + 1 };
      });
    },
    [takenFns],
  );

  const graphAction = useCallback(
    (id: string) => {
      if (id.startsWith("zoom")) {
        setGraphs((g) => ({ ...g, window: zoomed(id, g.window, samples.current, 1.5), marks: [] }));
      } else if (id === "windowSettings" && page?.kind === "graphs") {
        const w = page.window;
        // Full precision, as the handheld shows: −6.6666666666667.
        const f = (v: number) => String(Number(v.toPrecision(14)));
        const scale = (v: number, lo: number, hi: number) => (v === autoScale(lo, hi) ? "Auto" : f(v));
        const scaleField = (label: string, value: string) => ({ label, value, options: ["Auto"], free: true });
        setWizard(
          openWizard({
            kind: "wizard",
            title: "Window Settings",
            arrows: false,
            fields: [
              { label: "XMin:", value: f(w.xmin) },
              { label: "XMax:", value: f(w.xmax) },
              scaleField("XScale:", scale(w.xscl, w.xmin, w.xmax)),
              { label: "YMin:", value: f(w.ymin) },
              { label: "YMax:", value: f(w.ymax) },
              scaleField("YScale:", scale(w.yscl, w.ymin, w.ymax)),
            ],
            build: "window:{0}:{1}:{2}:{3}:{4}:{5}",
          }),
        );
      } else if (id === "graphTrace" || id.startsWith("analyze")) setGraphs((g) => startTool(g, id));
      else if (id === "tableSplit") setGraphs((g) => ({ ...g, table: !g.table }));
      else if (id === "deleteAll") setGraphs((g) => ({ ...g, functions: [], marks: [], tool: null }));
      else if (id === "viewDotGrid") setGraphs((g) => ({ ...g, grid: "dot" }));
      else if (id === "viewLinedGrid") setGraphs((g) => ({ ...g, grid: "line" }));
      else if (id === "viewNoGrid") setGraphs((g) => ({ ...g, grid: "none" }));
      else if (id === "viewHideAxes") setGraphs((g) => ({ ...g, axes: !g.axes }));
      else if (id === "viewEntryLine")
        setGraphs((g) => (g.editing === null ? openEntry(g, nextFree(g, takenFns)) : { ...g, editing: null }));
      else if (id === "entryFunction") setGraphs((g) => openEntry(g, nextFree(g, takenFns)));
      else if (id === "entryRelation") setGraphs((g) => openRelation(g));
      else if (id === "insertSlider") {
        const taken = new Set([...defined, ...(page?.kind === "graphs" ? (page.sliders ?? []).map((sl) => sl.name) : [])]);
        let n = 1;
        while (taken.has(`v${n}`)) n++;
        setWizard(sliderSettings(null, `v${n}`));
      }
      else if (id === "entryParametric") setGraphs((g) => openParametric(g, settings.angle === "deg"));
      else if (id === "entryDiffEq") setGraphs((g) => openDE(g));
      else if (id === "deSettings" && page?.kind === "graphs") {
        const s = page.deSettings ?? DE_DEFAULTS;
        const f = (v: number) => String(Number(v.toPrecision(14)));
        setWizard(
          openWizard({
            kind: "wizard",
            title: "Differential Equation",
            arrows: false,
            fields: [
              { label: "Solution Method:", value: s.method, options: ["Euler", "Runge-Kutta"] },
              { label: "Iterations Between Plot Step:", value: f(s.iterations) },
              { label: "Field:", value: s.field, options: ["Slope", "None"] },
              { label: "Plot Start:", value: f(s.start) },
              { label: "Plot End:", value: f(s.end) },
              { label: "Plot Step:", value: f(s.step) },
              { label: "Field Resolution:", value: f(s.resolution) },
            ],
            build: "deset:{0}:{1}:{2}:{3}:{4}:{5}:{6}",
          }),
        );
      }
    },
    [page, setGraphs, settings.angle, takenFns, defined],
  );

  const runAction = useCallback(
    (action: MenuAction | undefined) => {
      if (!action) return;
      if (action.kind === "insert") pageKey({ k: "text", text: action.text });
      else if (action.kind === "template") pageKey({ k: "template", id: action.template });
      else if (action.kind === "wizard") setWizard(openWizard(action));
      else if (action.id === "insertProblem") setDoc(insertProblem);
      else if (action.id === "addCalculator") addPage("calculator");
      else if (action.id === "addGraphs") addPage("graphs");
      else if (action.id === "docSettings") {
        setWizard(
          openWizard({
            kind: "wizard",
            title: "Document Settings",
            fields: [
              {
                label: "Display Digits:",
                value: settings.digits === 12 ? "Float" : `Float${settings.digits}`,
                options: DIGIT_OPTIONS,
              },
              { label: "Angle:", value: settings.angle === "rad" ? "Radian" : "Degree", options: ["Radian", "Degree"] },
              { label: "Exponential Format:", value: "Normal", options: ["Normal"] },
              {
                label: "Real or Complex Format:",
                value: { real: "Real", rect: "Rectangular", polar: "Polar" }[settings.complex],
                options: ["Real", "Rectangular", "Polar"],
              },
              {
                label: "Calculation Mode:",
                value: { auto: "Auto", exact: "Exact", approx: "Approximate" }[settings.mode],
                options: ["Auto", "Exact", "Approximate"],
              },
              { label: "CAS Mode:", value: "On", options: ["On"] },
              { label: "Vector Format:", value: "Rectangular", options: ["Rectangular"] },
              { label: "Base:", value: "Decimal", options: ["Decimal"] },
              { label: "Unit System:", value: "SI", options: ["SI"] },
            ],
            build: "settings:{0}:{1}:{3}:{4}",
          }),
        );
      } else if (action.id === "financeSolver") setFinance({ ...lastFinance.current, focus: 0, fresh: true });
      else if (action.id === "clearHistory") setCalc((p) => ({ ...p, history: [], sel: null }));
      else if (action.id === "clearAZ") {
        const e = engine.current;
        if (e)
          void evaluate("ClearAZ", e.giac, { settings }).then((r) => {
            if (r.ok && r.definition) {
              e.remember(r.definition);
              setDefined(definedNames(e.saved));
            }
          });
      } else graphAction(action.id);
    },
    [addPage, graphAction, pageKey, setCalc, settings],
  );

  const wizardDone = useCallback(
    (built: string) => {
      if (built.startsWith("settings:")) {
        const [digits, angle, complex, mode] = built.slice(9).split(":");
        const next: Settings = {
          digits: digits === "Float" ? 12 : Number(digits?.replace("Float", "")) || 6,
          angle: angle === "Degree" ? "deg" : "rad",
          complex: complex === "Rectangular" ? "rect" : complex === "Polar" ? "polar" : "real",
          mode: mode === "Exact" ? "exact" : mode === "Approximate" ? "approx" : "auto",
        };
        setSettings(next);
        void engine.current?.applySettings(next);
        return;
      }
      if (built.startsWith("slider:")) {
        const [, old, typed, value, min, max, step, style, digits, minimized, showName, showScale] = built.split(":");
        const name = typed?.toLowerCase();
        const lo = Number(min);
        const hi = Number(max);
        const st = step?.trim() === "Automatic" ? ("auto" as const) : Number(step);
        if (!/^[A-Za-z]\w*$/.test(name ?? "") || !(hi > lo) || (st !== "auto" && !(st > 0))) {
          setError("Error: Invalid slider settings");
          return;
        }
        const sl: Slider = {
          name: name!,
          min: lo,
          max: hi,
          step: st,
          value: 0,
          vertical: style === "Vertical",
          minimized: minimized === "Yes",
          digits,
          hideName: showName === "No",
          hideScale: showScale === "No",
        };
        sl.value = snap(sl, Number.isFinite(Number(value)) ? Number(value) : lo);
        assign(sl.name, sl.value, true);
        setGraphs((g) => {
          const rest = (g.sliders ?? []).filter((x) => x.name !== old && x.name !== sl.name);
          const at = (g.sliders ?? []).findIndex((x) => x.name === old);
          const list = [...rest];
          // Settings keep the slider where Move put it. Insert Slider puts a new
          // one at the right edge, just above the x-axis.
          const place = at < 0 && !old ? INSERTED_AT : g.sliders?.[at]?.at;
          list.splice(at < 0 ? list.length : at, 0, { ...sl, at: place });
          return { ...g, sliders: list };
        });
        return;
      }
      if (built.startsWith("deset:")) {
        const [method, iterations, field, start, end, step, resolution] = built.slice(6).split(":");
        const [it, a, b, h, res] = [iterations, start, end, step, resolution].map(Number) as number[];
        const ok = [it, a, b, h, res].every(Number.isFinite) && it! >= 1 && b! > a! && h! > 0 && res! >= 2 && res! <= 60;
        if (!ok) {
          setError("Error: Invalid differential equation settings");
          return;
        }
        setGraphs((g) => ({
          ...g,
          deSettings: {
            method: method === "Runge-Kutta" ? "Runge-Kutta" : "Euler",
            iterations: Math.round(it!),
            field: field === "None" ? "None" : "Slope",
            start: a!,
            end: b!,
            step: h!,
            resolution: Math.round(res!),
          },
        }));
        return;
      }
      if (built.startsWith("window:")) {
        const parts = built.slice(7).split(":");
        const [xmin, xmax, , ymin, ymax] = parts.map(Number);
        const scl = (s: string | undefined, lo: number, hi: number) =>
          s?.trim() === "Auto" ? autoScale(lo, hi) : Number(s);
        const xscl = scl(parts[2], xmin!, xmax!);
        const yscl = scl(parts[5], ymin!, ymax!);
        const ok = [xmin, xmax, xscl, ymin, ymax, yscl].every((v) => Number.isFinite(v));
        if (!ok || xmin! >= xmax! || ymin! >= ymax!) {
          setError("Error: Invalid window settings");
          return;
        }
        setGraphs((g) => ({
          ...g,
          window: { xmin: xmin!, xmax: xmax!, xscl: xscl!, ymin: ymin!, ymax: ymax!, yscl: yscl! },
        }));
        return;
      }
      setCalc((p) => ({ ...p, edit: wizardInsert(p.edit, built), sel: null }));
      setGraphs((g) => (g.editing !== null ? { ...g, edit: wizardInsert(g.edit, built) } : g));
    },
    [setCalc, setGraphs, assign],
  );

  // The catalog's answer to a key or a click: keep it open, or close it and insert.
  const catalogResult = useCallback(
    (r: CatalogResult) => {
      setCatalog(r.state);
      if (r.insert !== undefined) pageKey({ k: "text", text: r.insert });
      if (r.template) pageKey({ k: "template", id: r.template });
      if (r.wizard) setWizard(openWizard(r.wizard));
    },
    [pageKey],
  );

  const handleKey = useCallback(
    (key: Key) => {
      if (error) {
        if (key.k === "enter" || key.k === "esc") setError(null);
        return;
      }
      if (warning) {
        if (key.k === "enter" || key.k === "esc") setWarning(null);
        return;
      }
      if (sliderPrompt) {
        const { names, on, focus } = sliderPrompt;
        if (key.k === "enter") createSliders(names.filter((_, i) => on[i]));
        if (key.k === "enter" || key.k === "esc") setSliderPrompt(null);
        else if (key.k === "down" || key.k === "tab" || key.k === "up") {
          const by = key.k === "up" ? names.length - 1 : 1;
          setSliderPrompt({ ...sliderPrompt, focus: (focus + by) % names.length });
        } else if ((key.k === "char" && key.c === " ") || key.k === "left" || key.k === "right")
          setSliderPrompt({ ...sliderPrompt, on: on.map((v, i) => (i === focus ? !v : v)) });
        return;
      }
      // The catalog, the palette and the keypad's panels can open over a
      // dialog (they're mouse-opened), so they take keys before it does.
      if (catalog) {
        catalogResult(catalogKeyPress(catalog, key));
        return;
      }
      if (palette !== null) {
        const r = paletteKeyPress(palette, key);
        setPalette(r.index);
        if (r.insert) pageKey({ k: "template", id: r.insert });
        return;
      }
      if (menu) {
        const r = menuKeyPress(menu.items, menu.state, key);
        setMenu(r.state ? { items: menu.items, state: r.state } : null);
        runAction(r.action);
        return;
      }
      if (wizard) {
        const r = wizardKeyPress(wizard, key);
        setWizard(r.state);
        if (r.done !== undefined) wizardDone(r.done);
        return;
      }
      if (finance) {
        const r = financeKeyPress(finance, key);
        if (r.state) lastFinance.current = r.state;
        setFinance(r.state);
        if (r.error) setError(r.error);
        return;
      }
      if (key.k === "menu") {
        setMenu({
          items:
            page?.kind === "graphs"
              ? graphsMenu({ axes: page.axes, entryLine: page.editing !== null, grid: page.grid, table: page.table })
              : calculatorMenu,
          state: openMenu(),
        });
        return;
      }
      if (key.k === "doc") {
        setMenu({ items: DOC_MENU, state: openMenu() });
        return;
      }
      if (key.k === "insertPage") {
        setMenu({ items: ADD_PAGE, state: openMenu() });
        return;
      }
      if (key.k === "prevPage" || key.k === "nextPage") {
        setDoc((d) => ({
          ...d,
          active: Math.max(0, Math.min(d.pages.length - 1, d.active + (key.k === "prevPage" ? -1 : 1))),
        }));
        return;
      }
      if (key.k === "enter" || key.k === "esc") setHint(null);
      pageKey(key);
    },
    [
      error,
      warning,
      sliderPrompt,
      createSliders,
      wizard,
      finance,
      catalog,
      catalogResult,
      palette,
      menu,
      page,
      pageKey,
      runAction,
      wizardDone,
    ],
  );

  // Several keys from one keypad press: fold them over the current state so
  // none is lost (each handleKey call would start from the same render).
  const handleKeys = useCallback(
    (keys: Key[]) => {
      if (menu || catalog || palette !== null) keys.forEach(handleKey);
      else if (finance) {
        let f: FinanceState | null = finance;
        for (const k of keys) if (f) f = financeKeyPress(f, k).state;
        if (f) lastFinance.current = f;
        setFinance(f);
      } else if (wizard) {
        let w: WizardState | null = wizard;
        for (const k of keys) if (w) w = wizardKeyPress(w, k).state;
        setWizard(w);
      } else if (!error && !menu && !catalog && palette === null && page?.kind === "calculator") {
        typing.current = false;
        let p = page;
        for (const k of keys) p = calcKey(p, k).page;
        setCalc(() => p);
      } else if (!error && !menu && !catalog && palette === null && page?.kind === "graphs") {
        typing.current = false;
        let p = page;
        for (const k of keys) p = graphKey(p, k, takenFns).page;
        setGraphs(() => p);
      } else keys.forEach(handleKey);
    },
    [finance, wizard, error, menu, catalog, palette, page, setCalc, setGraphs, handleKey, takenFns],
  );

  const onKeyDown = (e: KeyboardEvent) => {
    // Ctrl+V reaches onPaste below; let the browser deliver it.
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") return;
    const key = keyFromEvent(e);
    if (!key) return;
    e.preventDefault();
    if (key.k === "copy") {
      copySelection();
      return;
    }
    if (key.k === "undo" || key.k === "redo") {
      if (!error && !warning && !sliderPrompt && !wizard && !finance && !catalog && palette === null && !menu)
        stepUndo(key.k === "undo");
      return;
    }
    if (key.k === "cut") {
      // Ctrl+X: copy the selected part of the entry line, then remove it. History can't be cut, only copied.
      if (page?.kind === "calculator" && page.sel) copySelection();
      else if (page && selection(page.edit)) {
        copySelection();
        handleKey({ k: "delete" });
      }
      return;
    }
    handleKey(key);
  };

  /**
   * Ctrl+C on a selected history item copies its text, as on the handheld;
   * with part of the entry line selected it copies that.
   */
  const copySelection = () => {
    if (page && !(page.kind === "calculator" && page.sel) && selection(page.edit)) {
      void navigator.clipboard?.writeText(selectionText(page.edit)).catch(() => undefined);
      return;
    }
    if (page?.kind !== "calculator" || !page.sel) return;
    // Part of a history line selected with the caret: just that part.
    const caret = page.sel.caret;
    if (caret && selection(caret)) {
      void navigator.clipboard?.writeText(selectionText(caret)).catch(() => undefined);
      return;
    }
    const h = page.history[page.sel.entry];
    if (!h) return;
    const text = page.sel.part === "input" ? h.inputText : h.outputText;
    void navigator.clipboard?.writeText(text).catch(() => undefined);
  };

  const onPaste = (e: ClipboardEvent) => {
    const text = e.clipboardData.getData("text").replace(/\s+/g, " ").trim();
    if (!text) return;
    e.preventDefault();
    if (wizard) handleKey({ k: "text", text });
    else handleKey({ k: "paste", text });
  };

  const pickMenu = (path: number[]) => {
    if (!menu) return;
    let items: MenuItem[] = menu.items;
    let item: MenuItem | undefined;
    for (const i of path) {
      item = items[i];
      items = item?.items ?? [];
    }
    if (item?.items) setMenu({ items: menu.items, state: { path: [...path, 0] } });
    else if (item?.action) {
      setMenu(null);
      runAction(item.action);
    }
  };

  // Menus, dialogs, errors, page changes and graph tools, read out as they change.
  useEffect(() => {
    if (menu) say(menuSaid(menu.items, menu.state));
  }, [menu, say]);
  useEffect(() => {
    if (wizard) say(wizardSaid(wizard));
  }, [wizard?.focus, wizard?.wizard, say]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (error) say(error);
  }, [error, say]);
  useEffect(() => {
    if (warning) say(`Warning. ${warning.filter(Boolean).join(" ")}`);
  }, [warning, say]);
  useEffect(() => {
    if (catalog) say(catalogSaid(catalog));
  }, [catalog, say]);
  useEffect(() => {
    if (finance) say(`Finance Solver. ${FINANCE_NAMES[finance.focus]} ${finance.values[finance.focus]}`);
  }, [finance, say]);
  useEffect(() => {
    const c = palette !== null ? PALETTE[palette] : undefined;
    if (c) say(`${c.label}${c.id ? "" : ", not available"}`);
  }, [palette, say]);
  const seenPage = useRef(false);
  useEffect(() => {
    const p = doc.pages[doc.active];
    if (seenPage.current && p) say(pageSaid(p, pageLabel(doc, doc.active)));
    seenPage.current = true;
  }, [doc.active, doc.pages.length, say]); // eslint-disable-line react-hooks/exhaustive-deps
  const sel = page?.kind === "calculator" ? page.sel : null;
  useEffect(() => {
    if (!sel || page?.kind !== "calculator") return;
    const h = page.history[sel.entry];
    if (h)
      say(
        `${sel.part === "input" ? "Entry" : "Result"} ${sel.entry + 1}: ${sel.part === "input" ? h.inputText : (h.error ?? h.outputText)}${h.warning ? `. Warning: ${h.warning[0]}` : ""}`,
      );
  }, [sel?.entry, sel?.part, say]); // eslint-disable-line react-hooks/exhaustive-deps
  const tool = page?.kind === "graphs" ? page.tool : null;
  useEffect(() => {
    if (tool) say(toolSaid(tool));
  }, [tool, say]);

  // Show me plays over several renders, so it reads the newest state through a ref.
  const latest = useRef({ doc, page, runAction, handleKey, addPage, setCalc });
  latest.current = { doc, page, runAction, handleKey, addPage, setCalc };

  // On a computer the calculator takes the keyboard as the page opens, so
  // typing works without a click first. Counted as pointer focus: no ring.
  useEffect(() => {
    if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    // A /cas?how= link opens a card; leave the keyboard with it.
    if (new URLSearchParams(window.location.search).has("how")) return;
    if (document.activeElement && document.activeElement !== document.body) return;
    pointerFocus.current = true;
    root.current?.focus({ preventScroll: true });
  }, []);
  // A character typed with focus on nothing (after a click on the page's
  // margin, say) goes to the calculator too. / is left for "How do I…", and
  // space for scrolling.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.target !== document.body || e.defaultPrevented) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1 || e.key === "/" || e.key === " ") return;
      e.preventDefault();
      pointerFocus.current = true;
      root.current?.focus({ preventScroll: true });
      latest.current.handleKey({ k: "char", c: e.key });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // The entry line as the last Show me left it: if it's still that, the next Show me starts it afresh.
  const shownLine = useRef<string | null>(null);

  /**
   * "How do I…" Show me: do it on the calculator. A menu way opens the real
   * menu and steps down to the item, a level at a time, then does what the
   * item does; a Graphs task moves to a Graphs page first (adding one if
   * there's none). Nothing is evaluated: the student fills it in and presses
   * enter. Reduced motion jumps straight there.
   */
  const showMe = useCallback(async (entry: HowTo) => {
    const way = entry.ways[0];
    if (!way) return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const wait = (ms: number) => new Promise((r) => setTimeout(r, still ? 30 : ms));
    setMenu(null);
    setWizard(null);
    setCatalog(null);
    setPalette(null);
    setFinance(null);
    const syntax = landedSyntax(entry);
    setHint(syntax);
    say(`Showing ${entry.title} on the calculator.${syntax ? ` It's written ${syntax}.` : ""}`);
    root.current?.focus({ preventScroll: true });
    const top = root.current?.getBoundingClientRect().top ?? 0;
    if (top < 64 || top > window.innerHeight * 0.6) root.current?.scrollIntoView({ behavior: still ? "auto" : "smooth", block: "start" });

    // Clear what the last Show me left untouched, so templates don't nest; never the student's own typing.
    const before = latest.current.page;
    if (before?.kind === "calculator" && before.edit.row.length && JSON.stringify(before.edit.row) === shownLine.current) {
      latest.current.setCalc((p) => ({ ...p, edit: emptyEdit(), sel: null }));
      await wait(30);
    }

    const kind = way.kind === "menu" && (way.menu === "graphs" || way.menu === "calculator") ? way.menu : null;
    if (kind && latest.current.page?.kind !== kind) {
      const at = latest.current.doc.pages.findIndex((p) => p.kind === kind);
      if (at >= 0) setDoc((d) => ({ ...d, active: at }));
      else latest.current.addPage(kind);
      await wait(250);
    }

    // A graph task on an empty Graphs page draws the card's functions first, so the tool has something to work on.
    const curves = entry.example.filter((e) => !e.output).map((e) => e.input);
    const draw = async () => {
      const g = latest.current.page;
      if (g?.kind !== "graphs" || g.functions.length || !curves.length) return;
      for (const [i, text] of curves.entries()) {
        if (i > 0 || latest.current.page?.kind !== "graphs" || latest.current.page.editing === null) {
          latest.current.runAction({ kind: "app", id: "entryFunction" });
          await wait(120);
        }
        latest.current.handleKey({ k: "paste", text });
        await wait(still ? 30 : 500);
        latest.current.handleKey({ k: "enter" });
        await wait(still ? 60 : 450);
      }
    };

    if (way.kind === "menu") {
      const r = resolve(way.menu, way.path);
      if (!r) return;
      if (way.menu === "graphs" && !way.then) await draw();
      const p = latest.current.page;
      const items =
        way.menu === "calculator"
          ? calculatorMenu
          : way.menu === "graphs" && p?.kind === "graphs"
            ? graphsMenu({ axes: p.axes, entryLine: p.editing !== null, grid: p.grid, table: p.table })
            : way.menu === "doc"
              ? DOC_MENU
              : ADD_PAGE;
      for (let depth = 0; depth < r.indices.length; depth++) {
        setMenu({ items, state: { path: r.indices.slice(0, depth + 1) } });
        await wait(depth === 0 ? 500 : 450);
      }
      setMenu(null);
      latest.current.runAction(r.action);
      for (const k of way.then ?? []) {
        await wait(still ? 30 : 350);
        latest.current.handleKey(k);
      }
      if (way.menu === "addPage") {
        await wait(250);
        await draw();
      }
    } else if (way.kind === "type") {
      latest.current.handleKey({ k: "text", text: way.text });
    } else {
      for (const k of way.play) {
        latest.current.handleKey(k);
        await wait(400);
      }
    }
    await wait(60);
    const after = latest.current.page;
    shownLine.current = after?.kind === "calculator" ? JSON.stringify(after.edit.row) : null;
  }, [say]);

  const openFeedback = (kind: FeedbackKind | null = "wrong_answer") =>
    setReport({
      kind,
      source: {
        page: page?.kind === "graphs" ? "graphs" : "calculator",
        entries: page?.kind === "calculator" ? page.history : [],
        selected: page?.kind === "calculator" ? (page.sel?.entry ?? null) : null,
        settings,
      },
    });

  return (
    <>
      {/* The page's heading with "How do I…" beside it, as a tool page sets its actions. As wide as the calculator below at its largest: the keypad, the gap and the screen (sizes from the row below). */}
      <div className={cn(DEVICE_WIDTH, "mb-[32px] flex items-center justify-between gap-[16px] max-[600px]:mb-[20px]")}>
        <h1 className="display-md m-0 text-ink">CAS</h1>
        {/* After Show me, the command's syntax: beside the field on wide screens, on its own line below on narrow ones. */}
        {hint && <SyntaxHint text={hint} onHide={() => setHint(null)} className="ml-auto hidden lg:flex" />}
        {/* Feedback beside "How do I…": its menu names the three kinds, so it reads as more than wrong answers. On phones the bar takes the row; the link under the screen stands in. */}
        <FeedbackMenu onPick={openFeedback} />
        <HowToBar
          onShow={(entry) => void showMe(entry)}
          onPaste={(text) => {
            setHint(null);
            root.current?.focus({ preventScroll: true });
            handleKey({ k: "paste", text });
          }}
        />
      </div>
      {hint && (
        <SyntaxHint text={hint} onHide={() => setHint(null)} className="mx-auto -mt-[12px] mb-[12px] max-w-[34rem] justify-between lg:hidden" />
      )}
      <div
        ref={root}
        tabIndex={0}
        role="application"
        aria-roledescription="calculator"
        aria-label="CAS calculator"
        aria-describedby="cas-help"
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onMouseDown={() => {
          pointerFocus.current = true;
          root.current?.focus({ preventScroll: true });
        }}
        onFocus={() => setKeyboardFocus(!pointerFocus.current)}
        onBlur={() => {
          pointerFocus.current = false;
          setKeyboardFocus(false);
        }}
        className={cn(
          // Phones and narrow windows: the screen over the keypad, like the
          // handheld. Wide windows: a large screen with the keypad in a panel to
          // its left, like the computer software.
          "mx-auto max-w-[34rem] outline-none lg:flex lg:max-w-none lg:flex-row-reverse lg:items-start lg:justify-center lg:gap-6",
          keyboardFocus && "ring-2 ring-accent ring-offset-4 ring-offset-bg",
        )}
      >
        <DefinedNames.Provider value={defined}>
          <p id="cas-help" className="sr-only">
            Type an expression and press Enter for the result, or Ctrl+Enter for a decimal. Up arrow goes back through
            earlier entries. Ctrl+M opens the menu, Ctrl+K the document menu and Ctrl+I adds a page; Ctrl+Left and
            Ctrl+Right change page. Results are read out.
          </p>
          <div role="status" aria-live="polite" className="sr-only">
            {said.text}
            {said.n % 2 ? "\u00a0" : ""}
          </div>
          {/* The screen fills the width, but no taller than the window leaves room for.
              Over the keypad (phones), it stays pinned under the nav while the keys
              scroll beneath it, except on a phone on its side, where it would fill the window. */}
          <div
            ref={screenBox}
            data-cas-screen
            className="sticky top-[64px] z-10 border-4 border-casBody lg:static lg:min-w-0 lg:max-w-[calc((100vh-11rem)*4/3)] lg:flex-1 [@media(max-height:499px)]:static"
          >
            <Screen
              pageLabels={doc.pages.map((_, i) => pageLabel(doc, i))}
              active={doc.active}
              title={doc.title}
              angle={settings.angle === "rad" ? "RAD" : "DEG"}
              onSelectPage={(i) => setDoc((d) => ({ ...d, active: i }))}
              onToggleAngle={() => {
                const next: Settings = { ...settings, angle: settings.angle === "rad" ? "deg" : "rad" };
                setSettings(next);
                void engine.current?.applySettings(next);
              }}
              overlay={
                <>
                  {/* Dialogs first: a panel, the catalog or the palette opened over one draws on top. */}
                  {wizard && (
                    <WizardDialog
                      state={wizard}
                      onFocus={(i) => setWizard((w) => (w ? { ...w, focus: i, fresh: true } : w))}
                      onOk={() => handleKey({ k: "enter" })}
                      onCancel={() => setWizard(null)}
                      onArrow={(i) =>
                        setWizard((w) => (w ? (wizardKeyPress({ ...w, focus: i }, { k: "right" }).state ?? w) : w))
                      }
                    />
                  )}
                  {finance && (
                    <FinanceSolver
                      state={finance}
                      onFocus={(i) => setFinance((f) => (f ? { ...f, focus: i, fresh: true } : f))}
                    />
                  )}
                  {menu && (
                    <MenuOverlay
                      menu={menu.items}
                      state={menu.state}
                      onPick={pickMenu}
                      onHover={(path) => setMenu((m) => (m ? { ...m, state: { ...m.state, path } } : m))}
                    />
                  )}
                  {catalog && (
                    <CatalogOverlay state={catalog} onChange={setCatalog} onKey={handleKey} onResult={catalogResult} />
                  )}
                  {palette !== null && (
                    <TemplatePalette
                      index={palette}
                      onPick={(i) => {
                        const id = PALETTE[i]?.id;
                        setPalette(id ? null : i);
                        if (id) pageKey({ k: "template", id });
                      }}
                    />
                  )}
                  {error && <ErrorDialog message={error} onClose={() => setError(null)} />}
                  {warning && <MessageDialog title="Warning" lines={warning} onClose={() => setWarning(null)} />}
                  {sliderPrompt && (
                    <SliderPrompt
                      ask={sliderPrompt}
                      onToggle={(i) =>
                        setSliderPrompt((a) => a && { ...a, focus: i, on: a.on.map((v, k) => (k === i ? !v : v)) })
                      }
                      onAnswer={(yes) => {
                        if (yes) createSliders(sliderPrompt.names.filter((_, i) => sliderPrompt.on[i]));
                        setSliderPrompt(null);
                      }}
                    />
                  )}
                </>
              }
            >
              {page?.kind === "calculator" && (
                <CalculatorApp
                  page={page}
                  onPick={(entry, part, paste) =>
                    setCalc((p) => {
                      const q = { ...p, sel: { entry, part } };
                      return paste ? calcKey(q, { k: "enter" }).page : q;
                    })
                  }
                  onCaret={(entry, part, caret) => setCalc((p) => ({ ...p, sel: { entry, part, caret } }))}
                  onWarning={(entry) => setWarning(page.history[entry]?.warning ?? null)}
                  onCursor={(cursor) => setCalc((p) => ({ ...p, sel: null, edit: { row: p.edit.row, cursor } }))}
                  onSelect={(a, b) => setCalc((p) => ({ ...p, sel: null, edit: selectBetween(p.edit, a, b) }))}
                />
              )}
              {page?.kind === "graphs" && (
                <GraphsApp
                  page={page}
                  giac={engine.current?.giac ?? null}
                  ready={status === "ready" || status === "busy"}
                  onSamples={(s) => (samples.current = s)}
                  onWindow={(window) => setGraphs((g) => ({ ...g, window }))}
                  onToolX={onToolX}
                  onToolFn={(n, pick) =>
                    setGraphs((g) =>
                      g.tool?.kind === "bounds"
                        ? { ...g, tool: { ...g.tool, fn: n, ...(pick ? { stage: "lower" as const, x: pick.x } : {}) } }
                        : g,
                    )
                  }
                  onConfirm={(x) => {
                    // Set the bound where the click landed, then confirm it as Enter does.
                    if (page.tool?.kind !== "bounds") return;
                    const { page: next, effect } = graphKey({ ...page, tool: { ...page.tool, x } }, { k: "enter" });
                    setGraphs(() => next);
                    if (effect) void runGraphEffect(next, effect);
                  }}
                  onEditFn={(n) => setGraphs((g) => openEntry(g, n))}
                  onEditRel={(n) => setGraphs((g) => openRelation(g, n))}
                  onEditPar={(n) => setGraphs((g) => openParametric(g, settings.angle === "deg", n))}
                  onDESettings={() => graphAction("deSettings")}
                  onSlider={(name, value, final) => {
                    setSlider(name, (sl) => ({ ...sl, value }));
                    assign(name, value, final);
                    if (final) say(`${name} = ${value}`);
                  }}
                  onSliderPlace={(name, at) => setSlider(name, (sl) => ({ ...sl, at }))}
                  onSliderAction={(name, action) => {
                    const sl = page.sliders?.find((x) => x.name === name);
                    if (!sl) return;
                    if (action === "settings") setWizard(sliderSettings(sl));
                    else if (action === "animate") {
                      if (sl.animating) assign(name, sl.value, true);
                      setSlider(name, (x) => ({ ...x, animating: !x.animating }));
                    } else if (action === "minimize") setSlider(name, (x) => ({ ...x, minimized: !x.minimized }));
                    else setSlider(name, () => null);
                  }}
                  onCursor={(cursor) => setGraphs((g) => ({ ...g, edit: { row: g.edit.row, cursor } }))}
                  onSelect={(a, b) => setGraphs((g) => ({ ...g, edit: selectBetween(g.edit, a, b) }))}
                />
              )}
              {status === "loading" && <Notice>Loading</Notice>}
              {status === "failed" && <Notice>The maths engine didn&apos;t load. Reload the page to try again.</Notice>}
            </Screen>
          </div>
          <div className="[container-type:inline-size] lg:w-[min(21rem,calc((100vh-11rem)/2))] lg:shrink-0">
            <Keypad
              onKey={handleKey}
              onKeys={handleKeys}
              onPanel={(p) => setMenu({ items: p.items, state: openMenu(p.cols) })}
              onOpen={(o) => (o.open === "templates" ? setPalette(0) : setCatalog(openCatalog(o.tab)))}
            />
          </div>
        </DefinedNames.Provider>
      </div>
      {/* Under the screen, at its edges: on wide screens the column under the keypad is left empty. */}
      <div className={cn(DEVICE_WIDTH, "mt-[16px] lg:grid lg:grid-cols-[min(21rem,calc((100vh-11rem)/2))_minmax(0,1fr)] lg:gap-x-6")}>
        <div aria-hidden className="hidden lg:block" />
        <div>
          <ScreenBar
            screen={() => screenBox.current?.firstElementChild as HTMLElement | null}
            label={pageLabel(doc, doc.active)}
            onClear={clearAll}
          />
          <div className="mt-[20px] space-y-[6px] text-sm text-inkMuted">
            <p className="m-0">
              Fine for everyday VCE maths. A few commands aren&apos;t here yet, and some answers come out in a slightly
              different form to the handheld.
            </p>
            <Legal />
            <button
              type="button"
              onClick={() => openFeedback(null)}
              className="font-medium text-ink underline underline-offset-2 hover:text-accentPressed lg:hidden"
            >
              Send feedback
            </button>
          </div>
        </div>
      </div>
      {report && <FeedbackDialog source={report.source} kind={report.kind} onClose={() => setReport(null)} />}
    </>
  );
}

/**
 * Under the screen: copy or download a picture of it, for worked solutions,
 * and clear everything. The image is 3× the screen's size on the page, so it
 * stays sharp when printed. Copy is the one most used, so it's filled; Clear
 * all sits apart at the far edge, quiet until it asks for the second click
 * (the document is saved and undo doesn't reach it).
 */
function ScreenBar({ screen, label, onClear }: { screen: () => HTMLElement | null; label: string; onClear: () => void }) {
  const [status, setStatus] = useState("");
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => {
      setConfirming(false);
      setStatus("");
    }, 4000);
    return () => clearTimeout(t);
  }, [confirming]);
  useEffect(() => {
    if (status !== "Copied.") return;
    const t = setTimeout(() => setStatus(""), 2500);
    return () => clearTimeout(t);
  }, [status]);
  const clear = () => {
    if (!confirming) {
      setConfirming(true);
      setStatus("Every page and variable will go.");
      return;
    }
    setConfirming(false);
    setStatus("");
    onClear();
  };
  const take = async () => {
    const el = screen();
    if (!el) throw new Error("No screen");
    return screenPng(el, 3);
  };
  const copy = async () => {
    try {
      const blob = await take();
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      setStatus("Copied.");
    } catch {
      setStatus("Couldn't copy here. Download instead.");
    }
  };
  const save = async () => {
    try {
      const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
      download(await take(), `cas-${label}-${stamp}.png`);
      setStatus("");
    } catch {
      setStatus("Couldn't make the image.");
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-x-[8px] gap-y-[12px]">
      <Button variant="secondary" onClick={() => void copy()}>
        <Copy aria-hidden="true" className="size-[16px]" />
        Copy image
      </Button>
      {/* Icon only on phones, so the row still fits Clear all. */}
      <Button variant="outline" onClick={() => void save()} className="max-sm:px-[14px]">
        <Download aria-hidden="true" className="size-[16px]" />
        <span className="max-sm:sr-only">Download PNG</span>
      </Button>
      <p role="status" className="m-0 ml-[8px] text-sm text-inkMuted empty:hidden max-sm:order-last max-sm:ml-0 max-sm:basis-full">
        {status}
      </p>
      <button
        type="button"
        onClick={clear}
        className={cn(
          "ml-auto inline-flex min-h-[44px] items-center gap-[8px] rounded-card px-[12px] text-[15px] tracking-[0.01em] transition-colors duration-fast",
          confirming ? "border border-signalRed font-medium text-signalRed" : "text-inkMuted hover:text-ink",
        )}
      >
        <Trash2 aria-hidden="true" className="size-[16px]" />
        {confirming ? "Clear everything" : "Clear all"}
      </button>
    </div>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="pointer-events-none absolute bottom-[1.5cqw] right-[3.5cqw] text-[2.8cqw] text-casLabel">
      {children}
    </div>
  );
}

/** The handheld's error box: a centred panel with the message and OK. */
type SliderAsk = { names: string[]; on: boolean[]; focus: number };

/**
 * Create Sliders, after graphing with variables that have no value: a box
 * for each, all ticked. Space or a click ticks and unticks, the arrows move
 * between boxes, Enter is OK.
 */
function SliderPrompt({
  ask,
  onToggle,
  onAnswer,
}: {
  ask: SliderAsk;
  onToggle: (i: number) => void;
  onAnswer: (yes: boolean) => void;
}) {
  return (
    <div className="absolute inset-0 flex items-center justify-center font-casui text-[3.9cqw]">
      <div className="relative">
        <div aria-hidden className="absolute inset-0 translate-x-[0.6cqw] translate-y-[0.6cqw] bg-casRule" />
        <div role="dialog" aria-label="Create Sliders" className="relative border border-casRule bg-casScreen px-[2cqw] py-[1.6cqw]">
          <div className="pb-[2.4cqw] text-[4.3cqw] font-bold">Create Sliders</div>
          <div className="pb-[1.4cqw] text-casLabel">Create a slider for:</div>
          {ask.names.map((n, i) => (
            <button
              key={n}
              type="button"
              tabIndex={-1}
              role="checkbox"
              aria-checked={ask.on[i]}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onToggle(i)}
              className={cn(
                "mb-[1.2cqw] flex items-center gap-[1.4cqw] border-[0.4cqw] p-[0.6cqw] text-casLabel",
                i === ask.focus ? "border-casSelect" : "border-transparent",
              )}
            >
              <CheckBox on={Boolean(ask.on[i])} />
              {n}
            </button>
          ))}
          <div className="flex justify-end gap-[2cqw] pt-[1cqw]">
            <button
              type="button"
              tabIndex={-1}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onAnswer(true)}
              className="border-[0.25cqw] border-casRule px-[4.4cqw] py-[1cqw]"
            >
              OK
            </button>
            <button
              type="button"
              tabIndex={-1}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onAnswer(false)}
              className="px-[2cqw] py-[1cqw]"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The handheld's Error and Warning boxes: bold title, the message in grey (a
 * blank line between paragraphs), a centred blue OK, the box sized to its
 * text.
 * A long message scrolls between two rules, one under the title and one
 * over the OK.
 */
function MessageDialog({ title, lines, onClose }: { title: string; lines: string[]; onClose: () => void }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-casInk/20">
      <div
        role="alertdialog"
        aria-label={title}
        className="flex max-h-[90%] min-w-[40%] max-w-[92%] flex-col border border-casInk bg-casScreen font-casui text-[3.3cqw]"
      >
        <div className="px-[2.4cqw] pt-[1.6cqw] text-[3.8cqw] font-bold text-casInk">{title}</div>
        <div className={cn("overflow-y-auto px-[2.4cqw] py-[2cqw] text-casLabel", lines.length > 3 && "mt-[1cqw] border-y border-casRule")}>
          {lines.map((l, i) => (l ? <p key={i}>{l}</p> : <p key={i} aria-hidden className="h-[1lh]" />))}
        </div>
        <div className="flex justify-center py-[1.6cqw]">
          <button type="button" onClick={onClose} className="bg-casSelect px-[5cqw] py-[1cqw] text-casScreen">
            OK
          </button>
        </div>
      </div>
    </div>
  );
}

function ErrorDialog({ message, onClose }: { message: string; onClose: () => void }) {
  const [title, ...rest] = message.split(": ");
  return <MessageDialog title={title ?? message} lines={[rest.join(": ") || message]} onClose={onClose} />;
}
