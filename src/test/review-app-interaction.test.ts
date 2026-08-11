import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewFile } from "../types.js";
import { ReviewApp } from "../ui/review-app.js";

const originalPreferencesPath = process.env.PI_CODE_DIFF_PREFERENCES_PATH;
let preferencesDir: string;

beforeEach(() => {
  preferencesDir = mkdtempSync(join(tmpdir(), "pi-code-diff-review-app-"));
  process.env.PI_CODE_DIFF_PREFERENCES_PATH = join(preferencesDir, "preferences.json");
});

afterEach(() => {
  if (originalPreferencesPath == null) delete process.env.PI_CODE_DIFF_PREFERENCES_PATH;
  else process.env.PI_CODE_DIFF_PREFERENCES_PATH = originalPreferencesPath;
  rmSync(preferencesDir, { recursive: true, force: true });
});

function makeFile(path = "src/app.ts"): ReviewFile {
  return {
    id: `${path}::working::::`,
    path,
    worktreeStatus: "modified",
    hasWorkingTreeFile: true,
    inGitDiff: true,
    inLastCommit: false,
    inAllFiles: false,
    gitDiff: {
      status: "modified",
      oldPath: path,
      newPath: path,
      displayPath: path,
      hasOriginal: true,
      hasModified: true,
    },
    lastCommit: null,
    allFiles: null,
  };
}

function createHarness(
  contents = { originalContent: "\told()  \n", modifiedContent: "\tcurrent()  \n" },
  files = [makeFile()],
  overrides: Partial<ConstructorParameters<typeof ReviewApp>[3]> = {},
  terminal: { rows?: number; columns?: number } = {},
) {
  const loadFileContents = vi.fn(async () => contents);
  const terminalWrite = vi.fn<(data: string) => void>();
  const tui = {
    terminal: { write: terminalWrite, rows: terminal.rows ?? 30, columns: terminal.columns ?? 120 },
    requestRender: vi.fn(),
    getShowHardwareCursor: vi.fn(() => false),
    setShowHardwareCursor: vi.fn(),
  };
  const theme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
  };
  const done = vi.fn();
  const app = new ReviewApp(tui as never, theme as never, done, {
    files,
    repoRoot: "/repo",
    loadFileContents,
    commentShortcuts: [],
    visibleScopes: ["git-diff"],
    notify: vi.fn(),
    ...overrides,
  });
  return { app, done, loadFileContents, terminalWrite };
}

