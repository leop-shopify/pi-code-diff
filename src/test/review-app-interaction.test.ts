import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewFile, ReviewReplyItem, ReviewRepliesSnapshot } from "../types.js";
import { getHalfPageStep, ReviewApp } from "../ui/review-app.js";

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

  it("orders the navigator by review risk and toggles to alphabetical with O", async () => {
    const sized = (path: string, additions: number): ReviewFile => {
      const file = makeFile(path);
      return { ...file, gitDiff: { ...file.gitDiff!, additions, deletions: 0 } };
    };
    const files = [sized("src/aaa.ts", 1), sized("src/zzz.ts", 400), sized("src/mmm.ts", 30)];
    const { app, loadFileContents } = createHarness(undefined, files, {
      orderSignals: { priorityPaths: ["src/mmm.ts"], unresolvedThreadsByPath: {} },
    });
    await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());

    expect((app as any).getNavigatorFiles().map((file: ReviewFile) => file.path)).toEqual([
      "src/mmm.ts",
      "src/zzz.ts",
      "src/aaa.ts",
    ]);
    expect(app.render(220).join("\n")).toContain("risk order");

    app.handleInput("O");

    expect((app as any).getNavigatorFiles().map((file: ReviewFile) => file.path)).toEqual([
      "src/aaa.ts",
      "src/mmm.ts",
      "src/zzz.ts",
    ]);
    expect(app.render(220).join("\n")).toContain("a-z order");
    expect(JSON.parse(readFileSync(process.env.PI_CODE_DIFF_PREFERENCES_PATH!, "utf8")).navigatorFileOrder).toBe("alphabetical");
    app.dispose();
  });

  it("keeps the pull request header visible while reviewing", async () => {
    const { app, loadFileContents } = createHarness(undefined, [makeFile()], {
      reviewHeader: {
        identity: "example/widgets#1",
        title: "Add review mode",
        state: "OPEN",
        revision: "c".repeat(40),
        queue: { position: 2, total: 4 },
        openThreads: 1,
        awaitingReply: 1,
      },
    });
    await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());

    const rendered = app.render(160).join("\n");

    expect(rendered).toContain("example/widgets#1");
    expect(rendered).toContain("queue 2/4");
    expect(rendered).toContain("@ccccccc");
    expect(rendered).toContain("0/1 reviewed");
    expect(rendered).toContain("1 open thread, 1 awaiting reply");
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
      replies: true,
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
      replies: true,
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
      expect(rendered).toContain("Esc / Ctrl+C exit");
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

  function createExitHarness() {
    const onSessionChange = vi.fn();
    return createHarness(undefined, [makeFile()], {
      onSessionChange,
      seedComments: [{ fileId: makeFile().id, scope: "git-diff", side: "file", intent: "comment", startLine: null, endLine: null, body: "Saved draft note." }],
    } as never);
  }

  it("parks a draft review on exit instead of dropping it", async () => {
    const { app, done, loadFileContents } = createExitHarness();
    await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());

    app.handleInput("\u001b");
    expect(done).not.toHaveBeenCalled();
    expect((app as any).renderCancelConfirmation().join("\n")).toContain("p park review and exit");

    app.handleInput("p");
    expect(done).toHaveBeenCalledWith({ type: "cancel", disposition: "park" });
    app.dispose();
  });

  it("discards a draft review only on the explicit discard key", async () => {
    const { app, done, loadFileContents } = createExitHarness();
    await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());

    app.handleInput("\u001b");
    app.handleInput("\r");
    expect(done).not.toHaveBeenCalled();

    app.handleInput("\u001b");
    app.handleInput("d");
    expect(done).toHaveBeenCalledWith({ type: "cancel", disposition: "discard" });
    app.dispose();
  });

  it("confirms before leaving when only reviewed-file state would be lost", async () => {
    const { app, done, loadFileContents } = createHarness();
    await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());

    app.handleInput("R");
    app.handleInput("\u001b");
    expect(done).not.toHaveBeenCalled();

    app.handleInput("p");
    expect(done).toHaveBeenCalledWith({ type: "cancel", disposition: "park" });
    app.dispose();
  });
});

