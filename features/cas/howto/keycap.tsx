// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 VCE Hub. Part of the /cas calculator: https://github.com/vcehub/cas
import { cn } from "@/shared/lib/utils";

/** How a keypad label is printed on its key, where the label isn't the face. */
const FACES: Record<string, string> = {
  negative: "(−)",
  Up: "▲",
  Down: "▼",
  Left: "◀",
  Right: "▶",
  doc: "doc ▾",
  Templates: "templates",
  Catalog: "catalog",
};

export const faceOf = (k: string) => FACES[k] ?? (/^[a-z]$/.test(k) ? k.toUpperCase() : k);

/** A keypad key drawn small, as the keypad draws it: numbers light, ctrl in its colour, the rest dark. */
export function Keycap({ k }: { k: string }) {
  return (
    <kbd
      className={cn(
        "inline-flex h-[24px] min-w-[24px] items-center justify-center rounded-card px-[6px] font-casui text-meta font-normal leading-none",
        /^\d$/.test(k)
          ? "bg-casKeyNum text-casKeyNumText"
          : k === "ctrl"
            ? "bg-casCtrl text-casCtrlText"
            : "bg-casKeyFn text-casKeyFnText",
      )}
    >
      {faceOf(k)}
    </kbd>
  );
}
