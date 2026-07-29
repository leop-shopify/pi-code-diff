import { describe, expect, it, vi } from "vitest";
import type { ReviewFile } from "../types.js";
import { ReviewApp } from "../ui/review-app.js";

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
) {
  const loadFileContents = vi.fn(async () => contents);
  const terminalWrite = vi.fn();
  const tui = {
    terminal: { write: terminalWrite, rows: 30, columns: 120 },
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
  });
  return { app, done, loadFileContents };
}

describe("ReviewApp interaction", () => {
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

  it("does not shift the entire viewport on every downward move after crossing its edge", async () => {
    const modifiedContent = Array.from({ length: 80 }, (_, index) => `line ${index + 1}`).join("\n") + "\n";
    const { app, loadFileContents } = createHarness({ originalContent: "", modifiedContent });
    await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalled());

    app.render(120);
    app.handleInput("\r");
    for (let index = 0; index < 12; index += 1) {
      app.handleInput("j");
      app.render(120);
    }
    const recenteredScroll = (app as any).diffScroll;

    app.handleInput("j");
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
