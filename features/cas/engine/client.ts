// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 VCE Hub. Part of the /cas calculator: https://github.com/vcehub/cas
import { setupCommands, type Settings } from "./evaluate";
import { userName } from "./translate";

/**
 * The page's handle on the Giac worker (public/cas/worker.js). One command at
 * a time, in order. A command that runs past the timeout restarts the worker
 * and replays every definition made so far, so variables survive.
 */
export type EngineStatus = "loading" | "ready" | "busy" | "failed";

const TIMEOUT_MS = 20000;

type Pending = { resolve: (out: string) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

export class CasEngine {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private ready!: Promise<void>;
  private definitions: string[] = [];
  private settings: Settings;
  private listeners = new Set<(s: EngineStatus) => void>();
  status: EngineStatus = "loading";

  constructor(settings: Settings) {
    this.settings = settings;
    this.start();
  }

  onStatus(fn: (s: EngineStatus) => void): () => void {
    this.listeners.add(fn);
    fn(this.status);
    return () => this.listeners.delete(fn);
  }

  private setStatus(s: EngineStatus) {
    this.status = s;
    for (const fn of this.listeners) fn(s);
  }

  private start() {
    this.setStatus("loading");
    const worker = new Worker("/cas/worker.js");
    this.worker = worker;
    this.ready = new Promise((resolve, reject) => {
      worker.onmessage = (e: MessageEvent) => {
        const d = e.data as { type?: string; id?: number; out?: string; error?: string };
        if (d.type === "ready") {
          resolve();
          return;
        }
        const p = d.id !== undefined ? this.pending.get(d.id) : undefined;
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(d.id!);
        if (!this.pending.size) this.setStatus("ready");
        if (d.error !== undefined) {
          p.resolve(`Error: ${d.error}`);
          // A Giac exception leaves the wasm runtime broken (every later call
          // aborts), so the engine is restarted with the user's definitions.
          queueMicrotask(() => this.restart());
        } else p.resolve(d.out ?? "");
      };
      worker.onerror = () => {
        this.setStatus("failed");
        reject(new Error("engine failed to load"));
      };
    });
    this.ready
      .then(async () => {
        for (const c of setupCommands(this.settings)) await this.raw(c);
        for (const c of this.definitions) await this.raw(c);
        this.setStatus("ready");
      })
      .catch(() => this.setStatus("failed"));
  }

  private raw(cmd: string): Promise<string> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.restart(), TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.worker?.postMessage({ id, cmd });
    });
  }

  /** Kill a stuck computation and bring the engine back with its variables. */
  restart() {
    this.worker?.terminate();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.resolve("Error: Interrupted");
    }
    this.pending.clear();
    this.start();
  }

  /** Evaluate one Giac command. */
  giac = async (cmd: string): Promise<string> => {
    await this.ready;
    this.setStatus("busy");
    return this.raw(cmd);
  };

  /** Remember a definition so a restart can replay it. */
  remember(cmd: string) {
    this.definitions.push(cmd);
  }

  /** Definitions so far, for saving; restore() replays a saved list. */
  get saved(): string[] {
    return this.definitions.slice();
  }

  async restore(defs: string[]) {
    this.definitions = defs.slice();
    await this.ready;
    for (const c of defs) await this.raw(c);
  }

  async applySettings(s: Settings) {
    this.settings = s;
    await this.ready;
    for (const c of setupCommands(s)) await this.raw(c);
  }

  async clearAll() {
    this.definitions = [];
    await this.ready;
    await this.raw("restart");
    for (const c of setupCommands(this.settings)) await this.raw(c);
  }

  dispose() {
    this.worker?.terminate();
    this.worker = null;
  }
}

/**
 * The names a list of definitions leaves defined, in order: f(x):=… and
 * a:=… add a name, purge(…) (DelVar, Clear a–z) removes it. Engine-internal
 * names (ending in _) are left out.
 */
export function definedNames(defs: string[]): Set<string> {
  const out = new Set<string>();
  for (const raw of defs) {
    const d = raw.trim();
    const purge = /^purge\((.*)\)$/.exec(d);
    if (purge) {
      for (const n of purge[1]!.split(",")) out.delete(userName(n.trim()));
      continue;
    }
    const m = /^([A-Za-z]\w*)\s*(?:\([^)]*\))?\s*:=/.exec(d);
    if (m && !m[1]!.endsWith("_")) out.add(userName(m[1]!));
  }
  return out;
}

/** User functions and their stored bodies (Giac text), from the saved definitions: the latest of each, purged ones gone. */
export function definedFunctions(defs: string[]): Map<string, { params: string[]; body: string }> {
  const out = new Map<string, { params: string[]; body: string }>();
  for (const raw of defs) {
    const d = raw.trim();
    const purge = /^purge\((.*)\)$/.exec(d);
    if (purge) {
      for (const n of purge[1]!.split(",")) out.delete(userName(n.trim()));
      continue;
    }
    const m = /^([A-Za-z]\w*)\s*\(([^)]*)\)\s*:=([\s\S]*)$/.exec(d);
    if (!m || m[1]!.endsWith("_")) continue;
    const params = m[2]!.split(",").map((x) => userName(x.trim()));
    out.set(userName(m[1]!), { params, body: m[3]! });
  }
  return out;
}