describe("Replies pane", () => {
  function makeReply(index: number, overrides: Partial<ReviewReplyItem> = {}): ReviewReplyItem {
    return {
      id: `thread-${index}:comment-${index}`,
      threadId: `thread-${index}`,
      commentId: `comment-${index}`,
      author: `reviewer-${index}`,
      body: `Reply body ${index}`,
      url: `https://github.com/example/widgets/pull/12#discussion_r${index}`,
      path: `src/file-${index}.ts`,
      line: index + 1,
      resolved: index % 2 === 0,
      ...overrides,
    };
  }

  function makeRepliesSnapshot(count = 8, overrides: Partial<ReviewReplyItem> = {}): ReviewRepliesSnapshot {
    return {
      replies: Array.from({ length: count }, (_, index) => makeReply(index, index === 0 ? overrides : {})),
      selfLogin: "author",
      fetchedAt: "2026-01-01T00:00:00.000Z",
    };
  }

  function focusReplies(app: ReviewApp): void {
    app.handleInput("\t");
    app.handleInput("\t");
    app.handleInput("\t");
    expect((app as any).state.focus).toBe("replies");
  }

  async function createRepliesHarness(
    snapshot = makeRepliesSnapshot(),
    overrides: { analyze?: (reply: ReviewReplyItem) => Promise<string>; openUrl?: (url: string) => Promise<any> } = {},
  ) {
    const load = vi.fn(async () => snapshot);
    const analyze = vi.fn(overrides.analyze ?? (async (reply: ReviewReplyItem) => `Analysis for ${reply.id}`));
    const harness = createHarness(undefined, undefined, {
      repliesSource: { title: "Replies", loadingText: "Loading replies", load, analyze },
      openUrl: overrides.openUrl,
    }, { rows: 30, columns: 200 });
    harness.app.render(200);
    await vi.waitFor(() => expect((harness.app as any).repliesPanelState.status).toBe("ready"));
    harness.app.render(200);
    return { ...harness, load, analyze };
  }

  it("loads only while visible and renders sanitized reply details", async () => {
    const load = vi.fn(async () => makeRepliesSnapshot(1, {
      author: "reviewer\x1b[31m",
      body: "Please revisit\x07 this line.",
      path: "src/app\x1b[2J.ts",
      resolved: true,
    }));
    const { app, loadFileContents } = createHarness(undefined, undefined, {
      repliesSource: { title: "Replies", loadingText: "Loading replies", load },
    }, { rows: 30, columns: 200 });
    await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());

    app.handleInput("5");
    app.render(200);
    expect(load).not.toHaveBeenCalled();

    app.handleInput("5");
    expect(load).toHaveBeenCalledTimes(1);
    expect(app.render(200).join("\n")).toContain("Loading replies");
    await vi.waitFor(() => expect((app as any).repliesPanelState.status).toBe("ready"));

    const rendered = app.render(200).join("\n");
    expect(rendered).toContain("reviewer\\x1b[31m");
    expect(rendered).toContain("Please revisit\\x07 this line.");
    expect(rendered).toContain("src/app\\x1b[2J.ts:1");
    expect(rendered).toContain("resolved");
    expect(rendered).not.toContain("\x1b[31m");
    app.dispose();
  });

  it("renders load errors and the empty state", async () => {
    const failing = createHarness(undefined, undefined, {
      repliesSource: {
        title: "Replies",
        loadingText: "Loading replies",
        load: vi.fn(async () => { throw new Error("provider\x1b failed"); }),
      },
    }, { rows: 30, columns: 200 });
    failing.app.render(200);
    await vi.waitFor(() => expect((failing.app as any).repliesPanelState.status).toBe("error"));
    expect(failing.app.render(200).join("\n")).toContain("Could not load replies.");
    expect(failing.app.render(200).join("\n")).toContain("provider\\x1b failed");
    failing.app.dispose();

    const empty = await createRepliesHarness(makeRepliesSnapshot(0));
    const rendered = empty.app.render(200).join("\n");
    expect(rendered).toContain("0 replies");
    expect(rendered).toContain("No replies to review.");
    empty.app.dispose();
  });

  it("selects, pages, and clamps replies with every supported navigation key", async () => {
    const { app } = await createRepliesHarness(makeRepliesSnapshot(12));
    focusReplies(app);
    const pageSize = (app as any).repliesPageSize;
    expect(pageSize).toBeGreaterThan(1);

    app.handleInput("\x1b[B");
    app.handleInput("j");
    expect((app as any).selectedReplyIndex).toBe(2);
    app.handleInput("\x1b[A");
    app.handleInput("k");
    expect((app as any).selectedReplyIndex).toBe(0);

    app.handleInput("\x04");
    expect((app as any).selectedReplyIndex).toBe(getHalfPageStep(pageSize));
    app.handleInput("\x15");
    expect((app as any).selectedReplyIndex).toBe(0);

    app.handleInput("\x1b[6~");
    expect((app as any).selectedReplyIndex).toBe(pageSize);
    app.render(200);
    expect((app as any).repliesScroll).toBeGreaterThan(0);
    app.handleInput("\x1b[5~");
    expect((app as any).selectedReplyIndex).toBe(0);

    app.handleInput("\x06");
    expect((app as any).selectedReplyIndex).toBe(pageSize);
    app.handleInput("\x02");
    expect((app as any).selectedReplyIndex).toBe(0);

    app.handleInput("G");
    expect((app as any).selectedReplyIndex).toBe(11);
    app.handleInput("\x1b[B");
    expect((app as any).selectedReplyIndex).toBe(11);
    app.handleInput("g");
    app.handleInput("g");
    expect((app as any).selectedReplyIndex).toBe(0);
    app.handleInput("\x1b[A");
    expect((app as any).selectedReplyIndex).toBe(0);
    app.dispose();
  });

  it("opens, refreshes, and explicitly analyzes the selected reply", async () => {
    const openUrl = vi.fn(async (url: string) => ({ status: "opened" as const, url }));
    let rejectAnalysis: ((error: Error) => void) | undefined;
    const analyze = vi.fn((_reply: ReviewReplyItem) => new Promise<string>((_resolve, reject) => {
      rejectAnalysis = reject;
    }));
    const snapshot = makeRepliesSnapshot(3);
    snapshot.replies[1] = { ...snapshot.replies[1]!, body: "Long reply body ".repeat(100) };
    const harness = await createRepliesHarness(snapshot, { analyze, openUrl });
    focusReplies(harness.app);
    harness.app.handleInput("j");

    harness.app.handleInput("\r");
    const selectedUrl = makeReply(1).url!;
    await vi.waitFor(() => expect(openUrl).toHaveBeenCalledWith(selectedUrl));
    expect((harness.app as any).message).toBe(`Opened ${selectedUrl} in your browser.`);

    harness.app.handleInput("A");
    expect(analyze).toHaveBeenCalledWith(expect.objectContaining({ id: "thread-1:comment-1" }));
    expect(harness.app.render(200).join("\n")).toContain("Analyzing reply…");
    rejectAnalysis!(new Error("analysis\x1b failed"));
    await vi.waitFor(() => expect((harness.app as any).replyAnalysis.status).toBe("error"));
    expect(harness.app.render(200).join("\n")).toContain("Analysis failed: analysis\\x1b failed");

    analyze.mockResolvedValueOnce("Read-only result\x1b[2J");
    harness.app.handleInput("A");
    await vi.waitFor(() => expect((harness.app as any).replyAnalysis.status).toBe("ready"));
    expect(harness.app.render(200).join("\n")).toContain("Analysis: Read-only result\\x1b[2J");

    harness.app.handleInput("r");
    expect(harness.load).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect((harness.app as any).repliesPanelState.status).toBe("ready"));
    expect((harness.app as any).replyAnalysis.status).toBe("idle");
    harness.app.dispose();
  });

  it("does not route Replies keys into search, comments, or diff actions", async () => {
    const { app, analyze } = await createRepliesHarness(makeRepliesSnapshot(3));
    focusReplies(app);
    const beforeState = structuredClone((app as any).state);
    const beforeView = (app as any).diffViewMode;

    for (const input of ["/", "n", "N", "p", "a", "w", "v"]) app.handleInput(input);

    expect((app as any).searchMode).toBe(false);
    expect((app as any).message).toBe("Search is not available in the Replies pane.");
    expect((app as any).state).toEqual(beforeState);
    expect((app as any).diffViewMode).toBe(beforeView);
    expect((app as any).editTarget).toBeNull();
    expect(analyze).not.toHaveBeenCalled();
    app.dispose();
  });

  it("focuses and selects Replies with the mouse wheel, and toggles Pane 5", async () => {
    const { app } = await createRepliesHarness(makeRepliesSnapshot(3));
    const bounds = (app as any).mousePaneLayout.replies;
    expect(bounds).not.toBeNull();

    app.handleInput(`\u001b[<65;${bounds.left + 2};${bounds.top + 2}M`);
    expect((app as any).state.focus).toBe("replies");
    expect((app as any).selectedReplyIndex).toBe(1);

    app.handleInput(`\u001b[<64;${bounds.left + 2};${bounds.top + 2}M`);
    expect((app as any).selectedReplyIndex).toBe(0);

    app.handleInput("5");
    expect((app as any).paneVisibility.replies).toBe(false);
    expect((app as any).state.focus).not.toBe("replies");
    app.handleInput("5");
    expect((app as any).paneVisibility.replies).toBe(true);
    app.dispose();
  });
});

