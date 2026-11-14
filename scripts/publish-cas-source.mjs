#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 VCE Hub. Part of the /cas calculator: https://github.com/vcehub/cas
/**
 * Publish the /cas calculator's source to the public repo (github.com/vcehub/cas).
 *
 * The calculator ships Giac, which is GPL v3, so its own code is published
 * under the GPL too: everything in features/cas, the worker that loads Giac,
 * the few shared files they import, Giac's licence and source notes, and the
 * engine checks. Nothing else in this repo goes.
 *
 *   node scripts/publish-cas-source.mjs [--ref origin/main] [--repo ../vcehub-cas-public] [--push]
 *
 * It copies from a commit (what's merged, not your working tree), works out
 * the shared files by following imports, refuses if anything private or
 * TI-sourced has crept in, then commits "Sync from vcehub@<sha>" in the public
 * clone and tags it vcehub-<sha7>. --push pushes the commit and the tag.
 * Run it after every merge that touches the calculator, so the public copy
 * matches what's live.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const ref = opt("--ref", "origin/main");
const repo = path.resolve(root, opt("--repo", "../vcehub-cas-public"));
const push = args.includes("--push");

const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();

/** Files the public repo keeps for itself; a sync never touches them. */
const OWN = new Set(["README.md", "LICENSE", "NOTICE.md", ".github", ".git"]);
/** Always published, besides features/cas and what it imports. */
const EXTRA = [
  "public/cas/worker.js",
  "public/cas/giac/COPYING",
  "public/cas/giac/SOURCE.md",
  "scripts/check-cas-correctness.mjs",
  "scripts/check-cas-howto.mjs",
  "scripts/cas-howto-queries.json",
  "scripts/publish-cas-source.mjs",
];
/** Never published: private research, TI material, secrets. */
const FORBIDDEN = [
  [/student software/i, "names TI's Student Software"],
  [/guidebook|reference guide|the guide's|Nspire (text|syntax|name|input|form|order|linear)/i, "cites TI's documentation or names the Nspire in a comment"],
  [/capture-findings|cas-work\/private|captures?-\d|rg-\d+-\d+\.png/i, "points at private TI captures"],
  [/sb_secret_|service_role|SUPABASE_SECRET|eyJhbGciOi|gh[op]_[A-Za-z0-9]{20,}|sk-ant-|AKIA[0-9A-Z]{16}/, "looks like a secret"],
];

if (!existsSync(path.join(repo, ".git"))) {
  console.error(`No public clone at ${repo}. Clone it first:\n  git clone https://github.com/vcehub/cas.git ${repo}`);
  process.exit(1);
}
if (git(repo, "status", "--porcelain")) {
  console.error(`${repo} has uncommitted changes; commit or discard them first.`);
  process.exit(1);
}

// The commit's files, unpacked to a scratch folder.
git(root, "fetch", "-q", "origin");
const sha = git(root, "rev-parse", ref);
const short = sha.slice(0, 7);
const tmp = mkdtempSync(path.join(os.tmpdir(), "cas-publish-"));
execFileSync("sh", ["-c", `git archive ${sha} features/cas shared public/cas scripts | tar -x -C "${tmp}"`], { cwd: root });

const walk = (dir) =>
  readdirSync(path.join(tmp, dir)).flatMap((name) => {
    const rel = path.join(dir, name);
    return statSync(path.join(tmp, rel)).isDirectory() ? walk(rel) : [rel];
  });

// features/cas, the extras, and whatever they import from the rest of the repo.
const files = new Set([...walk("features/cas"), ...EXTRA.filter((f) => existsSync(path.join(tmp, f)))]);
const resolve = (spec, from) => {
  const base = spec.startsWith("@/") ? spec.slice(2) : spec.startsWith(".") ? path.join(path.dirname(from), spec) : null;
  if (base === null) return null;
  for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}/index.ts`, `${base}/index.tsx`])
    if (existsSync(path.join(tmp, c)) && statSync(path.join(tmp, c)).isFile()) return path.normalize(c);
  return null;
};
const queue = [...files].filter((f) => /\.(tsx?|m?js)$/.test(f));
while (queue.length) {
  const f = queue.pop();
  const text = readFileSync(path.join(tmp, f), "utf8");
  for (const [, spec] of text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
    const hit = resolve(spec, f);
    if (hit && !files.has(hit)) {
      files.add(hit);
      if (/\.(tsx?|m?js)$/.test(hit)) queue.push(hit);
    }
  }
}

// Refuse rather than publish anything that shouldn't go.
const problems = [];
for (const f of files) {
  const text = readFileSync(path.join(tmp, f), "utf8");
  for (const [re, why] of FORBIDDEN) if (re.test(text) && f !== "scripts/publish-cas-source.mjs") problems.push(`${f}: ${why}`);
}
if (problems.length) {
  console.error(`Not published: fix these in the private repo first.\n  ${problems.join("\n  ")}`);
  rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
}

// Replace the public copy's files with these, keeping its own README, LICENSE and NOTICE.
for (const name of readdirSync(repo)) if (!OWN.has(name)) rmSync(path.join(repo, name), { recursive: true, force: true });
for (const f of [...files].sort()) {
  mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
  cpSync(path.join(tmp, f), path.join(repo, f));
}
rmSync(tmp, { recursive: true, force: true });

git(repo, "add", "-A");
const changed = git(repo, "status", "--porcelain") !== "";
if (changed) git(repo, "commit", "-q", "-m", `Sync from vcehub@${short}`, "-m", `Source of the /cas calculator as of ${sha}.`);
git(repo, "tag", "-f", `vcehub-${short}`);
console.log(`${changed ? "Committed" : "No changes; tagged"} vcehub-${short} in ${repo} (${files.size} files).`);
if (push) {
  git(repo, "push", "-q", "origin", "HEAD");
  git(repo, "push", "-q", "-f", "origin", `vcehub-${short}`);
  console.log("Pushed.");
} else console.log("Not pushed (add --push).");
