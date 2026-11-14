// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 VCE Hub. Part of the /cas calculator: https://github.com/vcehub/cas
import { app, off, rule, sub, type Menu } from "./types";

/**
 * The Graphs app's menu. Item positions are the contract (see types.ts):
 * the same keystrokes reach the same command.
 *
 * Some labels follow the page, as they do on the handheld: Hide Axes reads
 * Show Axes once the axes are hidden, and the current grid is greyed.
 */

/** The page state the menu's labels depend on. */
export type GraphsMenuState = { axes: boolean; entryLine: boolean; grid: "none" | "dot" | "line"; table: boolean };

export function graphsMenu(s: GraphsMenuState): Menu {
  const grid = (label: string, id: string, kind: GraphsMenuState["grid"]) => (s.grid === kind ? off(label) : app(label, id));
  return [
    sub("Actions", [
      off("Pointer"),
      sub("Select", [off("Region"), off("Image"), off("Grid")]),
      off("Hide/Show"),
      rule(off("Attributes")),
      off("Set Conditions"),
      app("Delete all", "deleteAll"),
      rule(off("Text")),
      off("Coordinates and Equations"),
      off("Calculate"),
      off("Redefine"),
      app("Insert Slider", "insertSlider"),
      rule(off("MathDraw")),
    ]),
    sub("View", [
      off("Graphing"),
      off("Plane Geometry"),
      off("3D Graphing"),
      rule(off("Hide Analytic Window")),
      app(s.axes ? "Hide Axes" : "Show Axes", "viewHideAxes"),
      sub("Grid", [
        grid("No Grid", "viewNoGrid", "none"),
        grid("Dot Grid", "viewDotGrid", "dot"),
        grid("Lined Grid", "viewLinedGrid", "line"),
      ]),
      { ...app(s.entryLine ? "Hide Entry Line" : "Show Entry Line", "viewEntryLine"), hint: "Ctrl+G" },
      off("Hide Axes End Values"),
      rule(off("Hide Object Selection Guides")),
    ]),
    rule(
      sub("Graph Entry/Edit", [
        app("Function", "entryFunction"),
        app("Relation", "entryRelation"),
        sub("Equation Templates", [
          sub("Line", [off("Line Slope Intercept"), off("Vertical Line"), off("Line Standard")]),
          sub("Parabola", [off("Vertex form"), off("Standard form"), off("Vertex form"), off("Standard form")]),
          sub("Circle", [off("Center form"), off("Standard form")]),
          sub("Ellipse", [off("Center form")]),
          sub("Hyperbola", [off("East-West"), off("South-North")]),
          sub("Conic", [off("General")]),
        ]),
        app("Parametric", "entryParametric"),
        off("Polar"),
        off("Scatter Plot"),
        sub("Sequence", [off("Sequence"), off("Custom")]),
        app("Diff Eq", "entryDiffEq"),
      ]),
    ),
    sub("Window / Zoom", [
      app("Window Settings...", "windowSettings"),
      rule(app("Zoom – Box", "zoomBox")),
      app("Zoom – In", "zoomIn"),
      app("Zoom – Out", "zoomOut"),
      rule(app("Zoom – Standard", "zoomStandard")),
      app("Zoom – Quadrant 1", "zoomQuadrant1"),
      app("Zoom – User", "zoomUser"),
      app("Zoom – Trig", "zoomTrig"),
      app("Zoom – Data", "zoomData"),
      app("Zoom – Fit", "zoomFit"),
      rule(app("Zoom – Square", "zoomSquare")),
      app("Zoom – Decimal", "zoomDecimal"),
    ]),
    sub("Trace", [
      app("Graph Trace", "graphTrace"),
      off("Trace All"),
      app("Trace Step...", "traceStep"),
      sub("Path Plot", [off("Function"), off("Parametric"), off("Polar"), off("Path Setup...")]),
      off("Geometry Trace"),
      off("Erase Geometry Trace"),
    ]),
    sub("Analyze Graph", [
      app("Zero", "analyzeZero"),
      app("Minimum", "analyzeMinimum"),
      app("Maximum", "analyzeMaximum"),
      app("Intersection", "analyzeIntersection"),
      app("Inflection", "analyzeInflection"),
      app("dy/dx", "analyzeDydx"),
      app("Integral", "analyzeIntegral"),
      off("Bounded Area"),
      sub(
        "Analyze Conics",
        ["Center", "Vertices", "Foci", "Axes of Symmetry", "Directrix", "Asymptotes", "Radius", "Eccentricity", "Latus Rectum"].map(off),
      ),
    ]),
    sub("Table", [
      { ...(s.table ? off("Split-screen Table") : app("Split-screen Table", "tableSplit")), hint: "Ctrl+T" },
      { ...(s.table ? app("Remove Table", "tableSplit") : off("Remove Table")), hint: "Ctrl+T" },
    ]),
    rule(
      sub("Geometry", [
        sub("Points & Lines", [
          off("Point"),
          off("Point On"),
          off("Point by Coordinates"),
          off("Intersection Point(s)"),
          rule(off("Line")),
          off("Segment"),
          off("Ray"),
          off("Tangent"),
          off("Vector"),
          off("Circle arc"),
        ]),
        sub(
          "Shapes",
          ["Circle", "Triangle", "Rectangle", "Polygon", "Regular Polygon", "Ellipse", "Parabola", "Hyperbola", "Conic by Five Points"].map(off),
        ),
        rule(sub("Measurement", ["Length", "Area", "Slope", "Angle", "Directed Angle"].map(off))),
        sub("Construction", [
          off("Perpendicular"),
          off("Parallel"),
          off("Perpendicular Bisector"),
          off("Angle Bisector"),
          off("Midpoint"),
          rule(off("Locus")),
          off("Compass"),
          off("Measurement transfer"),
        ]),
        sub("Transformation", ["Symmetry", "Reflection", "Translation", "Rotation", "Dilation"].map(off)),
      ]),
    ),
    rule(app("Settings...", "graphSettings")),
  ];
}
