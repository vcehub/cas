/**
 * VCE Hub design tokens — single source of truth for every hex value.
 *
 * Melbourne "reading room" (2026-08): the State Library reading room after
 * dark — plaster cream walls, timber ink, and the green glass reading lamps
 * as the only lit thing on the desk. Brass is the fitting on the lamp, not
 * the lamp: decorative warmth only, never a fill you can click.
 *
 * This is the ONLY file allowed to contain raw hex literals (plus the
 * tailwind.config.ts re-export, which imports from here, and globals.css).
 *
 * Legacy token names (fg, secondary, hoverFill, subtleBorder, cardDesc,
 * tagline, prose, tableHead, tableLabel, tableText, avatarFill, muted,
 * faint, white) are preserved so the ~60 files referencing them as Tailwind
 * classes keep compiling — their VALUES are remapped onto the new system.
 * New components should use the semantic tokens, not the aliases.
 */

export const palette = {
  // === Surface — plaster cream warming into stone ===
  bg:             "#faf8f3",
  surface:        "#f3eee1",
  // Full-bleed page bands ONLY — never card-scale, that is what `surface` is for.
  // 1.24:1 against bg, ~2.5x the separation `surface` gives, which is the
  // difference between "did something change?" and "that's a different panel".
  // `surface` could not do this job: at 1.09:1 it is already the darkest tone
  // that keeps BOTH body-text tokens legal (inkMuted clears AA on it by 0.10),
  // so the only way to go bolder was a tone that gives inkMuted up.
  // Inside a surfaceDeep band: inkMuted -> inkBody, accent-as-text ->
  // accentPressed, hairline borders -> borderStrong. See docs/design.md.
  surfaceDeep:    "#e9e0cb",   // 1.24:1 on bg; inkBody 6.28, inkMuted 4.06 (too low — do not use)
  surfaceHover:   "#ece5d4",
  hairline:       "#e3dac7",
  borderStrong:   "#9b8f72",   // 3.01:1 on bg — the one border that carries weight

  // === Ink — timber, never neutral grey ===
  ink:            "#261f18",   // 15.32:1 on bg
  inkStrong:      "#332a21",   // 13.24:1
  inkBody:        "#574d42",   //  7.77:1
  inkMuted:       "#736a5b",   //  5.02:1 on bg, 4.60:1 on surface — but 4.24:1 on surfaceHover: never put muted text on a hover fill; use inkBody there

  // === Accent — reading-lamp emerald. Interactive / "lit" only. ===
  accent:         "#0f7a3c",   // 5.11:1 on bg; 5.43:1 under accentOn
  accentPressed:  "#09661e",   // 6.75:1 on bg; text on accentSoft uses THIS
  accentSoft:     "#e5efe3",   // tint fill only — pair with accentPressed (6.07:1)
  accentOn:       "#ffffff",

  // === Brass — decorative warmth (featured borders, wordmark moment). ===
  // Never a button fill, never a status colour.
  accentWarm:     "#9d622b",   // 4.69:1 on bg

  // === Lamplight — the light the lamp throws. The mark and after-dark
  // surfaces only, never text, never a border, never a fill you can click.
  // It exists because every other warm token in this file is a *fitting*
  // colour dark enough to sit on cream, and light that is darker than the
  // page it falls on reads as a stain. This one is lighter than `bg`, so it
  // only does anything on `ink` — which is the point: the brand is the
  // reading room after dark, and a glow needs a dark room to be a glow.
  lampLight:      "#f2c98a",   // the lit mouth and the spill
  lampCore:       "#fdf3e2",   // the bulb itself, one step brighter

  // === Oxide — Princes Bridge ironwork red. Decorative linework only. ===
  // Same hex as signalRed deliberately: one red, two roles, disambiguated by
  // FORM — oxide is always a drawn line (rule, underline, border edge),
  // never a letter, never a fill you can click. signalRed stays the only red text.
  oxide:          "#a03327",   // 6.60:1 on bg — same row as signalRed

  // === Signal — status only, never interactive. Muted to sit on cream. ===
  signalRed:      "#a03327",   // 6.60:1 on bg
  signalAmber:    "#8f6430",   // 4.91:1
  signalGreen:    "#557a3a",   // 4.68:1

  // === Subject — the calendar's eight subject colours (2026-10). ===
  // Data colours, not brand colours: a swatch, or a 13% tint mixed into bg,
  // that tells subjects apart. Never text, never a button, never status.
  // All at least 3:1 on bg as a swatch, at least 32 ΔE from accent and every
  // signal (so a Physics class never reads as a SAC flag), and 1–5 at least
  // 22 ΔE from each other. On a tint, inkMuted drops to ~4.2:1 — secondary
  // text inside a tinted block uses inkBody. See docs/design.md.
  subject1:       "#3b5f8f",   // denim     6.15:1 on bg
  subject2:       "#2b7470",   // teal      5.16:1
  subject3:       "#a8496a",   // rose      5.17:1
  subject4:       "#7a5288",   // plum      5.84:1
  subject5:       "#5e6b78",   // slate     5.14:1
  subject6:       "#3787a8",   // cerulean  3.81:1
  subject7:       "#764d64",   // wine      6.56:1
  subject8:       "#2f3d63",   // navy     10.05:1

  // === CAS — the /cas calculator screen (2026-11). ===
  // Neutral greys and a calculator's own blues, deliberately outside the
  // brand: the screen should read as the handheld students already know.
  // Only features/cas uses these; the page around the screen stays on brand.
  casBar:         "#3d3d3d",   // top bar
  casTab:         "#f4f4f4",   // active page tab
  casTabIdle:     "#c4c4c4",   // inactive tab label on the bar
  casScreen:      "#ffffff",
  casRowAlt:      "#f2f2f2",   // alternate history rows
  casRule:        "#cfcfcf",   // scrollbar track, dialog field borders
  casInk:         "#0a0a0a",
  casDim:         "#8a8a8a",   // greyed menu items, scrollbar arrows (disabled only: 3.5:1)
  casLabel:       "#5c5c5c",   // dialog field labels (6.7:1 on white)
  casSelect:      "#2c64c8",   // selected menu row / list row (white text)
  casSelectSoft:  "#cddff7",   // selected text in a dialog field
  casHistorySelect: "#6cbfe6", // selected history item (casInk on it 9:1)
  casSelectParent: "#9dbfea",  // menu row whose submenu is open
  casStrip:       "#3d9fd8",   // the line under the top bar on a Graphs page, and round its entry line
  casShade:       "#c4c4c4",   // integral shading
  casBattery:     "#3cb043",
  casWarn:        "#f5c518",   // the ⚠ triangle beside an entry with a warning (casInk outline and !)
  // Graph colours, f1 onward. f1 and f2 are taken from screenshots; the
  // rest of the order is unconfirmed.
  casF1:          "#1f4fd8",
  casF2:          "#d6271c",
  casF3:          "#1e8c2f",
  casF4:          "#c96a00",
  casF5:          "#7b2fbf",
  casF6:          "#00838f",

  // === Legacy aliases — remapped onto the new system ===
  // No cool greys survive: every alias lands on a warm-cast value.
  fg:             "#261f18",   // = ink
  secondary:      "#736a5b",   // = inkMuted
  hoverFill:      "#ece5d4",   // = surfaceHover
  subtleBorder:   "#e3dac7",   // = hairline
  cardDesc:       "#574d42",   // = inkBody
  tagline:        "#574d42",   // = inkBody
  prose:          "#332a21",   // = inkStrong
  tableHead:      "#f3eee1",   // = surface
  tableLabel:     "#736a5b",   // = inkMuted
  tableText:      "#574d42",   // = inkBody
  white:          "#ffffff",

  // Warm stone-greys. Only call site across the repo is `bg-avatarFill` on
  // the Switch's unchecked track (shared/ui/switch.tsx) — a UI affordance, so
  // it is held to the 3:1 floor, not the 4.5:1 text floor: 3.35:1 on bg,
  // 3.07:1 on surface, 3.55:1 under the white thumb, and 4.58:1 away from the
  // ink checked state. `muted` and `faint` have no call sites; they are
  // decorative neutrals below the text floor — for text use inkMuted.
  avatarFill:     "#93876a",
  muted:          "#b0a790",
  faint:          "#b9b09b",
} as const;

export type PaletteToken = keyof typeof palette;

// === CAS keypad (2026-11) ===
// The /cas keypad and the screen's frame: warm near-black, cream number keys,
// lamplight labels, a green ctrl. Only features/cas uses these.
export const casKeypad = {
  casBody:        "#1d1b18", // keypad frame and screen frame
  casBodyLow:     "#28251f", // keypad deck
  casKeyFn:       "#13110f", // function and letter keys
  casKeyFnText:   "#f3eee4",
  casKeyNum:      "#ece5d6", // number keys
  casKeyNumText:  "#1d1b18", // 14:1 on casKeyNum
  casKeyLight:    "#b0a898", // x, y, z
  casKeyLightText:"#13110f", // 8.2:1
  casKeyLip:      "#0b0a09", // the shadow under each key
  casKeyAlt:      "#f2c98a", // ctrl functions printed above the keys (lampLight, 11:1 on the deck)
  casCtrl:        "#13804a", // the ctrl key
  casCtrlText:    "#ffffff", // 4.9:1
  casPad:         "#2d2a25", // touchpad
  casPadRim:      "#45413a",
  casPadText:     "#f3eee4", // the touchpad arrows
} as const;
