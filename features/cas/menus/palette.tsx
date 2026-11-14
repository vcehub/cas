// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 VCE Hub. Part of the /cas calculator: https://github.com/vcehub/cas
import type { ReactNode } from "react";
import { cn } from "@/shared/lib/utils";
import type { Key } from "../keys";
import type { TemplateId } from "./types";

/**
 * The templates key's palette: a grid of 2D templates in the handheld's
 * order, arrows to move, Enter to insert. The glyphs are our own drawings of
 * the maths each template makes. Templates not built here are greyed.
 */
const B = () => <span className="inline-block h-[1.5cqw] w-[1.3cqw] border-[0.18cqw] border-current" />;
const Col = ({ children, className }: { children: ReactNode; className?: string }) => (
  <span className={cn("inline-flex flex-col items-center gap-[0.3cqw]", className)}>{children}</span>
);
const Row = ({ children }: { children: ReactNode }) => (
  <span className="inline-flex items-center gap-[0.3cqw]">{children}</span>
);
const Sup = ({ children }: { children: ReactNode }) => <span className="-mt-[1.6cqw] scale-75">{children}</span>;
const Sub = ({ children }: { children: ReactNode }) => <span className="-mb-[1.6cqw] scale-75">{children}</span>;
const Frac = ({ top, bottom }: { top: ReactNode; bottom: ReactNode }) => (
  <Col className="gap-[0.2cqw]">
    {top}
    <span className="h-[0.18cqw] w-full bg-current" />
    {bottom}
  </Col>
);
const Brace = ({ rows }: { rows: ReactNode[] }) => (
  <Row>
    <span className="text-[4cqw] leading-none">{"{"}</span>
    <Col>{rows}</Col>
  </Row>
);
const Bracket = ({ children }: { children: ReactNode }) => (
  <Row>
    <span className="text-[4cqw] leading-none">[</span>
    {children}
    <span className="text-[4cqw] leading-none">]</span>
  </Row>
);
const Grid = ({ n, m }: { n: number; m: number }) => (
  <span className="inline-grid gap-[0.3cqw]" style={{ gridTemplateColumns: `repeat(${m}, auto)` }}>
    {Array.from({ length: n * m }, (_, i) => (
      <B key={i} />
    ))}
  </span>
);

type Cell = { label: string; id?: TemplateId; glyph: ReactNode };

export const PALETTE: Cell[] = [
  { label: "Fraction", id: "frac", glyph: <Frac top={<B />} bottom={<B />} /> },
  {
    label: "Exponent",
    id: "pow",
    glyph: (
      <Row>
        <B />
        <Sup>
          <B />
        </Sup>
      </Row>
    ),
  },
  {
    label: "Square root",
    id: "sqrt",
    glyph: (
      <Row>
        √<B />
      </Row>
    ),
  },
  {
    label: "Nth root",
    id: "nroot",
    glyph: (
      <Row>
        <Sup>
          <B />
        </Sup>
        √<B />
      </Row>
    ),
  },
  {
    label: "e exponent",
    id: "exp",
    glyph: (
      <Row>
        <i className="font-casmath">e</i>
        <Sup>
          <B />
        </Sup>
      </Row>
    ),
  },
  {
    label: "Log base",
    id: "logbase",
    glyph: (
      <Row>
        log
        <Sub>
          <B />
        </Sub>
        <B />
      </Row>
    ),
  },
  {
    label: "Piecewise, 2 pieces",
    id: "piecewise2",
    glyph: (
      <Brace
        rows={[
          <Row key={0}>
            <B />,<B />
          </Row>,
          <Row key={1}>
            <B />,<B />
          </Row>,
        ]}
      />
    ),
  },
  {
    label: "Piecewise, n pieces",
    glyph: (
      <Brace
        rows={[0, 1, 2].map((k) => (
          <Row key={k}>
            <B />,<B />
          </Row>
        ))}
      />
    ),
  },
  { label: "System of 2 equations", id: "system2", glyph: <Brace rows={[<B key={0} />, <B key={1} />]} /> },
  { label: "System of n equations", glyph: <Brace rows={[<B key={0} />, <B key={1} />, <B key={2} />]} /> },
  {
    label: "Absolute value",
    id: "abs",
    glyph: (
      <Row>
        |<B />|
      </Row>
    ),
  },
  {
    label: "Degrees, minutes, seconds",
    glyph: (
      <Row>
        <B />°<B />′<B />″
      </Row>
    ),
  },
  {
    label: "Matrix, 2 by 2",
    id: "matrix",
    glyph: (
      <Bracket>
        <Grid n={2} m={2} />
      </Bracket>
    ),
  },
  {
    label: "Row matrix",
    glyph: (
      <Bracket>
        <Grid n={1} m={2} />
      </Bracket>
    ),
  },
  {
    label: "Column matrix",
    glyph: (
      <Bracket>
        <Grid n={2} m={1} />
      </Bracket>
    ),
  },
  {
    label: "Matrix, m by n",
    glyph: (
      <Bracket>
        <Grid n={3} m={3} />
      </Bracket>
    ),
  },
  {
    label: "Sum",
    id: "sum",
    glyph: (
      <Row>
        <Col>
          <B />Σ<B />
        </Col>
        <B />
      </Row>
    ),
  },
  {
    label: "Product",
    id: "product",
    glyph: (
      <Row>
        <Col>
          <B />Π<B />
        </Col>
        <B />
      </Row>
    ),
  },
  {
    label: "Derivative",
    id: "deriv",
    glyph: (
      <Row>
        <Frac
          top="d"
          bottom={
            <Row>
              d<B />
            </Row>
          }
        />
        <B />
      </Row>
    ),
  },
  {
    label: "Second derivative",
    glyph: (
      <Row>
        <Frac
          top="d²"
          bottom={
            <Row>
              d<B />²
            </Row>
          }
        />
        <B />
      </Row>
    ),
  },
  {
    label: "Nth derivative",
    id: "nderiv",
    glyph: (
      <Row>
        <Frac
          top="dⁿ"
          bottom={
            <Row>
              d<B />ⁿ
            </Row>
          }
        />
        <B />
      </Row>
    ),
  },
  {
    label: "Definite integral",
    id: "defintegral",
    glyph: (
      <Row>
        <Col>
          <B />
          <span className="text-[4cqw] leading-none">∫</span>
          <B />
        </Col>
        <B />d<B />
      </Row>
    ),
  },
  {
    label: "Indefinite integral",
    id: "integral",
    glyph: (
      <Row>
        <span className="text-[4cqw] leading-none">∫</span>
        <B />d<B />
      </Row>
    ),
  },
  {
    label: "Limit",
    id: "limit",
    glyph: (
      <Row>
        <Col>
          lim
          <Row>
            <B />→<B />
          </Row>
        </Col>
        <B />
      </Row>
    ),
  },
  {
    label: "Subscript",
    glyph: (
      <Row>
        <B />
        <Sub>
          <B />
        </Sub>
      </Row>
    ),
  },
];

