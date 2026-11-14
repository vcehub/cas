// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 VCE Hub. Part of the /cas calculator: https://github.com/vcehub/cas
import { app, off, sub, type Menu } from "./types";

/** Ctrl+I's list of apps; only the two built here can be added. */
export const ADD_PAGE: Menu = [
  app("Add Calculator", "addCalculator"),
  app("Add Graphs", "addGraphs"),
  off("Add Geometry"),
  off("Add Lists & Spreadsheet"),
  off("Add Data & Statistics"),
  off("Add Notes"),
  off("Add Vernier DataQuest"),
  off("Add Python"),
];

/** The doc key's menu: Insert (a problem or a page) and Settings are built here. */
export const DOC_MENU: Menu = [
  off("File"),
  off("Edit"),
  off("View"),
  sub("Insert", [app("Problem", "insertProblem"), app("Calculator", "addCalculator"), app("Graphs", "addGraphs")]),
  off("Problem"),
  off("Page Layout"),
  sub("Settings", [app("Document Settings...", "docSettings")]),
];