describe("ReviewApp interaction", () => {
  it("leaves mouse reporting to tmux for native selection", async () => {
    const { app, loadFileContents, terminalWrite } = createHarness();
    await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());

    expect(terminalWrite).not.toHaveBeenCalled();
    app.dispose();
    expect(terminalWrite).not.toHaveBeenCalled();
  });

  it("starts a new grouped review on the first visible navigator file", async () => {
    const files = [makeFile("zeta/important.ts"), makeFile("alpha/first.ts")];
    const { app, loadFileContents } = createHarness(undefined, files);
    await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());

    expect((app as any).getNavigatorFiles().map((file: ReviewFile) => file.path)).toEqual([
      "alpha/first.ts",
      "zeta/important.ts",
    ]);
    expect((app as any).activeFile().path).toBe("alpha/first.ts");
    app.dispose();
  });

  it("hides unrelated locale files until the locale visibility toggle is used", async () => {
    const files = [
      makeFile("src/app.ts"),
      makeFile("config/locales/en.yml"),
      makeFile("config/locales/pt-BR.yml"),
      makeFile("config/locales/fr.yml"),
    ];
    const { app, loadFileContents } = createHarness(undefined, files);
    await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());

    expect((app as any).getNavigatorFiles().map((file: ReviewFile) => file.path)).toEqual([
      "config/locales/en.yml",
      "config/locales/pt-BR.yml",
      "src/app.ts",
    ]);

    app.handleInput("L");
    expect((app as any).getNavigatorFiles().map((file: ReviewFile) => file.path)).toEqual([
      "config/locales/en.yml",
      "config/locales/fr.yml",
      "config/locales/pt-BR.yml",
      "src/app.ts",
    ]);
    app.dispose();
  });

  it("toggles panes with number keys and restores visibility in the next review", async () => {
    const contextPanelSource = {
      title: "PR context",
      loadingText: "Loading PR context",
      load: vi.fn(async () => "Problem:\nKeep pane state"),
    };
    const first = createHarness(undefined, undefined, {
      visibleScopes: ["git-diff", "last-commit"],
      contextPanelSource,
    });
    await vi.waitFor(() => expect(first.loadFileContents).toHaveBeenCalled());

    for (const key of ["1", "2", "3", "4"]) first.app.handleInput(key);

    expect((first.app as any).state.activeScope).toBe("git-diff");
    expect((first.app as any).paneVisibility).toEqual({
      navigator: false,
      diff: false,
      comments: false,
      context: false,
    });
    expect(first.app.render(200).join("\n")).toContain("All panes are hidden");
    first.app.dispose();

    const second = createHarness(undefined, undefined, { contextPanelSource });
    await vi.waitFor(() => expect(second.loadFileContents).toHaveBeenCalled());
    expect((second.app as any).paneVisibility).toEqual({
      navigator: false,
      diff: false,
      comments: false,
      context: false,
    });

    second.app.handleInput("2");
    expect((second.app as any).state.focus).toBe("diff");
    const rendered = second.app.render(200).join("\n");
    expect(rendered).toContain("▶ Diff");
    expect((second.app as any).mousePaneLayout).toMatchObject({
      navigator: null,
      comments: null,
    });
    expect((second.app as any).mousePaneLayout.diff).not.toBeNull();
    second.app.dispose();
  });

  it("uses Alt+number for scope switching after number keys become pane toggles", async () => {
    const { app, loadFileContents } = createHarness(undefined, undefined, {
      visibleScopes: ["git-diff", "last-commit"],
    });
    await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());

    app.handleInput("1");
    expect((app as any).state.activeScope).toBe("git-diff");
    expect((app as any).paneVisibility.navigator).toBe(false);

    app.handleInput("\x1b2");
    expect((app as any).state.activeScope).toBe("last-commit");
    app.dispose();
  });

  it("expands ten hidden lines above or below the selected diff line", async () => {
    const originalLines = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`);
    const modifiedLines = [...originalLines];
    modifiedLines[19] = "changed line 20";
    const { app, loadFileContents } = createHarness({
      originalContent: `${originalLines.join("\n")}\n`,
      modifiedContent: `${modifiedLines.join("\n")}\n`,
    });
    await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());
    app.handleInput("\r");

    const fileId = (app as any).state.activeFileId;
    const before = (app as any).getDiffLayout(fileId, "git-diff").displayDiff;
    const beforeVisibleRows = before.visibleItems.filter((item: { type: string }) => item.type === "row").length;

    const selectedBeforeExpansion = structuredClone((app as any).state.selectedLineTargetByScopeFile);
    app.handleInput("j");
    expect((app as any).state.selectedLineTargetByScopeFile).toEqual(selectedBeforeExpansion);
    const entryKey = (app as any).cacheKey(fileId, "git-diff");
    expect((app as any).expandedContextRows.get(entryKey).size).toBe(10);
    const below = (app as any).getDiffLayout(fileId, "git-diff").displayDiff;
    expect(below.visibleItems.filter((item: { type: string }) => item.type === "row")).toHaveLength(beforeVisibleRows + 10);

    app.handleInput("k");
    expect((app as any).expandedContextRows.get(entryKey).size).toBe(20);
    app.dispose();
  });

  it("renders the final wrapped shortcut on short three-pane and four-pane terminals", async () => {
    const contextPanelSource = {
      title: "PR context",
      loadingText: "Loading PR context",
      load: vi.fn(async () => "Problem:\nKeep every shortcut visible"),
    };
    const scenarios = [
      { width: 80, terminal: { rows: 20, columns: 80 }, overrides: { contextPanelSource } },
      { width: 54, terminal: { rows: 20, columns: 54 }, overrides: {} },
      { width: 80, terminal: { rows: 20, columns: 80 }, overrides: { contextPanelSource, visibleScopes: ["git-diff", "last-commit"] as Array<"git-diff" | "last-commit"> } },
    ];

    for (const scenario of scenarios) {
      const { app, loadFileContents } = createHarness(undefined, undefined, scenario.overrides, scenario.terminal);
      await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());
      const rendered = app.render(scenario.width).join("\n");
      expect(rendered).toContain("Esc / Ctrl+C exit review");
      expect(rendered).not.toContain("more • ? help");
      app.dispose();
    }
  });

  it("keeps arrow navigation and Shift+arrow range extension in Diff focus", async () => {
    const { app, loadFileContents } = createHarness({
      originalContent: "",
      modifiedContent: "one\ntwo\nthree\nfour\n",
    });
    await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());
    app.handleInput("\r");

    const fileId = (app as any).state.activeFileId;
    const targetKey = `git-diff::${fileId}`;
    const initial = structuredClone((app as any).state.selectedLineTargetByScopeFile[targetKey]);
    app.handleInput("\x1b[B");
    const moved = structuredClone((app as any).state.selectedLineTargetByScopeFile[targetKey]);
    expect(moved.line).toBeGreaterThan(initial.line);

    app.handleInput("\x1b[b");
    const extended = (app as any).state.selectedLineTargetByScopeFile[targetKey];
    expect(extended.line).toBeGreaterThan(moved.line);
    expect(extended.endLine).toBe(moved.line);
    app.dispose();
  });

  it("does not shift the entire viewport on every downward arrow move after crossing its edge", async () => {
    const modifiedContent = Array.from({ length: 80 }, (_, index) => `line ${index + 1}`).join("\n") + "\n";
    const { app, loadFileContents } = createHarness({ originalContent: "", modifiedContent });
    await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());

    app.render(120);
    app.handleInput("\r");
    const movesPastViewport = (app as any).diffPageSize + 4;
    for (let index = 0; index < movesPastViewport; index += 1) {
      app.handleInput("\x1b[B");
      app.render(120);
    }
    const recenteredScroll = (app as any).diffScroll;

    app.handleInput("\x1b[B");
    app.render(120);

    expect(recenteredScroll).toBeGreaterThan(1);
    expect((app as any).diffScroll).toBe(recenteredScroll);
    app.dispose();
  });

  it("does not rescan offscreen row heights while typing a comment", async () => {
    const modifiedContent = Array.from({ length: 2_000 }, (_, index) => `line ${index + 1}`).join("\n") + "\n";
    const { app, loadFileContents } = createHarness({ originalContent: "", modifiedContent });
    await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());

    (app as any).diffViewMode = "unified";
    app.render(120);
    app.handleInput("\r");
    app.handleInput("c");
    expect((app as any).editTarget?.intent).toBe("comment");

    const layout = (app as any).getDiffLayout((app as any).state.activeFileId, "git-diff");
    const [heightKey, rowHeights] = [...layout.unifiedRowHeights.entries()][0] as [string, number[]];
    layout.unifiedRowHeights.set(heightKey, new Proxy(rowHeights, {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property) && Number(property) > 500) {
          throw new Error("read offscreen row height");
        }
        return Reflect.get(target, property, receiver);
      },
    }));

    app.handleInput("x");
    expect(() => app.render(120)).not.toThrow();
    app.dispose();
  });

  it("does not rescan all side-by-side line targets while typing a comment", async () => {
    const modifiedContent = Array.from({ length: 2_000 }, (_, index) => `line ${index + 1}`).join("\n") + "\n";
    const { app, loadFileContents } = createHarness({ originalContent: "", modifiedContent });
    await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());

    (app as any).diffViewMode = "side-by-side";
    app.render(120);
    app.handleInput("\r");
    app.handleInput("c");
    const layout = (app as any).getDiffLayout((app as any).state.activeFileId, "git-diff");
    layout.sideBySideRows = new Proxy(layout.sideBySideRows, {
      get(target, property, receiver) {
        if (property === Symbol.iterator) throw new Error("iterated all side-by-side rows");
        return Reflect.get(target, property, receiver);
      },
    });

    app.handleInput("x");
    expect(() => app.render(120)).not.toThrow();
    app.dispose();
  });

  it("does not persist unchanged session data while typing a comment", async () => {
    const { app, loadFileContents } = createHarness();
    await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());

    app.handleInput("\r");
    app.handleInput("c");
    const onSessionChange = vi.fn();
    (app as any).options.onSessionChange = onSessionChange;
    vi.useFakeTimers();

    try {
      app.handleInput("a");
      vi.advanceTimersByTime(150);
      app.handleInput("b");
      vi.advanceTimersByTime(150);
      expect(onSessionChange).not.toHaveBeenCalled();

      app.handleInput("\r");
      vi.advanceTimersByTime(100);
      expect(onSessionChange).toHaveBeenCalledTimes(1);
    } finally {
      app.dispose();
      vi.useRealTimers();
    }
  });

  it("removes only the selected comment with r from the comments panel", async () => {
    const { app, loadFileContents } = createHarness();
    await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());
    const fileId = "src/app.ts::working::::";
    (app as any).state = {
      ...(app as any).state,
      focus: "comments",
      selectedCommentIndex: 1,
      draft: {
        allComment: "Keep the review-wide note",
        allIntent: "discuss",
        comments: [
          {
            id: "line:git-diff:src/app.ts:added:1",
            fileId,
            scope: "git-diff",
            side: "added",
            intent: "comment",
            startLine: 1,
            endLine: 1,
            body: "Remove this selected comment",
          },
          {
            id: "line:git-diff:src/app.ts:added:2",
            fileId,
            scope: "git-diff",
            side: "added",
            intent: "discuss",
            startLine: 2,
            endLine: 2,
            body: "Keep this other comment",
          },
        ],
      },
    };

    app.handleInput("r");

    expect((app as any).state.draft.allComment).toBe("Keep the review-wide note");
    expect((app as any).state.draft.comments.map((comment: { body: string }) => comment.body)).toEqual([
      "Keep this other comment",
    ]);
    const rendered = app.render(120).join("\n");
    expect(rendered).toContain("Keep this other comment");
    expect(rendered).not.toContain("Remove this selected comment");
    app.dispose();
  });

  it("flushes the current review session before submitting", async () => {
    const { app, done, loadFileContents } = createHarness();
    await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());
    const onSessionChange = vi.fn();
    (app as any).options.onSessionChange = onSessionChange;
    (app as any).state = {
      ...(app as any).state,
      draft: {
        allComment: "",
        allIntent: "discuss",
        comments: [{
          id: "line:git-diff:src/app.ts:added:1",
          fileId: "src/app.ts::working::::",
          scope: "git-diff",
          side: "added",
          intent: "discuss",
          startLine: 1,
          endLine: 1,
          body: "Why is this needed?",
        }],
      },
    };

    app.handleInput("s");

    expect(onSessionChange).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledWith(expect.objectContaining({ type: "submit" }));
    expect(onSessionChange.mock.invocationCallOrder[0]).toBeLessThan(done.mock.invocationCallOrder[0]!);
    app.dispose();
  });

  it("opens highlighted MODIFY input with Enter, pastes exactly, saves, and cancels", async () => {
    const { app, loadFileContents } = createHarness();
    await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());

    app.handleInput("\r");
    app.handleInput("\r");
    expect((app as any).editTarget?.intent).toBe("modify");
    expect((app as any).exactEditor.isSelectionArmed()).toBe(true);

    app.handleInput("\u001b[200~\treplacement()  \r\n  child()  \u001b[201~");
    app.handleInput("\r");
    expect((app as any).state.draft.comments[0]?.body).toBe("\treplacement()  \r\n  child()  ");
    expect((app as any).editTarget).toBeNull();

    app.handleInput("\r");
    expect((app as any).editTarget?.intent).toBe("modify");
    app.handleInput("\u001b");
    expect((app as any).editTarget).toBeNull();
    expect((app as any).state.draft.comments).toHaveLength(1);

    app.handleInput("/");
    app.handleInput("\u001b[200~replacement child\u001b[201~");
    expect((app as any).searchBuffer).toBe("replacement child");
    app.dispose();
  });
});
