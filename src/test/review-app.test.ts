import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { buildStructuredDiff } from "../diff.js";
import type { DiffReviewComment, ReviewFile, ReviewState } from "../types.js";
import { buildCommentPanelEmptyStateLines, buildCommentPanelTextLines, buildDiffActionHintLine, buildDisplayRows, buildEditorLaunchCommand, buildFooterLines, buildHelpPanelLines, buildSideBySideDisplayRows, diffTextMatchesSearch, formatFocusStatus, formatPaneTitle, formatSelectedLineTargetLabel, getCancelAction, getDraftCommentCount, getEditorLineForTarget, getHalfPageStep, getMatchingDiffLineTargets, getNavigatorMoveIndex, getNextSearchIndex, getPaneLayout, getRelatedFileMarker, getRelatedFilePanelSections, getRelatedFilePaths, getSideBySideColumnTarget, getSideBySideLineTargets, getSideBySidePairedLineTarget, getStackedPaneLayout, parseMouseWheelInput, renderCenteredOverlay, shouldStackPanes } from "../ui/review-app.js";

function makeFile(path: string, flags?: Partial<ReviewFile>): ReviewFile {
  return {
    id: path,
    path,
    worktreeStatus: null,
    hasWorkingTreeFile: true,
    inGitDiff: false,
    inLastCommit: false,
    inAllFiles: true,
    gitDiff: null,
    lastCommit: null,
    allFiles: null,
    ...flags,
  };
}

function makeState(draft?: Partial<ReviewState["draft"]>): ReviewState {
  return {
    activeScope: "git-diff",
    activeFileId: "src/app.ts",
    searchQuery: "",
    focus: "diff",
    wrapLines: false,
    hideUnchanged: false,
    selectedCommentIndex: 0,
    selectedLineTargetByScopeFile: {},
    draft: {
      allComment: "",
      allIntent: "discuss",
      comments: [],
      ...draft,
    },
  };
}

const lineComment: DiffReviewComment = {
  id: "line:git-diff:src/app.ts:added:2",
  fileId: "src/app.ts",
  scope: "git-diff",
  side: "added",
  intent: "comment",
  startLine: 2,
  endLine: 2,
  body: "Rename this.",
};

describe("buildDisplayRows", () => {
  it("keeps deleted and added rows independently commentable when line numbers overlap", () => {
    const diff = buildStructuredDiff(
      ["alpha", "removed", "kept"].join("\n") + "\n",
      ["alpha", "kept"].join("\n") + "\n",
      3,
    );

    const rowsAtLineTwo = buildDisplayRows(diff).filter((row) => row.displayLineNumber === 2);

    expect(rowsAtLineTwo).toHaveLength(2);
    expect(rowsAtLineTwo.map((row) => ({ kind: row.kind, commentLineNumber: row.commentLineNumber, commentSide: row.commentSide }))).toEqual([
      { kind: "removed", commentLineNumber: 2, commentSide: "deleted" },
      { kind: "context", commentLineNumber: 2, commentSide: "added" },
    ]);
  });
});