describe("PR context pane", () => {
  const contextText = Array.from({ length: 80 }, (_, index) => `context line ${index + 1}`).join("\n");
  const prUrl = "https://github.com/example/widgets/pull/12";

  async function createContextHarness(overrides: Record<string, unknown> = {}, text = contextText) {
    const load = vi.fn(async () => text);
    const harness = createHarness(
      undefined,
      undefined,
      { contextPanelSource: { title: "PR context", loadingText: "Loading PR context", url: prUrl, load }, ...overrides } as never,
      { rows: 30, columns: 200 },
    );
    await vi.waitFor(() => expect(harness.loadFileContents).toHaveBeenCalled());
    await vi.waitFor(() => expect((harness.app as any).contextPanelState.status).toBe("ready"));
    harness.app.render(200);
    return harness;
  }

  function focusContext(app: any): void {
    app.handleInput("\t");
    app.handleInput("\t");
    app.handleInput("\t");
  }

  it("joins the Tab cycle and shows the focused border", async () => {
    const { app } = await createContextHarness();

    focusContext(app);
    expect((app as any).state.focus).toBe("context");
    const rendered = app.render(200).join("\n");
    expect(rendered).toContain("▶ PR context");
    expect(rendered).toContain("Focus: PR context");

    app.handleInput("\u001b[Z");
    expect((app as any).state.focus).toBe("comments");

    app.handleInput("\t");
    app.handleInput("\t");
    expect((app as any).state.focus).toBe("navigator");
    app.dispose();
  });

  it("is skipped by focus traversal when the review has no PR context", async () => {
    const { app, loadFileContents } = createHarness(undefined, undefined, {}, { rows: 30, columns: 200 });
    await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());
    app.render(200);

    for (const expected of ["diff", "comments", "navigator"]) {
      app.handleInput("\t");
      expect((app as any).state.focus).toBe(expected);
    }

    app.handleInput("4");
    expect((app as any).message).toBe("PR context is not available in this review.");
    expect((app as any).state.focus).toBe("navigator");
    app.dispose();
  });

  it("scrolls clipped context with Up/Down and clamps at both ends", async () => {
    const { app } = await createContextHarness();
    focusContext(app);

    const maxScroll = (app as any).maxContextScroll();
    expect((app as any).contextLineCount).toBe(80);
    expect(maxScroll).toBe(80 - (app as any).contextPageSize);
    expect(maxScroll).toBeGreaterThan(0);

    app.handleInput("\u001b[B");
    app.handleInput("\u001b[B");
    expect((app as any).contextScroll).toBe(2);
    const scrolled = app.render(200).join("\n");
    expect(scrolled).toContain("context line 3");
    expect(scrolled).not.toContain("context line 1 ");

    app.handleInput("\u001b[A");
    expect((app as any).contextScroll).toBe(1);

    for (let index = 0; index < 5; index += 1) app.handleInput("\u001b[6~");
    expect((app as any).contextScroll).toBe(maxScroll);

    app.handleInput("\u001b[B");
    expect((app as any).contextScroll).toBe(maxScroll);

    app.handleInput("g");
    app.handleInput("g");
    expect((app as any).contextScroll).toBe(0);

    app.handleInput("\u001b[A");
    expect((app as any).contextScroll).toBe(0);

    app.handleInput("G");
    expect((app as any).contextScroll).toBe(maxScroll);
    app.dispose();
  });

  it("keeps the diff selection untouched while scrolling context", async () => {
    const { app } = await createContextHarness();
    focusContext(app);
    const before = structuredClone((app as any).state.selectedLineTargetByScopeFile);

    app.handleInput("\u001b[B");
    app.handleInput("j");

    expect((app as any).contextScroll).toBe(2);
    expect((app as any).state.selectedLineTargetByScopeFile).toEqual(before);
    app.dispose();
  });

  it("opens the canonical PR URL with Enter at any scroll position", async () => {
    const openUrl = vi.fn(async (url: string) => ({ status: "opened" as const, url }));
    const { app } = await createContextHarness({ openUrl });
    focusContext(app);

    app.handleInput("\r");
    await vi.waitFor(() => expect(openUrl).toHaveBeenCalledWith(prUrl));
    expect((app as any).message).toBe(`Opened ${prUrl} in your browser.`);

    app.handleInput("G");
    app.handleInput("\r");
    await vi.waitFor(() => expect(openUrl).toHaveBeenCalledTimes(2));
    expect((app as any).contextScroll).toBe((app as any).maxContextScroll());
    app.dispose();
  });

  it("reports missing and invalid PR URLs instead of opening anything", async () => {
    const openUrl = vi.fn(async () => ({ status: "invalid" as const }));
    const missing = await createContextHarness({
      openUrl,
      contextPanelSource: { title: "PR context", loadingText: "Loading PR context", load: vi.fn(async () => contextText) },
    });
    focusContext(missing.app);

    missing.app.handleInput("\r");
    expect(openUrl).not.toHaveBeenCalled();
    expect((missing.app as any).message).toBe("No PR URL is available for this review.");
    missing.app.dispose();

    const invalid = await createContextHarness({
      openUrl,
      contextPanelSource: { title: "PR context", loadingText: "Loading PR context", url: "javascript:alert(1)", load: vi.fn(async () => contextText) },
    });
    focusContext(invalid.app);

    invalid.app.handleInput("\r");
    await vi.waitFor(() => expect((invalid.app as any).message).toBe("PR URL is not a valid http(s) address."));
    invalid.app.dispose();
  });

  it("focuses and scrolls the context pane from the mouse wheel", async () => {
    const { app } = await createContextHarness();
    const bounds = (app as any).mousePaneLayout.context;
    expect(bounds).not.toBeNull();

    app.handleInput(`\u001b[<65;${bounds.left + 2};${bounds.top + 2}M`);
    expect((app as any).state.focus).toBe("context");
    expect((app as any).contextScroll).toBe(1);

    app.handleInput(`\u001b[<64;${bounds.left + 2};${bounds.top + 2}M`);
    expect((app as any).contextScroll).toBe(0);
    app.dispose();
  });

  it("keeps context scroll independent from navigator, diff, and comments scroll", async () => {
    const { app } = await createContextHarness();
    focusContext(app);

    app.handleInput("\u001b[B");
    app.handleInput("\u001b[B");
    app.handleInput("\u001b[B");

    expect((app as any).contextScroll).toBe(3);
    expect((app as any).navigatorScroll).toBe(0);
    expect((app as any).diffScroll).toBe(0);
    expect((app as any).commentsScroll).toBe(0);
    app.dispose();
  });

  it("moves a resumed context focus to a visible pane when the review has no PR context", async () => {
    const file = makeFile();
    const initialSession = {
      version: 2,
      id: "session-1",
      identity: "local",
      updatedAt: new Date().toISOString(),
      revision: "abc",
      fileSignatures: {},
      state: {
        activeScope: "git-diff",
        activeFileId: file.id,
        searchQuery: "",
        focus: "context",
        wrapLines: true,
        hideUnchanged: false,
        selectedCommentIndex: 0,
        selectedLineTargetByScopeFile: {},
        draft: { allComment: "", allIntent: "discuss", comments: [] },
      },
      diffViewMode: "unified",
      navigatorTreeMode: false,
      contextLineNavigation: false,
      commentsGlobal: false,
      reviewedFileIds: [],
      navigatorScroll: 0,
      diffScroll: 0,
      commentsScroll: 0,
    };
    const { app, loadFileContents } = createHarness(undefined, [file], { initialSession } as never, { rows: 30, columns: 200 });
    await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());

    expect((app as any).state.focus).toBe("navigator");
    app.dispose();
  });

  it("refuses pane search while PR context is focused", async () => {
    const { app } = await createContextHarness();
    focusContext(app);

    app.handleInput("/");

    expect((app as any).searchMode).toBe(false);
    expect((app as any).message).toBe("Search is not available in the PR context pane.");
    app.dispose();
  });
});
