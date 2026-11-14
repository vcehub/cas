// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 VCE Hub. Part of the /cas calculator: https://github.com/vcehub/cas
import type { HowTo } from "../types";
import { ALGEBRA } from "./algebra";
import { BASICS } from "./basics";
import { CALCULUS } from "./calculus";
import { GRAPHS } from "./graphs";
import { PROBABILITY } from "./probability";
import { COMPLEX, DE, FINANCE, MATRICES, VECTORS } from "./specialist";
import { STATISTICS } from "./statistics";

/** Every entry, in browsing order. scripts/check-cas-howto.mjs runs each example and resolves each menu path. */
export const HOWTOS: HowTo[] = [
  ...BASICS,
  ...ALGEBRA,
  ...CALCULUS,
  ...GRAPHS,
  ...PROBABILITY,
  ...STATISTICS,
  ...VECTORS,
  ...COMPLEX,
  ...DE,
  ...MATRICES,
  ...FINANCE,
];

export const howToById = (id: string) => HOWTOS.find((h) => h.id === id);