describe("side-by-side diff helpers", () => {
  it("pairs replacement rows into old and new cells", () => {
    const diff = buildStructuredDiff(
      ["alpha", "old value", "omega"].join("\n") + "\n",
      ["alpha", "new value", "omega"].join("\n") + "\n",
      3,
    );

    const rows = buildSideBySideDisplayRows(diff);
    const replacement = rows.find((row) => row.kind === "change" && row.oldCell?.text === "old value");

    expect(replacement?.oldCell).toMatchObject({ side: "deleted", lineNumber: 2, text: "old value" });
    expect(replacement?.newCell).toMatchObject({ side: "added", lineNumber: 2, text: "new value" });
  });

  it("builds per-side navigation targets for side-by-side movement", () => {
    const diff = buildStructuredDiff(
      ["alpha", "old value", "removed", "omega"].join("\n") + "\n",
      ["alpha", "new value", "added", "omega"].join("\n") + "\n",
      3,
    );

    const rows = buildSideBySideDisplayRows(diff);

    expect(getSideBySideLineTargets(rows, "deleted")).toEqual([
      { side: "deleted", line: 1 },
      { side: "deleted", line: 2 },
      { side: "deleted", line: 3 },
      { side: "deleted", line: 4 },
    ]);
    expect(getSideBySideLineTargets(rows, "added")).toEqual([
      { side: "added", line: 1 },
      { side: "added", line: 2 },
      { side: "added", line: 3 },
      { side: "added", line: 4 },
    ]);
  });

  it("finds the paired side for side-by-side selections", () => {
    const diff = buildStructuredDiff(
      ["alpha", "old value", "omega"].join("\n") + "\n",
      ["alpha", "new value", "omega"].join("\n") + "\n",
      3,
    );

    expect(getSideBySidePairedLineTarget(diff, { side: "deleted", line: 1 })).toEqual({ side: "added", line: 1 });
    expect(getSideBySidePairedLineTarget(diff, { side: "added", line: 1 })).toEqual({ side: "deleted", line: 1 });
    expect(getSideBySidePairedLineTarget(diff, { side: "deleted", line: 2 })).toEqual({ side: "added", line: 2 });
    expect(getSideBySidePairedLineTarget(diff, { side: "added", line: 2 })).toEqual({ side: "deleted", line: 2 });
  });

  it("jumps to the previous available target-side line when crossing out of an insertion block", () => {
    const diff = buildStructuredDiff(
      ["same", "after"].join("\n") + "\n",
      ["same", "inserted a", "inserted b", "after"].join("\n") + "\n",
      3,
    );

    const rows = buildSideBySideDisplayRows(diff);

    expect(getSideBySideColumnTarget(rows, { side: "added", line: 3 }, "deleted")).toEqual({ side: "deleted", line: 1 });
  });

  it("describes the selected side and range", () => {
    expect(formatSelectedLineTargetLabel({ side: "deleted", line: 4 })).toBe("selected deleted line 4");
    expect(formatSelectedLineTargetLabel({ side: "added", line: 8, endLine: 10 })).toBe("selected added lines 8-10");
  });
});

describe("getEditorLineForTarget", () => {
  it("maps deleted lines to the nearest surviving working-tree line", () => {
    const diff = buildStructuredDiff(
      ["alpha", "removed", "kept"].join("\n") + "\n",
      ["alpha", "kept"].join("\n") + "\n",
      3,
    );

    expect(getEditorLineForTarget(diff, { side: "deleted", line: 2 })).toBe(2);
  });
});

describe("getHalfPageStep", () => {
  it("uses at least one row and otherwise half the visible rows", () => {
    expect(getHalfPageStep(1)).toBe(1);
    expect(getHalfPageStep(9)).toBe(4);
    expect(getHalfPageStep(10)).toBe(5);
  });
});

describe("search and navigator movement helpers", () => {
  it("finds matching diff line targets by code text", () => {
    const diff = buildStructuredDiff(
      ["alpha", "old value", "omega"].join("\n") + "\n",
      ["alpha", "new value", "omega"].join("\n") + "\n",
      3,
    );

    expect(getMatchingDiffLineTargets(buildDisplayRows(diff), "new value")).toEqual([{ side: "added", line: 2 }]);
    expect(getMatchingDiffLineTargets(buildDisplayRows(diff), "old value")).toEqual([{ side: "deleted", line: 2 }]);
  });

  it("matches diff search text case-insensitively for highlighting", () => {
    expect(diffTextMatchesSearch("const UserName = name", "username")).toBe(true);
    expect(diffTextMatchesSearch("const UserName = name", "missing")).toBe(false);
    expect(diffTextMatchesSearch("const UserName = name", "   ")).toBe(false);
  });

  it("wraps search result indexes for n and N", () => {
    expect(getNextSearchIndex(-1, 3, 1)).toBe(0);
    expect(getNextSearchIndex(-1, 3, -1)).toBe(2);
    expect(getNextSearchIndex(2, 3, 1)).toBe(0);
    expect(getNextSearchIndex(0, 3, -1)).toBe(2);
  });

  it("wraps single-step navigator movement and clamps page jumps", () => {
    expect(getNavigatorMoveIndex(0, 3, -1)).toBe(2);
    expect(getNavigatorMoveIndex(2, 3, 1)).toBe(0);
    expect(getNavigatorMoveIndex(0, 3, 99)).toBe(2);
    expect(getNavigatorMoveIndex(2, 3, -99)).toBe(0);
  });
});

