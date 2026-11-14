// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 VCE Hub. Part of the /cas calculator: https://github.com/vcehub/cas
import type { Settings } from "../engine/evaluate";
import { bumpIds, type CasDocument } from "./document";

/**
 * The document kept in this browser between visits: pages, history,
 * settings, and the definitions to replay into the engine. Storage can be
 * missing or full (private windows, blocked site data), so every access is
 * guarded and the page works the same without it.
 */
const KEY = "vcehub.cas.v1";

export type Saved = { doc: CasDocument; settings: Settings; definitions: string[] };

export function load(): Saved | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw) as Saved;
    if (!saved?.doc?.pages?.length) return null;
    bumpIds(saved.doc);
    return saved;
  } catch {
    return null;
  }
}

export function save(s: Saved): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Storage unavailable: carry on without it.
  }
}

export function clearSaved(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // Nothing to clear.
  }
}
