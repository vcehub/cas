// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 VCE Hub. Part of the /cas calculator: https://github.com/vcehub/cas
import { useState, type ReactNode } from "react";
import { cn } from "@/shared/lib/utils";

/**
 * The calculator screen: a 4:3 panel with the top bar (page tabs, document
 * title, angle mode, battery) over the active app. Every size is in container
 * units (cqw) so the proportions hold at any width, the way a screenshot of
 * the handheld scales.
 */
export function Screen({
  pageLabels,
  active,
  title,
  angle,
  onSelectPage,
  onToggleAngle,
  children,
  overlay,
}: {
  pageLabels: string[];
  active: number;
  title: string;
  angle: string;
  onSelectPage: (i: number) => void;
  /** A click on RAD or DEG switches to the other. */
  onToggleAngle?: () => void;
  children: ReactNode;
  overlay?: ReactNode;
}) {
  return (
    <div className="relative aspect-[4/3] w-full select-none overflow-hidden bg-casScreen font-casui text-[3.4cqw] text-casInk [container-type:inline-size]">
      <div className="absolute inset-0 flex flex-col">
        <TopBar
          pageLabels={pageLabels}
          active={active}
          title={title}
          angle={angle}
          onSelectPage={onSelectPage}
          onToggleAngle={onToggleAngle}
        />
        <div className="relative min-h-0 flex-1">{children}</div>
      </div>
      {overlay}
    </div>
  );
}

const TABS_SHOWN = 3;

function TopBar({
  pageLabels,
  active,
  title,
  angle,
  onSelectPage,
  onToggleAngle,
}: {
  pageLabels: string[];
  active: number;
  title: string;
  angle: string;
  onSelectPage: (i: number) => void;
  onToggleAngle?: () => void;
}) {
  // At most three tabs show at once; the window moves only when the active
  // page would leave it, as the handheld's tab strip does.
  const [first, setFirst] = useState(0);
  const lo = Math.max(0, Math.min(first, pageLabels.length - TABS_SHOWN));
  const start = active < lo ? active : active >= lo + TABS_SHOWN ? active - TABS_SHOWN + 1 : lo;
  if (start !== first) setFirst(start);

  // Equal side columns keep the title centred however many tabs there are.
  return (
    <div className="grid h-[8.4cqw] shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-end bg-casBar text-[3.4cqw] text-casScreen">
      <div className="flex h-full min-w-0 items-end pl-[0.8cqw]">
        <Arrow dir="left" dim={active === 0} />
        {pageLabels.slice(start, start + TABS_SHOWN).map((label, j) => {
          const i = start + j;
          return (
            <button
              key={label}
              type="button"
              tabIndex={-1}
              aria-label={`Page ${label}`}
              aria-current={i === active ? "page" : undefined}
              onClick={() => onSelectPage(i)}
              className={cn(
                "mx-[0.25cqw] flex shrink-0 items-center px-[2.2cqw] text-[3.7cqw]",
                i === active ? "h-[7.4cqw] bg-casTab text-casInk" : "mb-[0.5cqw] h-[5.6cqw] bg-casTabIdle text-casInk",
              )}
            >
              {label}
            </button>
          );
        })}
        <Arrow dir="right" dim={active === pageLabels.length - 1} />
      </div>
      <div className="flex h-full max-w-[30cqw] items-center justify-center truncate px-[1cqw]">{title}</div>
      <div className="flex h-full items-center justify-end gap-[1.2cqw] pr-[1.4cqw]">
        <button
          type="button"
          tabIndex={-1}
          aria-label={angle === "RAD" ? "Radians. Switch to degrees" : "Degrees. Switch to radians"}
          onClick={onToggleAngle}
          className="text-[2.9cqw]"
        >
          {angle}
        </button>
        <Battery />
        <svg aria-hidden viewBox="0 0 10 10" className="h-[3.2cqw] w-[3.2cqw]">
          <path d="M1 1 L9 9 M9 1 L1 9" stroke="currentColor" strokeWidth={1} />
        </svg>
      </div>
    </div>
  );
}

function Arrow({ dir, dim }: { dir: "left" | "right"; dim: boolean }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 6 10"
      className={cn("mb-[2cqw] h-[3.2cqw] w-[1.9cqw] shrink-0", dim ? "text-casDim" : "text-casStrip")}
    >
      <path d={dir === "left" ? "M5.5 0.5 L0.5 5 L5.5 9.5 Z" : "M0.5 0.5 L5.5 5 L0.5 9.5 Z"} fill="currentColor" />
    </svg>
  );
}

function Battery() {
  return (
    <svg aria-hidden viewBox="0 0 8 14" className="h-[4.2cqw] w-[2.4cqw]">
      <rect x="2.5" y="0.5" width="3" height="1.5" fill="currentColor" />
      <rect x="0.5" y="2" width="7" height="11.5" fill="none" stroke="currentColor" strokeWidth={0.8} />
      <rect x="1.6" y="3.1" width="4.8" height="9.3" className="fill-casBattery" />
    </svg>
  );
}