describe("pane layout", () => {
  it("gives the diff pane the comments width when comments are hidden", () => {
    const shown = getPaneLayout(100, false);
    const hidden = getPaneLayout(100, true);

    expect(hidden.commentsWidth).toBe(0);
    expect(hidden.navigatorWidth).toBe(shown.navigatorWidth);
    expect(hidden.diffWidth).toBeGreaterThan(shown.diffWidth);
  });

  it("keeps navigator and comments panes the same width", () => {
    const shown = getPaneLayout(120, false);

    expect(shown.navigatorWidth).toBe(shown.commentsWidth);
  });

  it("stacks panes below the desktop width breakpoint", () => {
    expect(shouldStackPanes(99)).toBe(true);
    expect(shouldStackPanes(100)).toBe(false);
  });

  it("allocates stacked pane heights with more room for the diff", () => {
    expect(getStackedPaneLayout(11, false)).toEqual({
      navigatorHeight: 3,
      diffHeight: 5,
      commentsHeight: 3,
    });

    expect(getStackedPaneLayout(9, true)).toEqual({
      navigatorHeight: 3,
      diffHeight: 6,
      commentsHeight: 0,
    });
  });
});

describe("related navigator helpers", () => {
  it("marks incoming, outgoing, and bidirectional related files", () => {
    const active = makeFile("src/active.ts", {
      allFilesOutgoingReferences: ["src/out.ts", "src/both.ts"],
      allFilesIncomingReferences: ["src/in.ts", "src/both.ts"],
    });

    expect(getRelatedFileMarker(makeFile("src/out.ts"), active, "all-files")).toBe("→");
    expect(getRelatedFileMarker(makeFile("src/in.ts"), active, "all-files")).toBe("←");
    expect(getRelatedFileMarker(makeFile("src/both.ts"), active, "all-files")).toBe("↔");
    expect(getRelatedFileMarker(makeFile("src/other.ts"), active, "all-files")).toBeNull();
  });

  it("combines incoming and outgoing related file paths", () => {
    const active = makeFile("src/active.ts", {
      allFilesOutgoingReferences: ["src/out.ts", "src/both.ts"],
      allFilesIncomingReferences: ["src/in.ts", "src/both.ts"],
    });

    expect([...getRelatedFilePaths(active)].sort()).toEqual(["src/both.ts", "src/in.ts", "src/out.ts"]);
  });

  it("builds right-panel sections for all-files related context", () => {
    const active = makeFile("src/active.ts", {
      allFilesOutgoingReferences: ["src/out.ts", "src/both.ts"],
      allFilesIncomingReferences: ["src/in.ts", "src/both.ts"],
    });

    expect(getRelatedFilePanelSections(active, "all-files")).toEqual([
      { title: "Imports changed files", paths: ["src/both.ts", "src/out.ts"] },
      { title: "Imported by changed files", paths: ["src/both.ts", "src/in.ts"] },
    ]);
  });

  it("hides related right-panel sections outside all-files scope", () => {
    const active = makeFile("src/active.ts", {
      allFilesOutgoingReferences: ["src/out.ts"],
      allFilesIncomingReferences: ["src/in.ts"],
    });

    expect(getRelatedFilePanelSections(active, "git-diff")).toEqual([]);
  });
});

describe("parseMouseWheelInput", () => {
  it("parses SGR mouse wheel events", () => {
    expect(parseMouseWheelInput("\x1b[<64;10;5M")).toEqual({ direction: "up", col: 10, row: 5 });
    expect(parseMouseWheelInput("\x1b[<65;10;5M")).toEqual({ direction: "down", col: 10, row: 5 });
  });

  it("ignores non-wheel mouse events", () => {
    expect(parseMouseWheelInput("\x1b[<0;10;5M")).toBeNull();
  });
});

describe("cancel helpers", () => {
  it("counts scoped comments and the review-wide note", () => {
    expect(getDraftCommentCount(makeState())).toBe(0);
    expect(getDraftCommentCount(makeState({ comments: [lineComment] }))).toBe(1);
    expect(getDraftCommentCount(makeState({ allComment: "Explain the diff.", comments: [lineComment] }))).toBe(2);
  });

  it("confirms cancellation when draft feedback exists", () => {
    expect(getCancelAction(makeState())).toBe("cancel");
    expect(getCancelAction(makeState({ comments: [lineComment] }))).toBe("confirm");
  });
});