const COLS = 11;

/** A cell in a grid palette (templates here, symbols in the catalog). */
export type GridCell = { label: string; glyph: ReactNode; enabled: boolean };

/** Arrow keys in a grid of `n` cells, `cols` wide: the new index, or what Enter/Esc mean. */
export function gridMove(index: number, key: Key, n: number, cols: number): number | "enter" | "esc" {
  switch (key.k) {
    case "left":
      return (index - 1 + n) % n;
    case "right":
      return (index + 1) % n;
    case "up":
      return index - cols >= 0 ? index - cols : index;
    case "down":
      return index + cols < n ? index + cols : index;
    case "enter":
      return "enter";
    case "esc":
      return "esc";
    default:
      return index;
  }
}

/** A key while the palette is open: the new selection, or a template to insert, or null to close. */
export function paletteKeyPress(index: number, key: Key): { index: number | null; insert?: TemplateId } {
  const r = gridMove(index, key, PALETTE.length, COLS);
  if (r === "esc") return { index: null };
  if (r === "enter") {
    const id = PALETTE[index]?.id;
    return id ? { index: null, insert: id } : { index };
  }
  return { index: r };
}

export function CellGrid({
  cells,
  cols,
  index,
  label,
  onPick,
}: {
  cells: GridCell[];
  cols: number;
  index: number;
  label: string;
  onPick: (i: number) => void;
}) {
  return (
    <div
      role="listbox"
      aria-label={label}
      className="relative grid gap-px border border-casRule bg-casRule"
      style={{ gridTemplateColumns: `repeat(${cols}, 7.4cqw)` }}
    >
      {cells.map((c, i) => (
        <button
          key={`${c.label}-${i}`}
          type="button"
          tabIndex={-1}
          role="option"
          aria-label={c.label}
          aria-selected={i === index}
          aria-disabled={!c.enabled || undefined}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(i)}
          className={cn(
            "flex h-[7.4cqw] items-center justify-center text-[2.6cqw] leading-none",
            i === index ? "bg-casTabIdle" : "bg-casScreen",
            c.enabled ? "text-casInk" : "text-casDim",
          )}
        >
          {c.glyph}
        </button>
      ))}
      {Array.from({ length: (cols - (cells.length % cols)) % cols }, (_, i) => (
        <span key={`blank-${i}`} className="bg-casScreen" />
      ))}
    </div>
  );
}

export const TEMPLATE_CELLS: GridCell[] = PALETTE.map((c) => ({ label: c.label, glyph: c.glyph, enabled: Boolean(c.id) }));
export const PALETTE_COLS = COLS;

export function TemplatePalette({ index, onPick }: { index: number; onPick: (i: number) => void }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <div className="relative">
        <div aria-hidden className="absolute inset-0 translate-x-[0.6cqw] translate-y-[0.6cqw] bg-casRule" />
        <CellGrid cells={TEMPLATE_CELLS} cols={COLS} index={index} label="Templates" onPick={onPick} />
      </div>
    </div>
  );
}
