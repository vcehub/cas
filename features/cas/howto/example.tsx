// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 VCE Hub. Part of the /cas calculator: https://github.com/vcehub/cas
"use client";

import { HistoryRow } from "../calculator/history";
import { parse } from "../math/ast";
import { MathView } from "../math/render";
import { astToRow, chars, type Row } from "../math/tree";
import type { Example } from "./types";

const rowOf = (text: string): Row => {
  try {
    return astToRow(parse(text));
  } catch {
    return chars(text);
  }
};

/**
 * An entry's example as the calculator shows it: the same renderer and
 * history bands, in a small screen. A line with no answer (a graph's
 * function) shows on its own.
 */
export function ExampleScreen({ example }: { example: Example[] }) {
  return (
    <div className="overflow-hidden rounded-card border-[3px] border-casBody bg-casScreen [container-type:inline-size]">
      <div className="text-[4.6cqw] max-[600px]:text-[5.4cqw]">
        {example.map((e, i) =>
          e.output ? (
            <HistoryRow
              key={i}
              index={i}
              entry={{ id: i, input: rowOf(e.input), inputText: e.input, output: rowOf(e.output), outputText: e.output }}
              onPick={() => undefined}
            />
          ) : (
            <div key={i} className="px-[2cqw] py-[2.2cqw]">
              <MathView row={rowOf(e.input)} />
            </div>
          ),
        )}
      </div>
    </div>
  );
}