describe("renderCenteredOverlay", () => {
  it("draws a centered overlay without replacing the background outside the popup", () => {
    const base = [
      ".......",
      ".......",
      ".......",
      ".......",
      ".......",
      ".......",
      ".......",
    ];
    const overlay = [
      "+-+",
      "|x|",
      "+-+",
    ];

    expect(renderCenteredOverlay(base, overlay, 7, 7)).toEqual([
      ".......",
      ".......",
      "..+-+..",
      "..|x|..",
      "..+-+..",
      ".......",
      ".......",
    ]);
  });
});

describe("buildEditorLaunchCommand", () => {
  it("opens the requested file and line with shell-safe quoting", () => {
    expect(buildEditorLaunchCommand("nvim", "/tmp/a b's.ts", 12)).toBe("nvim +12 -- '/tmp/a b'\\''s.ts'");
  });

  it("falls back to vi and clamps invalid line numbers", () => {
    expect(buildEditorLaunchCommand(" ", "/tmp/file.ts", 0)).toBe("vi +1 -- '/tmp/file.ts'");
  });
});

const plainTheme = {
  fg(_color: string, text: string) { return text; },
  bg(_color: string, text: string) { return text; },
};

describe("focused panel feedback", () => {
  it("marks the active panel title explicitly", () => {
    expect(formatPaneTitle("Navigator", true)).toBe("▶ Navigator");
    expect(formatPaneTitle("Diff (2 hunks)", true)).toBe("▶ Diff (2 hunks)");
    expect(formatPaneTitle("Comments", false)).toBe("Comments");
  });

  it("describes the current focus in the status footer", () => {
    expect(formatFocusStatus("navigator")).toBe("Focus: Navigator");
    expect(formatFocusStatus("diff")).toBe("Focus: Diff");
    expect(formatFocusStatus("comments")).toBe("Focus: Comments");
  });
});

describe("action and shortcut help rendering", () => {
  it("keeps the persistent footer concise and panel-scoped", () => {
    const lines = buildFooterLines(plainTheme as any, "Tab focus • / search • ? help • 1/2/3 scopes • h hide comments • o open in $EDITOR • s submit • Esc exit", 80);

    expect(lines).toHaveLength(2);
    expect(lines[1]).not.toContain("navigator:");
    expect(lines[1]).not.toContain("diff:");
    expect(lines[1]).not.toContain("comments:");
    expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);
  });

  it("wraps full help text to the comments sidebar width", () => {
    const lines = buildHelpPanelLines(plainTheme as any, 24, [
      { id: "explain-added", key: "e", label: "explain", intent: "discuss", side: "added", text: "Explain what this code is doing." },
    ], "/home/user/.pi/agent/extensions/code-diff.json");

    expect(lines).toContain("Navigation");
    expect(lines).toContain("Diff actions");
    expect(lines.some((line) => line.includes("navigator: ↑↓/j/k files") && line.includes("diff:"))).toBe(false);
    expect(lines.every((line) => visibleWidth(line) <= 22)).toBe(true);
  });

  it("wraps comments-panel guidance to the comments width", () => {
    const lines = buildCommentPanelEmptyStateLines(plainTheme as any, 24);

    expect(lines.join(" ")).toContain("m modify");
    expect(lines.length).toBeGreaterThan(2);
    expect(lines.every((line) => visibleWidth(line) <= 22)).toBe(true);
  });

  it("accounts for comment preview indentation when wrapping", () => {
    const lines = buildCommentPanelTextLines(plainTheme as any, 24, "This preview wraps within the comments panel content area.", "muted", "   ", 3);

    expect(lines.length).toBe(3);
    expect(lines.every((line) => line.startsWith("   "))).toBe(true);
    expect(lines.every((line) => visibleWidth(line) <= 22)).toBe(true);
  });

  it("shows line action keys in the diff pane hint", () => {
    const hint = buildDiffActionHintLine(plainTheme as any, 120);

    for (const token of ["Enter/m", "modify", "c", "comment", "d", "discuss", "l", "file", "a", "all", "w", "wrap"]) {
      expect(hint).toContain(token);
    }
  });
});
