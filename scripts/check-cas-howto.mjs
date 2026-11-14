#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 VCE Hub. Part of the /cas calculator: https://github.com/vcehub/cas
/**
 * "How do I…" check (features/cas/howto):
 *
 * - Every entry: a unique id, every menu path resolves to a built item in
 *   the live menus (a renamed or moved item fails here, not on the page),
 *   and a syntax line.
 * - Every example, entry by entry in a fresh engine, through the same
 *   evaluate() the page uses: what the card shows is what the calculator
 *   gives.
 * - Search: each query in scripts/cas-howto-queries.json has its expected
 *   entry in the top 3. The bar is 95%; every miss is printed.
 *
 *   node scripts/check-cas-howto.mjs [--search-only] [--queries <file>]
 */
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const build = path.join(root, "node_modules/.cache/cas-howto-build");
rmSync(build, { recursive: true, force: true });
execFileSync(
  path.join(root, "node_modules/.bin/tsc"),
  [
    ...["engine/evaluate.ts", "howto/entries/index.ts", "howto/paths.ts", "howto/search.ts"].map((f) => path.join(root, "features/cas", f)),
    "--outDir", build, "--rootDir", path.join(root, "features/cas"),
    "--module", "commonjs", "--target", "es2022", "--skipLibCheck", "--strict", "--jsx", "react-jsx",
  ],
  { stdio: "inherit" },
);
const require = createRequire(import.meta.url);
const { evaluate, setupCommands, DEFAULT_SETTINGS } = require(path.join(build, "engine/evaluate.js"));
const { HOWTOS } = require(path.join(build, "howto/entries/index.js"));
const { resolve, syntaxOf } = require(path.join(build, "howto/paths.js"));
const { searchHowTo } = require(path.join(build, "howto/search.js"));
const searchOnly = process.argv.includes("--search-only");

let failed = 0;
let passed = 0;
const check = (name, ok, detail = "") => {
  if (ok) passed++;
  else {
    failed++;
    console.log(`FAIL  ${name}${detail ? `: ${detail}` : ""}`);
  }
};

// ------------------------------------------------------------ entries
const ids = new Set();
for (const h of HOWTOS) {
  check(`${h.id} unique`, !ids.has(h.id));
  ids.add(h.id);
  check(`${h.id} has a way`, h.ways.length > 0 || Boolean(h.shortcuts?.length));
  for (const w of h.ways) {
    if (w.kind === "menu") check(`${h.id} path ${w.path.join(" › ")}`, resolve(w.menu, w.path) !== null, `not in the ${w.menu} menu, or not built`);
  }
  const first = h.ways[0];
  // A command on the entry line needs its syntax shown; a setting or a dialog doesn't.
  const action = first?.kind === "menu" ? resolve(first.menu, first.path)?.action : null;
  const needsSyntax = action && action.kind !== "app" && h.example.some((e) => e.output);
  if (needsSyntax) check(`${h.id} syntax`, Boolean(syntaxOf(h)), "no syntax line: add one, or a catalog line for its command");
}

// ------------------------------------------------------------ examples
if (!searchOnly) {
  const M = require(path.join(root, "public/cas/giac/1.9.0/giacwasm.js"));
  await new Promise((res) => (M.calledRun ? res() : (M.onRuntimeInitialized = res)));
  const caseval = M.cwrap("caseval", "string", ["string"]);
  // Giac prints to the console; keep the report readable.
  const quiet = async (fn) => {
    const [log, err, warn] = [console.log, console.error, console.warn];
    const write = process.stdout.write.bind(process.stdout);
    console.log = console.error = console.warn = () => {};
    process.stdout.write = () => true;
    try {
      return await fn();
    } finally {
      Object.assign(console, { log, error: err, warn });
      process.stdout.write = write;
    }
  };
  const giac = async (c) => caseval(c);
  for (const h of HOWTOS) {
    await quiet(() => {
      caseval("restart");
      for (const c of setupCommands(DEFAULT_SETTINGS)) caseval(c);
    });
    let ans;
    for (const [i, e] of h.example.entries()) {
      if (!e.output) continue;
      const res = await quiet(() => evaluate(e.input, giac, { settings: DEFAULT_SETTINGS, ans, approx: e.approx }));
      const got = res.ok ? res.outputText : `error ${res.error}`;
      if (res.ok) ans = res.output;
      check(`${h.id} example ${i + 1}`, got === e.output, `${e.input} gives ${got}, the card shows ${e.output}`);
    }
  }
}

// ------------------------------------------------------------ search
const qfile = process.argv.includes("--queries") ? process.argv[process.argv.indexOf("--queries") + 1] : path.join(root, "scripts/cas-howto-queries.json");
const queries = JSON.parse(readFileSync(qfile, "utf8"));
let top3 = 0;
let top1 = 0;
const misses = [];
const seconds = [];
for (const [q, want] of queries) {
  check(`query target ${want}`, ids.has(want));
  const got = searchHowTo(HOWTOS, q).map((h) => h.id);
  if (got[0] === want) top1++;
  else if (got.slice(0, 3).includes(want)) seconds.push(`  "${q}" → ${got[0]} first, ${want} after`);
  if (got.slice(0, 3).includes(want)) top3++;
  else misses.push(`  "${q}" → want ${want}, got ${got.slice(0, 3).join(", ") || "nothing"}`);
}
const rate = top3 / queries.length;
console.log(`\nSearch: ${top3}/${queries.length} in the top 3 (${(rate * 100).toFixed(1)}%)`);
if (misses.length) console.log(misses.join("\n"));
// Enter shows the first result, so first place is worth reading too (reported, not enforced).
console.log(`First: ${top1}/${queries.length} (${((top1 / queries.length) * 100).toFixed(1)}%)`);
if (process.argv.includes("--firsts")) console.log(seconds.join("\n"));
check("search top-3 rate ≥ 95%", rate >= 0.95);

// ------------------------------------------------------------ walk expectations
// --expect <file>: what each entry's Show me should leave on the page, for scripts/walk-cas-howto.py.
if (process.argv.includes("--expect")) {
  const { writeFileSync } = await import("node:fs");
  const DIALOGS = { docSettings: "Document Settings", windowSettings: "Window Settings", insertSlider: "Slider Settings" };
  // A reference list (keyboard shortcuts) has no Show me to walk.
  const out = HOWTOS.filter((h) => h.ways.length > 0).map((h) => {
    const w = h.ways[0];
    if (w.kind === "type") return { id: h.id, text: w.text.replace(/[( ]+$/, "").trim() };
    if (w.kind === "keys") return { id: h.id, text: w.play.map((k) => (k.k === "text" ? k.text : "")).join("") || null, after: h.example.find((e) => e.approx)?.output ?? null };
    const a = resolve(w.menu, w.path).action;
    if (a.kind === "insert") return { id: h.id, text: a.text.replace(/[( ]+$/, "") };
    if (a.kind === "wizard") return { id: h.id, dialog: a.title };
    if (a.kind === "app" && DIALOGS[a.id]) return { id: h.id, dialog: DIALOGS[a.id] };
    if (w.menu === "graphs" || a.id === "addGraphs") return { id: h.id, canvas: true };
    return { id: h.id, changed: true };
  });
  writeFileSync(process.argv[process.argv.indexOf("--expect") + 1], JSON.stringify(out, null, 1));
}

console.log(`\n${HOWTOS.length} entries. ${passed} checks pass, ${failed} fail`);
process.exit(failed ? 1 : 0);
