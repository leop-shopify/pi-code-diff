import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { createWorkbench } from "../workbench/app.js";
import {
  CHILD_CLOSURE_UNCONFIRMED,
  CHILD_CLOSURE_UNCONFIRMED_MESSAGE,
} from "../workbench/contracts.js";
import { EXPLORER_STATE_VERSION, createExplorerStateStore, type ExplorerStateSession } from "../workbench/explorer-state.js";
import { WorkbenchComponent, type WorkbenchClipboard } from "../workbench/ui/component.js";

function createHarness(overrides: Parameters<typeof createWorkbench>[0], terminalRows = 24, explorerState?: ExplorerStateSession, launch?: import("../workbench/contracts.js").WorkbenchLaunch, clipboard?: WorkbenchClipboard) {
  const tui = { requestRender: vi.fn(), terminal: { rows: terminalRows } };
  const theme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
  };
  const done = vi.fn();
  const workbench = createWorkbench(overrides);
  const component = new WorkbenchComponent(tui as never, theme, workbench, done, explorerState, launch, clipboard);
  return { component, done, tui, workbench };
}

describe("workbench interaction", () => {
  it("lazily renders a bounded full-screen two-pane tree after start", async () => {
    const { component, workbench } = createHarness({
      listFiles: async () => "README.md\0src/app.ts\0src/nested/deep.ts\0",
      readText: async (path) => ({ text: path, revision: path }),
      saveText: async () => ({ status: "error", message: "not used" }),
      maxReadBytes: 1024,
    }, 18);

    expect(component.render(80)).toHaveLength(14);
    await workbench.start();
    const rendered = component.render(80);

    expect(rendered).toHaveLength(14);
    expect(rendered[0]).toContain(" code ");
    expect(rendered[1]).toBe(`│${" ".repeat(78)}│`);
    expect(rendered.join("\n")).toContain("▶ EXPLORER");
    expect(rendered.join("\n")).toContain("SOURCE");
    expect(rendered.join("\n")).toContain("src");
    expect(rendered.join("\n")).not.toContain("nested");
    expect(rendered.join("\n")).toContain("Esc/Ctrl+C close");
    expect(rendered.every((line) => visibleWidth(line) === 80)).toBe(true);
    expect(component.render(40).every((line) => visibleWidth(line) === 40)).toBe(true);
  });

  it("renders a bounded compact state below the two-pane viewport minimum", async () => {
    const repository = {
      listFiles: async () => "src/app.ts\0",
      readText: async () => ({ text: "source", revision: "r1" }),
      saveText: async () => ({ status: "error" as const, message: "not used" }),
      maxReadBytes: 1024,
    };

    for (const { width, rows } of [
      { width: 35, rows: 10 },
      { width: 20, rows: 8 },
      { width: 3, rows: 2 },
      { width: 1, rows: 1 },
    ]) {
      const { component, workbench } = createHarness(repository, rows);
      await workbench.start();
      const rendered = component.render(width);

      expect(rendered.length).toBeLessThanOrEqual(rows);
      expect(rendered.every((line) => visibleWidth(line) <= width)).toBe(true);
      if (width >= 20 && rows >= 8) expect(rendered.join("\n")).toContain("Esc/Ctrl+C close");
    }
  });

  it("adopts the started prebuilt tree without rebuilding repository metadata", async () => {
    const files = Array.from({ length: 50_000 }, (_, index) => `file-${index}.ts`);
    const { component, workbench } = createHarness({
      listFiles: async () => `${files.join("\0")}\0`,
      readText: async (path) => ({ text: path, revision: path }),
      saveText: async () => ({ status: "error", message: "not used" }),
      maxReadBytes: 1024,
    }, 18);

    expect(component.render(80).join("\n")).not.toContain("file-0.ts");
    await workbench.start();
    const startedTree = workbench.repositoryTree;
    expect(component.render(80).join("\n")).toContain("file-0.ts");
    expect(component.render(80).join("\n")).toContain("file-0.ts");
    expect(workbench.repositoryTree).toBe(startedTree);
  });

  it("sanitizes repository controls while preserving bounded two-pane rows", async () => {
    const unsafePath = "src/\tbad\u001bname.ts";
    const { component, workbench } = createHarness({
      listFiles: async () => `${unsafePath}\0`,
      readText: async () => ({ text: "source", revision: "r1" }),
      saveText: async () => ({ status: "error", message: "not used" }),
      searchText: async () => ({
        results: [{ path: unsafePath, line: 1, column: 1, text: "match\t\u0007" }],
        coverage: "working-tree" as const,
      }),
      maxReadBytes: 1024,
    });
    const width = 100;
    const controls = /[\u0000-\u001f\u007f-\u009f]/;
    const expectBoundedRows = (): string[] => {
      const rendered = component.render(width);
      expect(rendered.every((row) => visibleWidth(row) <= width)).toBe(true);
      const renderedWithoutStyling = rendered.map((row) => row.replace(/\u001b\[[0-9;]*m/g, ""));
      expect(renderedWithoutStyling.every((row) => !controls.test(row))).toBe(true);
      expect(rendered.slice(2, -2).every((row) => row.includes("│"))).toBe(true);
      return rendered;
    };

    await workbench.start();
    component.handleInput("\x1b[B");
    component.handleInput("\x1b[C");
    expect(expectBoundedRows().join("\n")).toContain("badna");

    component.handleInput("\x06");
    component.handleInput("x");
    component.handleInput("\r");
    await vi.waitFor(() => expect(workbench.searchResults).toHaveLength(1));
    expect(expectBoundedRows().join("\n")).toContain("match");
  });

  it("expands folders, selects parents, opens files, and returns to Explorer with Escape", async () => {
    const readText = vi.fn(async (path: string) => ({ text: `opened ${path}`, revision: path }));
    const { component, workbench } = createHarness({
      listFiles: async () => "src/app.ts\0src/lib/deep.ts\0",
      readText,
      saveText: async () => ({ status: "error", message: "not used" }),
      maxReadBytes: 1024,
    });
    await workbench.start();

    component.handleInput("\t");
    expect(component.render(80).join("\n")).toContain("▶ EXPLORER");

    component.handleInput("\x1b[B");
    component.handleInput("\x1b[C");
    expect(component.render(80).join("\n")).toContain("app.ts");
    component.handleInput("\x1b[B");
    component.handleInput("\x1b[B");
    component.handleInput("\x1b[C");
    await vi.waitFor(() => expect(workbench.selectedPath).toBe("src/app.ts"));
    expect(component.render(80).join("\n")).toContain("▶ SOURCE");

    component.handleInput("\x1b");
    expect(component.render(80).join("\n")).toContain("▶ EXPLORER");
    component.handleInput("\x1b[A");
    component.handleInput("\x1b[C");
    expect(component.render(80).join("\n")).toContain("deep.ts");
    component.handleInput("\x1b[D");
    expect(component.render(80).join("\n")).not.toContain("deep.ts");
    component.handleInput("\x1b[D");
    expect(component.render(80).join("\n")).toMatch(/›\s+▾ src/);
  });

  it("reveals capped files independently and keeps a deep tree selection in view", async () => {
    const many = Array.from({ length: 25 }, (_, index) => `many/file-${String(index).padStart(2, "0")}.ts`);
    const files = ["other/a.ts", ...many];
    const { component, workbench } = createHarness({
      listFiles: async () => `${files.join("\0")}\0`,
      readText: async (path) => ({ text: path, revision: path }),
      saveText: async () => ({ status: "error", message: "not used" }),
      maxReadBytes: 1024,
    }, 14);
    await workbench.start();

    component.handleInput("\x1b[B");
    component.handleInput("\r");
    for (let index = 0; index < 21; index += 1) component.handleInput("j");
    let rendered = component.render(72).join("\n");
    expect(rendered).toContain("show 5 more");
    expect(rendered).toMatch(/›\s+… show 5 more/);
    component.handleInput("\r");
    for (let index = 0; index < 4; index += 1) component.handleInput("\x1b[B");
    rendered = component.render(72).join("\n");
    expect(rendered).toContain("file-24.ts");

    component.handleInput("\x1b[D");
    component.handleInput("\x1b[D");
    component.handleInput("\x1b[B");
    component.handleInput("\x1b[C");
    component.handleInput("\x1b[D");
    component.handleInput("\x1b[A");
    component.handleInput("\x1b[C");
    for (let index = 0; index < 25; index += 1) component.handleInput("\x1b[B");
    rendered = component.render(72).join("\n");
    expect(rendered).toContain("file-24.ts");
    expect(rendered).not.toContain("show 5 more");
  });

  it("falls back atomically for rejected highlighting in NORMAL and INSERT", async () => {
    const lines = Array.from({ length: 30 }, (_, index) => `line ${index + 1}${index === 20 ? "\u001b[2J" : ""}`);
    const { component, workbench } = createHarness({
      listFiles: async () => "source.ts\0",
      readText: async () => ({ text: lines.join("\n"), revision: "r1" }),
      saveText: async () => ({ status: "error", message: "not used" }),
      sourceHighlighter: { highlight: async (_path, text) => text.split("\n").map((line, index) => `\u001b[38;2;255;0;0m${line}${index === 20 ? "\nINJECT" : ""}\u001b[0m`) },
      maxReadBytes: 1024,
    }, 16);
    await workbench.start();
    component.handleInput("\x1b[B");
    component.handleInput("\r");
    await vi.waitFor(() => expect(workbench.selectedPath).toBe("source.ts"));

    for (let index = 0; index < 20; index += 1) component.handleInput("j");
    let output = component.render(80).join("\n");
    expect(workbench.selectedLine).toBe(21);
    expect(output).toContain("line 21�[2J");
    expect(output).toContain(">  21");
    expect(output).not.toContain("INJECT");
    expect(output).not.toContain("\\nINJECT");
    expect(output).not.toContain("\u001b[38;2;255;0;0m");

    component.handleInput("i");
    output = component.render(80).join("\n");
    expect(output).toContain("line 21�[2J");
    expect(output).not.toContain("INJECT");
    expect(output).not.toContain("\\nINJECT");
    expect(output).not.toContain("\u001b[38;2;255;0;0m");
  });

  it("keeps the tree visible while Git occupies the bounded right pane", async () => {
    const { component, workbench } = createHarness({
      listFiles: async () => "src/file.ts\0",
      readText: async () => ({ text: "safe", revision: "r1" }),
      saveText: async () => ({ status: "error", message: "not used" }),
      getGitContext: async () => ({
        branch: { kind: "branch" as const, name: "main" }, status: [], commits: [],
        diff: Array.from({ length: 30 }, (_, index) => `diff ${index}`).join("\n"),
        statusCapped: false, commitsCapped: false, diffCapped: false,
      }),
      maxReadBytes: 1024,
    }, 15);
    await workbench.start();
    component.handleInput("\x07");
    await vi.waitFor(() => expect(component.render(80).join("\n")).toContain("Branch"));
    const rendered = component.render(80);
    expect(rendered).toHaveLength(12);
    expect(rendered.join("\n")).toContain("EXPLORER");
    expect(rendered.join("\n")).toContain("▶ GIT");
    expect(rendered.join("\n")).toContain("src");
  });

  it("runs a text query once, then opens the selected result on the next Enter", async () => {
    const readText = vi.fn(async (path: string) => ({ text: `contents of ${path}`, revision: `revision:${path}` }));
    const searchText = vi.fn(async () => ({
      results: [{ path: "src/result.ts", line: 9, column: 3, text: "needle" }],
      coverage: "working-tree" as const,
    }));
    const { component, workbench } = createHarness({
      listFiles: async () => "src/result.ts\0",
      readText,
      saveText: async () => ({ status: "error", message: "not used" }),
      searchText,
      maxReadBytes: 1024,
    });
    await workbench.start();

    component.handleInput("\x06");
    for (const character of "green") component.handleInput(character);
    component.handleInput("\r");
    await vi.waitFor(() => expect(workbench.searchResults).toHaveLength(1));
    expect(component.render(100).join("\n")).toContain("Search: working tree");

    component.handleInput("\r");
    await vi.waitFor(() => expect(readText).toHaveBeenCalledExactlyOnceWith("src/result.ts", 1024));
    expect(searchText).toHaveBeenCalledExactlyOnceWith("green", expect.any(AbortSignal));
    expect(workbench.selectedLine).toBe(9);
  });

  it("reruns a changed symbol query before opening its result", async () => {
    const readText = vi.fn(async (path: string) => ({ text: path, revision: `revision:${path}` }));
    const searchSymbols = vi.fn(async (query: string) => [{
      path: "src/result.ts",
      line: query.length,
      column: 1,
      text: `function ${query}() {}`,
      name: query,
    }]);
    const { component, workbench } = createHarness({
      listFiles: async () => "src/result.ts\0",
      readText,
      saveText: async () => ({ status: "error", message: "not used" }),
      searchSymbols,
      maxReadBytes: 1024,
    });
    await workbench.start();

    component.handleInput("@");
    component.handleInput("a");
    component.handleInput("\r");
    await vi.waitFor(() => expect(workbench.symbols[0]?.name).toBe("a"));
    component.handleInput("b");
    component.handleInput("\r");
    await vi.waitFor(() => expect(workbench.symbols[0]?.name).toBe("ab"));
    expect(readText).not.toHaveBeenCalled();

    component.handleInput("\r");
    await vi.waitFor(() => expect(readText).toHaveBeenCalledExactlyOnceWith("src/result.ts", 1024));
    expect(searchSymbols).toHaveBeenCalledTimes(2);
  });

  it("opens a discoverable, sanitized, bounded-scroll Git pane with Ctrl+G", async () => {
    const { component, workbench } = createHarness({
      listFiles: async () => "src/file.ts\0",
      readText: async () => ({ text: "safe", revision: "r1" }),
      saveText: async () => ({ status: "error", message: "not used" }),
      getGitContext: async () => ({
        branch: { kind: "detached" as const, head: "abc1234" },
        status: [{ index: " ", worktree: "M", path: "unsafe\u001bname.ts" }],
        commits: [{ shortHash: "abc1234", subject: "subject\u0007" }],
        diff: Array.from({ length: 20 }, (_, index) => `line ${index}\u001b`).join("\n"),
        statusCapped: false,
        commitsCapped: false,
        diffCapped: true,
      }),
      maxReadBytes: 1024,
    });
    await workbench.start();
    expect(component.render(120).join("\n")).toContain("Ctrl+G Git");
    component.handleInput("\x07");
    await vi.waitFor(() => expect(component.render(120).join("\n")).toContain("detached HEAD at abc1234"));
    expect(component.render(120).join("\n")).toContain("Working-tree diff (truncated)");
    expect(component.render(120).join("\n")).not.toContain("\u001bname");
    for (let index = 0; index < 21; index += 1) component.handleInput("\x1b[B");
    expect(component.render(120).join("\n")).toContain("›   line 14");
  });

  it("keeps the selected file visible while navigating beyond the first viewport", async () => {
    const files = Array.from({ length: 15 }, (_, index) => `file-${String(index).padStart(2, "0")}.ts`);
    const { component, workbench } = createHarness({
      listFiles: async () => `${files.join("\0")}\0`,
      readText: async (path) => ({ text: path, revision: `revision:${path}` }),
      saveText: async () => ({ status: "error", message: "not used" }),
      maxReadBytes: 1024,
    });
    await workbench.start();

    for (let index = 0; index < 13; index += 1) component.handleInput("\x1b[B");

    expect(component.render(100).join("\n")).toMatch(/›\s+· file-12\.ts/);
  });

  it("restores and saves process-memory Explorer selection and viewport once per tree", async () => {
    const store = createExplorerStateStore();
    const stored = store.forWorkspace("/repo");
    if (stored == null) throw new Error("Explorer session expected");
    stored.save({
      version: EXPLORER_STATE_VERSION,
      expandedFolderKeys: ["folder:", "folder:src", "folder:src/app"],
      revealedFolders: [],
      selectedKey: "file:src/app/a.ts",
      viewport: { topKey: "folder:src", selectedOffset: 2 },
    });
    const session = { load: vi.fn(() => stored.load()), save: vi.fn((state) => stored.save(state)) } satisfies ExplorerStateSession;
    const { component, done, workbench } = createHarness({
      listFiles: async () => "src/app/a.ts\0src/lib/b.ts\0README.md\0",
      readText: async (path) => ({ text: path, revision: path }),
      saveText: async () => ({ status: "error", message: "not used" }),
      maxReadBytes: 1024,
    }, 24, session);
    await workbench.start();

    const first = component.render(100).join("\n");
    const second = component.render(100).join("\n");
    expect(first).toMatch(/›\s+· a\.ts/);
    expect(first).toContain("▾ app");
    expect(second).toContain("a.ts");
    expect(session.load).toHaveBeenCalledOnce();

    component.requestClose();
    expect(done).toHaveBeenCalledWith({ status: "closed", changedPaths: [] });
    expect(session.save).toHaveBeenCalledOnce();
    expect(session.save.mock.calls[0]?.[0]).toMatchObject({
      version: EXPLORER_STATE_VERSION,
      selectedKey: "file:src/app/a.ts",
      expandedFolderKeys: expect.arrayContaining(["folder:", "folder:src", "folder:src/app"]),
    });
  });

  it("falls back safely when remembered Explorer selection and viewport keys are stale", async () => {
    const session = {
      load: vi.fn(() => ({
        version: EXPLORER_STATE_VERSION,
        expandedFolderKeys: ["folder:gone"] as `folder:${string}`[],
        revealedFolders: [],
        selectedKey: "file:gone/missing.ts" as const,
        viewport: { topKey: "folder:gone" as const, selectedOffset: 4 },
      })),
      save: vi.fn(),
    } satisfies ExplorerStateSession;
    const { component, workbench } = createHarness({
      listFiles: async () => "file.ts\0",
      readText: async () => ({ text: "source", revision: "r1" }),
      saveText: async () => ({ status: "error", message: "not used" }),
      maxReadBytes: 1024,
    }, 24, session);
    await workbench.start();

    expect(() => component.render(100)).not.toThrow();
    expect(component.render(100).join("\n")).toMatch(/›\s+▾ \./);
    expect(session.load).toHaveBeenCalledOnce();
  });

  it("does not overwrite remembered Explorer state when dirty close is cancelled", async () => {
    const session = { load: vi.fn(() => undefined), save: vi.fn() } satisfies ExplorerStateSession;
    const { component, done, workbench } = createHarness({
      listFiles: async () => "file.ts\0",
      readText: async () => ({ text: "old", revision: "r1" }),
      saveText: async () => ({ status: "error", message: "not used" }),
      maxReadBytes: 1024,
    }, 24, session);
    await workbench.start();
    await workbench.selectFile("file.ts");
    workbench.replaceBuffer("dirty");

    component.requestClose();
    component.handleInput("c");
    await vi.waitFor(() => expect(workbench.pendingAction).toBeNull());

    expect(done).not.toHaveBeenCalled();
    expect(session.save).not.toHaveBeenCalled();
  });

  it("leaves INSERT without closing and offers reliable Explorer/source pane shortcuts", async () => {
    const { component, done, workbench } = createHarness({
      listFiles: async () => "file.ts\0",
      readText: async () => ({ text: "source", revision: "r1" }),
      saveText: async () => ({ status: "error", message: "not used" }),
      maxReadBytes: 1024,
    });
    await workbench.start();
    component.handleInput("\x1b[B");
    component.handleInput("\r");
    await vi.waitFor(() => expect(workbench.selectedPath).toBe("file.ts"));

    expect(component.render(100).join("\n")).toContain("NORMAL SOURCE");
    component.handleInput("\x05");
    expect(component.render(100).join("\n")).toContain("INSERT SOURCE");
    component.handleInput("x");
    component.handleInput("\x05");
    expect(component.render(100).join("\n")).toContain("INSERT SOURCE");
    component.handleInput("\x1b");
    expect(component.render(100).join("\n")).toContain("NORMAL SOURCE");
    expect(done).not.toHaveBeenCalled();

    component.handleInput("\x1b");
    expect(component.render(100).join("\n")).toContain("▶ EXPLORER");
    expect(done).not.toHaveBeenCalled();
    component.handleInput("\t");
    expect(component.render(100).join("\n")).toContain("▶ SOURCE");
    component.handleInput("\x1b[Z"); // Shift+Tab
    expect(component.render(100).join("\n")).toContain("▶ EXPLORER");
  });

  it("opens Find File with Command+P or Shift+Command+P without losing edits", async () => {
    vi.useFakeTimers();
    try {
      const files = { "a.ts": "alpha", "b.ts": "beta" };
      const highlight = vi.fn(async (_path: string, text: string) => text.split(/\r\n|\r|\n/));
      const { component, done, workbench } = createHarness({
        listFiles: async () => "a.ts\0b.ts\0",
        readText: async (path) => ({ text: files[path as keyof typeof files]!, revision: path }),
        saveText: async () => ({ status: "error" as const, message: "unused" }),
        sourceHighlighter: { highlight },
        maxReadBytes: 1024,
      });
      const settle = async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve(); };
      const findFile = "\x1b[112;9u"; // Command+P (Ghostty forwards this)
      const shiftedFindFile = "\x1b[112;10u";

      await workbench.start();
      await workbench.selectFile("a.ts");
      component.handleInput("\t");
      component.handleInput(shiftedFindFile);
      expect(component.render(100).join("\n")).toContain("FIND FILE");
      component.handleInput("\x1b");
      expect(component.render(100).join("\n")).toContain("▶ EXPLORER");

      component.handleInput("\t");
      component.handleInput("i");
      component.handleInput("!");
      expect(workbench.bufferText).toBe("alpha!");
      expect(workbench.isDirty).toBe(true);
      component.handleInput(findFile);
      expect(component.render(100).join("\n")).toContain("FIND FILE");
      expect(component.render(100).join("\n")).not.toContain("INSERT SOURCE");
      expect(workbench.bufferText).toBe("alpha!");
      await vi.advanceTimersByTimeAsync(101);
      await settle();
      expect(highlight.mock.calls.filter(([path]) => path === "a.ts")).toHaveLength(1);

      component.handleInput("b");
      component.handleInput("\r");
      await settle();
      expect(component.render(100).join("\n")).toContain("Save / Discard / Cancel");
      component.handleInput("c");
      await settle();
      expect(workbench.selectedPath).toBe("a.ts");
      expect(workbench.bufferText).toBe("alpha!");
      expect(done).not.toHaveBeenCalled();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("keeps syntax highlighting visible while whole-buffer INSERT edits and refreshes after idle", async () => {
    const highlight = vi.fn(async (_path: string, text: string) => {
      const color = highlight.mock.calls.length === 1 ? "1" : "3";
      return text.split("\n").map((line) => `\u001b[${color}m${line}\u001b[0m`);
    });
    const { component, workbench } = createHarness({
      listFiles: async () => "file.ts\0",
      readText: async () => ({ text: "🙂const value", revision: "r1" }),
      saveText: async () => ({ status: "error", message: "not used" }),
      sourceHighlighter: { highlight },
      maxReadBytes: 1024,
    });
    await workbench.start();
    component.handleInput("\x1b[B");
    component.handleInput("\r");
    await vi.waitFor(() => expect(workbench.selectedPath).toBe("file.ts"));

    component.handleInput("i");
    let rendered = component.render(100).join("\n");
    expect(rendered).toContain("INSERT SOURCE");
    expect(rendered).toContain("\u001b[1m");

    component.handleInput("!");
    rendered = component.render(100).join("\n");
    expect(workbench.bufferText).toBe("🙂const value!");
    expect(rendered).toContain("\u001b[1m");
    expect(rendered.replace(/\u001b\[[0-9;]*m/g, "")).toContain("🙂const value!");

    await vi.waitFor(() => expect(highlight).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(component.render(100).join("\n")).toContain("\u001b[3m"));
    component.handleInput("\x1b");

    expect(component.render(100).join("\n")).toContain("\u001b[3m🙂const value!\u001b[0m");
  });

  it("keeps projected syntax colors when undo returns the whole buffer to clean", async () => {
    const highlighted = ["\u001b[1mconst value\u001b[0m"];
    const highlight = vi.fn(async () => highlighted);
    const { component, workbench } = createHarness({
      listFiles: async () => "file.ts\0",
      readText: async () => ({ text: "const value", revision: "r1" }),
      saveText: async () => ({ status: "error", message: "not used" }),
      sourceHighlighter: { highlight },
      maxReadBytes: 1024,
    });
    await workbench.start();
    await workbench.selectFile("file.ts");
    const originalHighlights = workbench.highlightedLines;

    component.handleInput("\x05");
    component.handleInput("!");
    expect(workbench.highlightedLines).not.toBe(originalHighlights);
    expect(workbench.isDirty).toBe(true);
    component.handleInput("\x1a");

    expect(workbench.bufferText).toBe("const value");
    expect(workbench.isDirty).toBe(false);
    expect(workbench.highlightedLines).not.toBe(originalHighlights);
    expect(workbench.highlightedLines?.join("\n")).toContain("\u001b[1m");
    await vi.waitFor(() => expect(highlight).toHaveBeenCalledTimes(2));
    expect(component.render(100).join("\n")).toContain("\u001b[1m");
  });

  it("copies, cuts, and pastes exact selections with Command shortcuts", async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    const { component, workbench } = createHarness({
      listFiles: async () => "file.ts\0",
      readText: async () => ({ text: "alpha beta", revision: "r1" }),
      saveText: async () => ({ status: "error" as const, message: "not used" }),
      maxReadBytes: 1024,
    }, 24, undefined, undefined, { writeText });
    await workbench.start();
    await workbench.selectFile("file.ts");
    component.handleInput("\x05");
    component.handleInput("\x1b[1;4D"); // Option+Shift+Left selects beta

    component.handleInput("\x1b[99;9u"); // Command+C
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("beta"));
    expect(workbench.bufferText).toBe("alpha beta");

    component.handleInput("\x1b[120;9u"); // Command+X
    expect(workbench.bufferText).toBe("alpha ");
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));

    component.handleInput("\x1b[118;9u"); // Command+V uses the in-workbench clipboard
    expect(workbench.bufferText).toBe("alpha beta");
    component.handleInput("\x1b[97;9u"); // Command+A
    component.handleInput("\x1b[200~outside\x1b[201~"); // native terminal paste replaces selection
    expect(workbench.bufferText).toBe("outside");
    expect(component.render(100).join("\n")).toContain("INSERT SOURCE");
  });

  it("cancels a clean INSERT highlight timer before Explorer switches to a large file", async () => {
    vi.useFakeTimers();
    try {
      const files = {
        "a-small.ts": "const value",
        "z-large.ts": "x".repeat(64 * 1024 + 1),
      };
      const highlight = vi.fn(async (_path: string, text: string) => text.split(/\r\n|\r|\n/));
      const { component, workbench } = createHarness({
        listFiles: async () => "a-small.ts\0z-large.ts\0",
        readText: async (path) => ({ text: files[path as keyof typeof files]!, revision: path }),
        saveText: async () => ({ status: "error", message: "not used" }),
        sourceHighlighter: { highlight },
        maxReadBytes: 128 * 1024,
      });
      const settle = async () => { for (let index = 0; index < 5; index += 1) await Promise.resolve(); };

      await workbench.start();
      component.handleInput("\x1b[B");
      component.handleInput("\r");
      await settle();
      expect(workbench.selectedPath).toBe("a-small.ts");

      component.handleInput("\x05");
      component.handleInput("!");
      component.handleInput("\x1a");
      expect(workbench.isDirty).toBe(false);
      component.handleInput("\x1b");

      component.handleInput("\x1b[1;3D");
      component.handleInput("\x1b[B");
      component.handleInput("\r");
      await settle();
      expect(workbench.selectedPath).toBe("z-large.ts");
      expect(highlight.mock.calls.filter(([path]) => path === "z-large.ts")).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(101);
      await settle();
      expect(highlight.mock.calls.filter(([path]) => path === "z-large.ts")).toHaveLength(1);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("accepts split multiline paste and routes INSERT Ctrl+C through safe dirty close", async () => {
    const { component, done, workbench } = createHarness({
      listFiles: async () => "file.ts\0",
      readText: async () => ({ text: "start\nend", revision: "r1" }),
      saveText: async () => ({ status: "error", message: "not used" }),
      maxReadBytes: 1024,
    });
    await workbench.start();
    await workbench.selectFile("file.ts");

    component.handleInput("\x05");
    component.handleInput("\x1b[200~A\r\n");
    expect(workbench.bufferText).toBe("start\nend");
    component.handleInput("B\t\x1b[201~");
    expect(workbench.bufferText).toBe("startA\r\nB\t\nend");
    expect(workbench.selectedLine).toBe(2);

    component.handleInput("\x03");
    expect(component.render(100).join("\n")).toContain("Save / Discard / Cancel");
    expect(component.render(100).join("\n")).toContain("CONFIRM SOURCE");
    expect(done).not.toHaveBeenCalled();
    component.handleInput("c");
    await vi.waitFor(() => expect(workbench.pendingAction).toBeNull());
    expect(workbench.bufferText).toBe("startA\r\nB\t\nend");
  });

  it("soft-wraps a long INSERT line inside SOURCE without hiding either end", async () => {
    const longLine = `BEGIN-${"x".repeat(45)}-END`;
    const { component, workbench } = createHarness({
      listFiles: async () => "file.ts\0",
      readText: async () => ({ text: longLine, revision: "r1" }),
      saveText: async () => ({ status: "error", message: "not used" }),
      maxReadBytes: 1024,
    });
    await workbench.start();
    component.handleInput("\x1b[B");
    component.handleInput("\r");
    await vi.waitFor(() => expect(workbench.selectedPath).toBe("file.ts"));

    component.handleInput("i");
    const rendered = component.render(60);
    const plain = rendered.join("\n").replace(/\u001b\[[0-9;]*m/g, "");

    expect(plain).toContain("BEGIN-");
    expect(plain).toContain("-END");
    expect(rendered.every((row) => visibleWidth(row) === 60)).toBe(true);
    expect(workbench.bufferText).toBe(longLine);
  });

  it("uses i/I and Escape for modal insertion while preserving literal tabs", async () => {
    const { component, done, workbench } = createHarness({
      listFiles: async () => "file.ts\0",
      readText: async () => ({ text: "ab", revision: "r1" }),
      saveText: async () => ({ status: "error", message: "not used" }),
      maxReadBytes: 1024,
    });
    await workbench.start();
    component.handleInput("\x1b[B");
    component.handleInput("\r");
    await vi.waitFor(() => expect(workbench.selectedPath).toBe("file.ts"));

    component.handleInput("i");
    expect(component.render(100).join("\n")).toContain("INSERT SOURCE");
    component.handleInput("\x1b[D");
    component.handleInput("\t");
    expect(workbench.bufferText).toBe("a\tb");
    component.handleInput("\x1b");
    expect(component.render(100).join("\n")).toContain("NORMAL SOURCE");
    expect(done).not.toHaveBeenCalled();

    component.handleInput("I");
    expect(component.render(100).join("\n")).toContain("INSERT SOURCE");
    component.handleInput("!");
    component.handleInput("\x1b");
    expect(workbench.bufferText).toBe("a\tb!");
    expect(done).not.toHaveBeenCalled();
  });

  it("edits and saves the exact whole buffer with Ctrl+S while staying in INSERT", async () => {
    const saveText = vi.fn(async (_path: string, text: string) => ({ status: "success" as const, effect: "saved" as const, revision: `saved:${text}` }));
    const { component, workbench } = createHarness({
      listFiles: async () => "src/file.ts\0",
      readText: async () => ({ text: "\tconst value = 1;\r\nnext();\r\n", revision: "r1" }),
      saveText,
      maxReadBytes: 1024,
    });
    await workbench.start();
    await workbench.selectFile("src/file.ts");

    expect(component.render(100).join("\n")).toContain("Ctrl+E insert");
    component.handleInput("\x05");
    for (const character of " // changed") component.handleInput(character);
    component.handleInput("\r");
    for (const character of "\tinserted();") component.handleInput(character);
    expect(workbench.bufferText).toBe("\tconst value = 1; // changed\r\n\tinserted();\r\nnext();\r\n");
    expect(workbench.isDirty).toBe(true);

    component.handleInput("\x13");
    await vi.waitFor(() => expect(component.render(100).join("\n")).toContain("Saved src/file.ts"));
    expect(component.render(100).join("\n")).toContain("INSERT SOURCE");
    expect(saveText).toHaveBeenCalledExactlyOnceWith("src/file.ts", "\tconst value = 1; // changed\r\n\tinserted();\r\nnext();\r\n", "r1");
    expect(workbench.isDirty).toBe(false);
  });

  it("shows cleanup warnings after Ctrl+S while treating committed bytes as clean", async () => {
    const warning = "Saved, but temporary cleanup failed.";
    const { component, workbench } = createHarness({
      listFiles: async () => "src/file.ts\0",
      readText: async () => ({ text: "old", revision: "r1" }),
      saveText: async () => ({ status: "success", effect: "saved", revision: "r2", warning }),
      maxReadBytes: 1024,
    });
    await workbench.start();
    await workbench.selectFile("src/file.ts");
    workbench.replaceBuffer("new");

    component.handleInput("\x13");
    await vi.waitFor(() => expect(component.render(100).join("\n")).toContain(warning));
    expect(component.render(100).join("\n")).toContain("Saved src/file.ts");
    expect(workbench.isDirty).toBe(false);
    expect(workbench.selectedRevision).toBe("r2");
  });

  it("surfaces warned dirty-switch saves and requires a later exit after warned dirty-exit saves", async () => {
    const warning = "Saved, but temporary cleanup failed.";
    const { component, done, workbench } = createHarness({
      listFiles: async () => "a.ts\0b.ts\0",
      readText: async (path) => ({ text: path, revision: `r:${path}` }),
      saveText: async () => ({ status: "success", effect: "saved", revision: "saved", warning }),
      maxReadBytes: 1024,
    });
    await workbench.start();
    await workbench.selectFile("a.ts");
    workbench.replaceBuffer("changed a");
    component.render(100);
    component.handleInput("\x1b[B");
    component.handleInput("\x1b[B");
    component.handleInput("\r");
    await vi.waitFor(() => expect(workbench.pendingAction).toEqual({ action: "switch", targetPath: "b.ts", targetLine: 1 }));

    component.handleInput("s");
    await vi.waitFor(() => expect(workbench.selectedPath).toBe("b.ts"));
    expect(component.render(100).join("\n")).toContain(warning);

    workbench.replaceBuffer("changed b");
    component.requestClose();
    component.handleInput("s");
    component.handleInput("\x1b");
    await vi.waitFor(() => expect(component.render(100).join("\n")).toContain(warning));
    expect(workbench.isDirty).toBe(false);
    expect(workbench.pendingAction).toBeNull();
    expect(done).not.toHaveBeenCalled();

    component.requestClose();
    expect(done).toHaveBeenCalledWith({ status: "closed", changedPaths: ["a.ts", "b.ts"] });
  });

  it("routes Escape through Save / Discard / Cancel without dropping a dirty buffer", async () => {
    const { component, done, workbench } = createHarness({
      listFiles: async () => "src/file.ts\0",
      readText: async () => ({ text: "old", revision: "r1" }),
      saveText: async () => ({ status: "success", effect: "saved", revision: "r2" }),
      maxReadBytes: 1024,
    });
    await workbench.start();
    await workbench.selectFile("src/file.ts");
    workbench.replaceBuffer("dirty");

    component.handleInput("\x1b");
    expect(component.render(100).join("\n")).toContain("Save / Discard / Cancel");
    expect(done).not.toHaveBeenCalled();

    component.handleInput("c");
    await vi.waitFor(() => expect(workbench.pendingAction).toBeNull());
    expect(done).not.toHaveBeenCalled();
    expect(workbench.bufferText).toBe("dirty");
    expect(workbench.isDirty).toBe(true);

    component.handleInput("\x03");
    component.handleInput("d");
    await vi.waitFor(() => expect(done).toHaveBeenCalledWith({ status: "closed", changedPaths: [] }));
    expect(workbench.isDirty).toBe(false);
  });

  it.each([
    { operation: "search", start: (component: WorkbenchComponent) => { component.handleInput("\x06"); component.handleInput("x"); component.handleInput("\r"); }, close: (component: WorkbenchComponent) => component.handleInput("\x03") },
    { operation: "symbols", start: (component: WorkbenchComponent) => { component.handleInput("@"); component.handleInput("x"); component.handleInput("\r"); }, close: (component: WorkbenchComponent) => component.handleInput("\x1b") },
    { operation: "git", start: (component: WorkbenchComponent) => component.handleInput("\x07"), close: (component: WorkbenchComponent) => component.requestClose() },
  ] as const)("waits for a delayed $operation abort to settle before closing", async ({ operation, start, close }) => {
    let signal: AbortSignal | undefined;
    let rejectOperation: ((error: unknown) => void) | undefined;
    const delayedAbort = (receivedSignal: AbortSignal) => new Promise<never>((_resolve, reject) => {
      signal = receivedSignal;
      rejectOperation = reject;
    });
    const { component, done, workbench } = createHarness({
      listFiles: async () => "src/file.ts\0",
      readText: async () => ({ text: "source", revision: "r1" }),
      saveText: async () => ({ status: "error", message: "not used" }),
      searchText: (_query, receivedSignal) => delayedAbort(receivedSignal),
      searchSymbols: (_query, receivedSignal) => delayedAbort(receivedSignal),
      getGitContext: (receivedSignal) => delayedAbort(receivedSignal),
      maxReadBytes: 1024,
    });
    await workbench.start();
    start(component);
    await vi.waitFor(() => expect(signal).toBeDefined());
    const cancel = vi.spyOn(workbench, operation === "git" ? "cancelGitContext" : "cancelSearch");

    close(component);
    close(component);

    expect(signal?.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
    expect(done).not.toHaveBeenCalled();
    expect(component.render(100).join("\n")).toContain("Waiting to close safely");

    rejectOperation?.(new DOMException("Aborted", "AbortError"));
    await vi.waitFor(() => expect(done).toHaveBeenCalledWith({ status: "closed", changedPaths: [] }));
  });

  it("reports unconfirmed child closure as a terminal failure, never a successful close", async () => {
    let signal: AbortSignal | undefined;
    let rejectSearch: ((error: unknown) => void) | undefined;
    const explorerState = { load: vi.fn(() => undefined), save: vi.fn() } satisfies ExplorerStateSession;
    const { component, done, workbench } = createHarness({
      listFiles: async () => "src/file.ts\0",
      readText: async () => ({ text: "source", revision: "r1" }),
      saveText: async () => ({ status: "error", message: "not used" }),
      searchText: async (_query, receivedSignal) => {
        signal = receivedSignal;
        return new Promise((_resolve, reject) => { rejectSearch = reject; });
      },
      maxReadBytes: 1024,
    }, 24, explorerState);
    await workbench.start();
    component.handleInput("\x06");
    component.handleInput("x");
    component.handleInput("\r");
    await vi.waitFor(() => expect(signal).toBeDefined());

    component.handleInput("\x03");
    expect(signal?.aborted).toBe(true);
    expect(done).not.toHaveBeenCalled();
    rejectSearch?.(Object.assign(new Error("rg search did not close after SIGKILL."), { code: CHILD_CLOSURE_UNCONFIRMED }));

    await vi.waitFor(() => expect(done).toHaveBeenCalledWith({
      status: "failed",
      message: CHILD_CLOSURE_UNCONFIRMED_MESSAGE,
      code: CHILD_CLOSURE_UNCONFIRMED,
    }));
    expect(done).not.toHaveBeenCalledWith(expect.objectContaining({ status: "closed" }));
    expect(explorerState.save).toHaveBeenCalledOnce();
  });

  it("gates a latched child-closure failure behind dirty Save / Discard / Cancel", async () => {
    let signal: AbortSignal | undefined;
    let rejectSearch: ((error: unknown) => void) | undefined;
    const getGitContext = vi.fn(async () => ({
      branch: { kind: "branch" as const, name: "main" }, status: [], commits: [], diff: "",
      statusCapped: false, commitsCapped: false, diffCapped: false,
    }));
    const { component, done, workbench } = createHarness({
      listFiles: async () => "src/file.ts\0",
      readText: async () => ({ text: "source", revision: "r1" }),
      saveText: async () => ({ status: "success", effect: "saved", revision: "r2" }),
      searchText: async (_query, receivedSignal) => {
        signal = receivedSignal;
        return new Promise((_resolve, reject) => { rejectSearch = reject; });
      },
      getGitContext,
      maxReadBytes: 1024,
    });
    await workbench.start();
    await workbench.selectFile("src/file.ts");
    workbench.replaceBuffer("dirty");
    component.handleInput("\x06");
    component.handleInput("x");
    component.handleInput("\r");
    await vi.waitFor(() => expect(signal).toBeDefined());
    component.requestClose();
    rejectSearch?.(Object.assign(new Error("rg search did not close after SIGKILL."), { code: CHILD_CLOSURE_UNCONFIRMED }));

    await vi.waitFor(() => expect(component.render(100).join("\n")).toContain("Save / Discard / Cancel"));
    expect(done).not.toHaveBeenCalled();
    component.handleInput("c");
    await vi.waitFor(() => expect(workbench.pendingAction).toBeNull());
    expect(workbench.bufferText).toBe("dirty");
    expect(workbench.isDirty).toBe(true);
    expect(done).not.toHaveBeenCalled();

    component.handleInput("\x07");
    expect(getGitContext).not.toHaveBeenCalled();
    component.requestClose();
    component.handleInput("d");
    await vi.waitFor(() => expect(done).toHaveBeenCalledWith({
      status: "failed",
      message: CHILD_CLOSURE_UNCONFIRMED_MESSAGE,
      code: CHILD_CLOSURE_UNCONFIRMED,
    }));
    expect(done).not.toHaveBeenCalledWith(expect.objectContaining({ status: "closed" }));
  });

  it("cancels dirty source search and Git loads before showing the safe-exit prompt", async () => {
    const searchAbort = vi.fn();
    const gitAbort = vi.fn();
    const { component, done, workbench } = createHarness({
      listFiles: async () => "src/file.ts\0",
      readText: async () => ({ text: "source", revision: "r1" }),
      saveText: async () => ({ status: "success", effect: "saved", revision: "r2" }),
      searchText: async (_query, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => { searchAbort(); reject(new DOMException("Aborted", "AbortError")); })),
      getGitContext: async (signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => { gitAbort(); reject(new DOMException("Aborted", "AbortError")); })),
      maxReadBytes: 1024,
    });
    await workbench.start();
    await workbench.selectFile("src/file.ts");
    workbench.replaceBuffer("dirty");

    component.handleInput("\x06");
    component.handleInput("x");
    component.handleInput("\r");
    component.handleInput("\x1b");
    await vi.waitFor(() => expect(searchAbort).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(component.render(100).join("\n")).toContain("Save / Discard / Cancel"));
    expect(done).not.toHaveBeenCalled();

    component.handleInput("c");
    await vi.waitFor(() => expect(workbench.pendingAction).toBeNull());
    component.handleInput("\x07");
    await vi.waitFor(() => expect(component.render(100).join("\n")).toContain("Loading git"));
    component.handleInput("\x1b");
    await vi.waitFor(() => expect(gitAbort).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(component.render(100).join("\n")).toContain("Save / Discard / Cancel"));
    expect(done).not.toHaveBeenCalled();
  });

  it("enters source navigation after opening a file, search result, or symbol", async () => {
    const readText = vi.fn(async () => ({ text: "one\ntwo\nthree", revision: "r1" }));
    const { component, workbench } = createHarness({
      listFiles: async () => "src/file.ts\0",
      readText,
      saveText: async () => ({ status: "error", message: "not used" }),
      searchText: async () => ({ results: [{ path: "src/file.ts", line: 2, column: 1, text: "two" }], coverage: "working-tree" as const }),
      searchSymbols: async () => [{ path: "src/file.ts", line: 3, column: 1, text: "three", name: "three" }],
      maxReadBytes: 1024,
    });
    await workbench.start();

    component.handleInput("\x1b[B");
    component.handleInput("\x1b[C");
    component.handleInput("\x1b[B");
    component.handleInput("\r");
    await vi.waitFor(() => expect(component.render(100).join("\n")).toContain("▶ SOURCE"));
    expect(readText).toHaveBeenCalledOnce();
    component.handleInput("\x1b[B");
    expect(workbench.selectedLine).toBe(2);

    component.handleInput("\x06");
    component.handleInput("t");
    component.handleInput("\r");
    await vi.waitFor(() => expect(workbench.searchResults).toHaveLength(1));
    component.handleInput("\r");
    await vi.waitFor(() => expect(component.render(100).join("\n")).toContain("▶ SOURCE"));
    expect(workbench.selectedLine).toBe(2);
    component.handleInput("\x1b[B");
    expect(workbench.selectedLine).toBe(3);

    component.handleInput("@");
    component.handleInput("t");
    component.handleInput("\r");
    await vi.waitFor(() => expect(workbench.symbols).toHaveLength(1));
    component.handleInput("\r");
    await vi.waitFor(() => expect(component.render(100).join("\n")).toContain("▶ SOURCE"));
    expect(workbench.selectedLine).toBe(3);
    component.handleInput("\x1b[A");
    expect(workbench.selectedLine).toBe(2);
  });

  it("enters source navigation after a Save or Discard dirty-switch continuation", async () => {
    const { component, workbench } = createHarness({
      listFiles: async () => "a.ts\0b.ts\0",
      readText: async (path) => ({ text: `${path}\nnext`, revision: `r:${path}` }),
      saveText: async () => ({ status: "success" as const, effect: "saved" as const, revision: "saved" }),
      maxReadBytes: 1024,
    });
    await workbench.start();
    component.handleInput("\x1b[B");
    component.handleInput("\r");
    await vi.waitFor(() => expect(workbench.selectedPath).toBe("a.ts"));
    workbench.replaceBuffer("dirty\nnext");
    component.handleInput("\x1b[1;3D");
    component.handleInput("\x1b[B");
    component.handleInput("\r");
    await vi.waitFor(() => expect(component.render(100).join("\n")).toContain("Save / Discard / Cancel"));
    component.handleInput("s");
    await vi.waitFor(() => expect(workbench.selectedPath).toBe("b.ts"));
    component.handleInput("\x1b[B");
    expect(workbench.selectedLine).toBe(2);

    workbench.replaceBuffer("dirty again\nnext");
    component.handleInput("\x1b[1;3D");
    component.handleInput("\x1b[A");
    component.handleInput("\r");
    await vi.waitFor(() => expect(component.render(100).join("\n")).toContain("Save / Discard / Cancel"));
    component.handleInput("d");
    await vi.waitFor(() => expect(workbench.selectedPath).toBe("a.ts"));
    component.handleInput("\x1b[B");
    expect(workbench.selectedLine).toBe(2);
  });

  it("finds explorer paths without repository grep and cancels without closing", async () => {
    const readText = vi.fn(async (path: string) => ({ text: path, revision: path }));
    const searchText = vi.fn();
    const { component, done, workbench } = createHarness({
      listFiles: async () => "src/needle-file.ts\0src/other.ts\0",
      readText, saveText: async () => ({ status: "error", message: "not used" }), searchText, maxReadBytes: 1024,
    });
    await workbench.start();
    component.handleInput("\x1b[B");
    component.handleInput("/");
    for (const character of "needle") component.handleInput(character);
    expect(component.render(100).join("\n")).toContain("src/needle-file.ts");
    expect(searchText).not.toHaveBeenCalled();
    component.handleInput("\x03");
    expect(component.render(100).join("\n")).toMatch(/›\s+▸ src/);
    expect(done).not.toHaveBeenCalled();
    component.handleInput("/");
    for (const character of "needle") component.handleInput(character);
    component.handleInput("\r");
    await vi.waitFor(() => expect(readText).toHaveBeenCalledWith("src/needle-file.ts", 1024));
  });

  it("keeps printable j/k in contextual, repository, and symbol prompts", async () => {
    const searchText = vi.fn(async (query: string) => ({
      results: [{ path: "joker.ts", line: 1, column: 1, text: query }],
      coverage: "working-tree" as const,
    }));
    const searchSymbols = vi.fn(async (query: string) => [{
      path: "joker.ts", line: 1, column: 1, text: `function ${query}() {}`, name: query,
    }]);
    const { component, workbench } = createHarness({
      listFiles: async () => "project.json\0joker.ts\0",
      readText: async (path) => ({ text: path, revision: path }),
      saveText: async () => ({ status: "error", message: "not used" }),
      searchText,
      searchSymbols,
      maxReadBytes: 1024,
    });
    await workbench.start();

    component.handleInput("/");
    for (const character of "project.json") component.handleInput(character);
    expect(component.render(100).join("\n")).toContain("project.json");
    component.handleInput("\x03");

    component.handleInput("/");
    for (const character of "joker") component.handleInput(character);
    expect(component.render(100).join("\n")).toContain("joker.ts");
    component.handleInput("\x03");

    component.handleInput("\x06");
    for (const character of "jok/er") component.handleInput(character);
    expect(component.render(100).join("\n")).toContain("SEARCH");
    component.handleInput("\r");
    await vi.waitFor(() => expect(searchText).toHaveBeenCalledExactlyOnceWith("jok/er", expect.any(AbortSignal)));
    await vi.waitFor(() => expect(component.render(100).join("\n")).not.toContain("BUSY"));
    expect(component.render(100).join("\n")).toContain("SEARCH");

    component.handleInput("@");
    for (const character of "joker") component.handleInput(character);
    expect(component.render(100).join("\n")).toContain("SYMBOLS");
    component.handleInput("\r");
    await vi.waitFor(() => expect(searchSymbols).toHaveBeenCalledExactlyOnceWith("joker", expect.any(AbortSignal)));
    expect(component.render(100).join("\n")).toContain("SYMBOLS");
  });

  it("restores accepted buffer matches after cancelling a new contextual query", async () => {
    const { component, done, workbench } = createHarness({
      listFiles: async () => "file.ts\0",
      readText: async () => ({ text: "needle\nother\nneedle", revision: "r1" }),
      saveText: async () => ({ status: "error", message: "not used" }),
      maxReadBytes: 1024,
    });
    await workbench.start();
    component.handleInput("\x1b[B");
    component.handleInput("\r");
    await vi.waitFor(() => expect(workbench.selectedPath).toBe("file.ts"));

    component.handleInput("/");
    for (const character of "needle") component.handleInput(character);
    component.handleInput("\r");
    expect(workbench.selectedLine).toBe(1);

    component.handleInput("/");
    for (const character of "joker") component.handleInput(character);
    expect(component.render(100).join("\n")).toContain("Find buffer: joker");
    component.handleInput("\x03");
    expect(component.render(100).join("\n")).toContain("/needle • 1/2");
    expect(done).not.toHaveBeenCalled();
    component.handleInput("n");
    expect(workbench.selectedLine).toBe(3);
  });

  it("shows stale buffer-search state without rescanning until n/N", async () => {
    const { component, workbench } = createHarness({
      listFiles: async () => "file.ts\0",
      readText: async () => ({ text: "needle\nother", revision: "r1" }),
      saveText: async () => ({ status: "error", message: "not used" }),
      maxReadBytes: 1024,
    });
    await workbench.start();
    component.handleInput("\x1b[B");
    component.handleInput("\r");
    await vi.waitFor(() => expect(workbench.selectedPath).toBe("file.ts"));
    component.handleInput("/");
    for (const character of "needle") component.handleInput(character);
    component.handleInput("\r");
    workbench.setSelectedLine(1);
    workbench.replaceBuffer("changed\nneedle");

    const stale = component.render(100).join("\n");
    expect(stale).toContain("buffer changed • n/N refresh");
    expect(component.render(100).join("\n")).toContain("buffer changed • n/N refresh");
    component.handleInput("n");
    expect(workbench.selectedLine).toBe(2);
    expect(component.render(100).join("\n")).toContain("/needle • 1/1");
  });

  it("searches raw buffer lines with smart case and wraps n/N", async () => {
    const { component, workbench } = createHarness({
      listFiles: async () => "file.ts\0",
      readText: async () => ({ text: "Needle ansi \u001b[31mneedle\nneedle twice needle\nneedle", revision: "r1" }),
      saveText: async () => ({ status: "error", message: "not used" }),
      sourceHighlighter: { highlight: async () => ["rendered", "\u001b[31mrendered", "rendered"] }, maxReadBytes: 1024,
    });
    await workbench.start();
    component.handleInput("\x1b[B"); component.handleInput("\r");
    await vi.waitFor(() => expect(workbench.selectedPath).toBe("file.ts"));
    component.handleInput("/");
    for (const character of "needle") component.handleInput(character);
    component.handleInput("\r");
    expect(workbench.selectedLine).toBe(1);
    expect(component.render(100).join("\n")).toContain("/needle • 1/3");
    component.handleInput("n"); expect(workbench.selectedLine).toBe(2);
    component.handleInput("n"); expect(workbench.selectedLine).toBe(3);
    component.handleInput("n"); expect(workbench.selectedLine).toBe(1);
    component.handleInput("N"); expect(workbench.selectedLine).toBe(3);
    component.handleInput("/");
    for (const character of "Needle") component.handleInput(character);
    component.handleInput("\r");
    expect(workbench.selectedLine).toBe(1);
    component.handleInput("/");
    for (const character of "missing") component.handleInput(character);
    component.handleInput("\r");
    expect(component.render(100).join("\n")).toContain("No matches for missing");
    workbench.replaceBuffer("needle\nchanged");
    component.handleInput("n");
    expect(workbench.selectedLine).toBe(1);
  });

  it("keeps slash and n/N as whole-buffer INSERT text", async () => {
    const { component, workbench } = createHarness({
      listFiles: async () => "file.ts\0", readText: async () => ({ text: "old", revision: "r1" }),
      saveText: async () => ({ status: "error", message: "not used" }), maxReadBytes: 1024,
    });
    await workbench.start(); component.handleInput("\x1b[B"); component.handleInput("\r");
    await vi.waitFor(() => expect(workbench.selectedPath).toBe("file.ts"));
    component.handleInput("\x05");
    for (const character of "/nN") component.handleInput(character);
    expect(workbench.bufferText).toBe("old/nN");
  });

  it("queues a close requested during save until saving completes", async () => {
    let finishSave: ((result: { status: "success"; effect: "saved"; revision: string }) => void) | undefined;
    const { component, done, workbench } = createHarness({
      listFiles: async () => "src/file.ts\0",
      readText: async () => ({ text: "source", revision: "r1" }),
      saveText: async () => new Promise((resolve) => { finishSave = resolve; }),
      maxReadBytes: 1024,
    });
    await workbench.start();
    await workbench.selectFile("src/file.ts");
    workbench.replaceBuffer("dirty");

    component.handleInput("\x13");
    component.handleInput("\x1b");
    expect(done).not.toHaveBeenCalled();
    expect(component.render(100).join("\n")).toContain("Waiting to close");
    finishSave?.({ status: "success", effect: "saved", revision: "r2" });
    await vi.waitFor(() => expect(done).toHaveBeenCalledWith({ status: "closed", changedPaths: ["src/file.ts"] }));
  });

  it("completes only once when close is requested during a dirty-choice save", async () => {
    let finishSave: ((result: { status: "success"; effect: "saved"; revision: string }) => void) | undefined;
    const { component, done, workbench } = createHarness({
      listFiles: async () => "src/file.ts\0",
      readText: async () => ({ text: "source", revision: "r1" }),
      saveText: async () => new Promise((resolve) => { finishSave = resolve; }),
      maxReadBytes: 1024,
    });
    await workbench.start();
    await workbench.selectFile("src/file.ts");
    workbench.replaceBuffer("dirty");

    component.handleInput("\x1b");
    component.handleInput("s");
    component.handleInput("\x1b");
    expect(component.render(100).join("\n")).toContain("Waiting to close");
    finishSave?.({ status: "success", effect: "saved", revision: "r2" });

    await vi.waitFor(() => expect(done).toHaveBeenCalledOnce());
    expect(done).toHaveBeenCalledWith({ status: "closed", changedPaths: ["src/file.ts"] });
  });

  it("extends NORMAL source ranges and collapses them before INSERT without replacement", async () => {
    const { component, workbench } = createHarness({
      listFiles: async () => "file.ts\0",
      readText: async () => ({ text: "one\ntwo\nthree", revision: "r1" }),
      saveText: async () => ({ status: "success" as const, effect: "saved" as const, revision: "r2" }),
      maxReadBytes: 1024,
    });
    await workbench.start();
    component.handleInput("\x1b[B");
    component.handleInput("\r");
    await vi.waitFor(() => expect(workbench.selectedPath).toBe("file.ts"));

    component.handleInput("\x1b[1;2B");
    component.handleInput("\x1b[1;2B");
    expect(workbench.selectedRange).toEqual({ startLine: 1, endLine: 3 });
    component.handleInput("\x1b[A");
    expect(workbench.selectedRange).toEqual({ startLine: 2, endLine: 2 });

    component.handleInput("\x1b[1;2B");
    expect(workbench.selectedRange).toEqual({ startLine: 2, endLine: 3 });
    component.handleInput("i");
    expect(workbench.selectedRange).toEqual({ startLine: 3, endLine: 3 });
    component.handleInput("!");
    component.handleInput("\x1a");
    component.handleInput("\x1b");
    expect(workbench.bufferText).toBe("one\ntwo\nthree");
    expect(workbench.selectedRange).toEqual({ startLine: 3, endLine: 3 });
  });

  it("activates ordered stories with a bounded card and immutable stale anchor", async () => {
    const story = { id: "first", target: { path: "file.ts", range: { startLine: 1, endLine: 2 } }, prose: "short prose" };
    const { component: launched, workbench } = createHarness({
      listFiles: async () => "file.ts\0",
      readText: async () => ({ text: "one\ntwo\nthree", revision: "r1" }),
      saveText: async () => ({ status: "error" as const, message: "unused" }),
      maxReadBytes: 1024,
    }, 24, undefined, { stories: [story] });
    await workbench.start();
    await workbench.selectFile("file.ts");
    launched.handleInput("\x1b[1;3C");
    launched.handleInput("]");
    await vi.waitFor(() => expect(workbench.selectedRange).toEqual({ startLine: 1, endLine: 2 }));
    const card = launched.render(80).join("\n");
    expect(card).toContain("Story 1/1");
    expect(card).toContain("short prose");
    workbench.replaceBuffer("changed\ntwo\nthree");
    launched.handleInput("i"); launched.handleInput("!"); launched.handleInput("\x1b");
    expect(launched.render(80).join("\n")).toContain("stale");
    expect(story.target.range).toEqual({ startLine: 1, endLine: 2 });
  });

  it("blocks story activation input until a deferred target settles", async () => {
    vi.useFakeTimers();
    try {
      const sourceA = "A source that must remain unchanged";
      const sourceB = `B${"x".repeat(64 * 1024 + 1)}`;
      let resolveB: ((snapshot: { text: string; revision: string }) => void) | undefined;
      const highlight = vi.fn(async (_path: string, text: string) => text.split(/\r\n|\r|\n/));
      const readText = vi.fn(async (path: string) => {
        if (path === "b.ts") return new Promise<{ text: string; revision: string }>((resolve) => { resolveB = resolve; });
        return { text: sourceA, revision: "a:r1" };
      });
      const { component, workbench } = createHarness({
        listFiles: async () => "a.ts\0b.ts\0",
        readText,
        saveText: async () => ({ status: "error" as const, message: "unused" }),
        sourceHighlighter: { highlight },
        maxReadBytes: 128 * 1024,
      }, 24, undefined, {
        stories: [{ id: "deferred", target: { path: "b.ts", range: { startLine: 1, endLine: 1 } }, prose: "deferred" }],
      });
      const settle = async () => { for (let index = 0; index < 10; index += 1) await Promise.resolve(); };

      await workbench.start();
      await workbench.selectFile("a.ts");
      component.handleInput("\x1b[1;3C");
      component.handleInput("]");
      expect(resolveB).toBeTypeOf("function");
      expect(component.render(100).join("\n")).toContain("BUSY SOURCE");
      expect(workbench.selectedPath).toBe("a.ts");
      expect(workbench.bufferText).toBe(sourceA);

      component.handleInput("i");
      component.handleInput("!");
      component.handleInput("]");
      expect(component.render(100).join("\n")).toContain("BUSY SOURCE");
      expect(workbench.bufferText).toBe(sourceA);
      expect(readText).toHaveBeenCalledTimes(2);

      resolveB?.({ text: sourceB, revision: "b:r1" });
      await settle();
      expect(workbench.selectedPath).toBe("b.ts");
      expect(workbench.bufferText).toBe(sourceB);
      expect(workbench.selectedRange).toEqual({ startLine: 1, endLine: 1 });
      expect(component.render(100).join("\n")).toContain("NORMAL SOURCE");
      expect(component.render(100).join("\n")).toContain("B");

      await vi.advanceTimersByTimeAsync(101);
      await settle();
      expect(highlight.mock.calls.filter(([path]) => path === "b.ts")).toHaveLength(1);

      component.handleInput("i");
      const insertView = component.render(100).join("\n");
      expect(insertView).toContain("INSERT SOURCE  b.ts");
      expect(insertView).toContain("x");
      expect(insertView).not.toContain(sourceA);
      expect(workbench.selectedLine).toBe(1);
      component.handleInput("!");
      expect(workbench.bufferText).toBe(`${sourceB}!`);
      expect(workbench.selectedPath).toBe("b.ts");
      expect(workbench.selectedLine).toBe(1);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("stops story navigation at both ends and preserves a pending story across save retry", async () => {
    const saveText = vi.fn()
      .mockResolvedValueOnce({ status: "conflict" as const, message: "save conflict" })
      .mockResolvedValueOnce({ status: "success" as const, effect: "saved" as const, revision: "r2" });
    const { component, tui, workbench } = createHarness({
      listFiles: async () => "current.ts\0next.ts\0",
      readText: async (path) => ({ text: `${path}\nnext`, revision: `r:${path}` }),
      saveText,
      maxReadBytes: 1024,
    }, 24, undefined, {
      stories: [
        { id: "first", target: { path: "current.ts", range: { startLine: 1, endLine: 1 } }, prose: "first" },
        { id: "second", target: { path: "next.ts", range: { startLine: 1, endLine: 1 } }, prose: "second" },
      ],
    });
    await workbench.start();
    await workbench.selectFile("current.ts");
    component.handleInput("\x1b[1;3C");

    component.handleInput("[");
    await vi.waitFor(() => expect(component.render(100).join("\n")).toContain("Already at the first story."));
    expect(workbench.selectedPath).toBe("current.ts");

    component.handleInput("]");
    await vi.waitFor(() => expect(component.render(100).join("\n")).toContain("Story 1/2"));
    component.handleInput("]");
    await vi.waitFor(() => expect(workbench.selectedPath).toBe("next.ts"));
    expect(component.render(100).join("\n")).toContain("Story 2/2");
    component.handleInput("]");
    expect(component.render(100).join("\n")).toContain("Already at the last story.");

    workbench.replaceBuffer("dirty next\nnext");
    component.handleInput("[");
    await vi.waitFor(() => expect(component.render(100).join("\n")).toContain("Save / Discard / Cancel"));
    component.handleInput("s");
    await vi.waitFor(() => expect(component.render(100).join("\n")).toContain("save conflict"));
    expect(workbench.isDirty).toBe(true);
    component.handleInput("s");
    await vi.waitFor(() => expect(workbench.selectedPath).toBe("current.ts"));
    expect(component.render(100).join("\n")).toContain("Story 1/2");
    expect(workbench.isDirty).toBe(false);
    expect(tui.requestRender).toHaveBeenCalled();
  });

  it("resolves pending stories with Discard, Cancel, and a warned Save", async () => {
    const saveText = vi.fn().mockResolvedValue({
      status: "success" as const,
      effect: "saved" as const,
      revision: "r2",
      warning: "cleanup warning",
    });
    const { component, workbench } = createHarness({
      listFiles: async () => "first.ts\0second.ts\0",
      readText: async (path) => ({ text: `${path}\nline`, revision: `r:${path}` }),
      saveText,
      maxReadBytes: 1024,
    }, 24, undefined, {
      stories: [
        { id: "first", target: { path: "first.ts", range: { startLine: 1, endLine: 1 } }, prose: "first" },
        { id: "second", target: { path: "second.ts", range: { startLine: 1, endLine: 1 } }, prose: "second" },
      ],
    });
    await workbench.start();
    await workbench.selectFile("first.ts");
    component.handleInput("\x1b[1;3C");
    component.handleInput("]");
    await vi.waitFor(() => expect(component.render(100).join("\n")).toContain("Story 1/2"));

    workbench.replaceBuffer("dirty first\nline");
    component.handleInput("]");
    await vi.waitFor(() => expect(component.render(100).join("\n")).toContain("Save / Discard / Cancel"));
    component.handleInput("d");
    await vi.waitFor(() => expect(workbench.selectedPath).toBe("second.ts"));
    expect(workbench.isDirty).toBe(false);

    workbench.replaceBuffer("dirty second\nline");
    component.handleInput("[");
    await vi.waitFor(() => expect(component.render(100).join("\n")).toContain("Save / Discard / Cancel"));
    component.handleInput("c");
    await vi.waitFor(() => expect(workbench.pendingAction).toBeNull());
    expect(workbench.selectedPath).toBe("second.ts");
    expect(workbench.bufferText).toBe("dirty second\nline");
    expect(workbench.isDirty).toBe(true);

    component.handleInput("[");
    await vi.waitFor(() => expect(component.render(100).join("\n")).toContain("Save / Discard / Cancel"));
    component.handleInput("s");
    await vi.waitFor(() => expect(workbench.selectedPath).toBe("first.ts"));
    expect(workbench.isDirty).toBe(false);
    expect(component.render(100).join("\n")).toContain("cleanup warning");
  });

  it("keeps missing and unreadable stories from replacing the current buffer", async () => {
    const missing = createHarness({
      listFiles: async () => "current.ts\0",
      readText: async () => ({ text: "current", revision: "r1" }),
      saveText: async () => ({ status: "error" as const, message: "unused" }),
      maxReadBytes: 1024,
    }, 24, undefined, {
      stories: [{ id: "missing", target: { path: "gone.ts", range: { startLine: 1, endLine: 1 } }, prose: "missing" }],
    });
    await missing.workbench.start();
    await missing.workbench.selectFile("current.ts");
    missing.component.handleInput("\x1b[1;3C");
    missing.workbench.replaceBuffer("dirty current");
    missing.component.handleInput("]");
    await vi.waitFor(() => expect(missing.component.render(100).join("\n")).toContain("Target file is not available"));
    expect(missing.workbench.selectedPath).toBe("current.ts");
    expect(missing.workbench.bufferText).toBe("dirty current");
    expect(missing.workbench.isDirty).toBe(true);
    expect(missing.component.render(100).join("\n")).toContain("Story 1/1");

    const unreadable = createHarness({
      listFiles: async () => "current.ts\0bad.ts\0",
      readText: async (path) => {
        if (path === "bad.ts") throw new Error("permission denied");
        return { text: "current", revision: "r1" };
      },
      saveText: async () => ({ status: "error" as const, message: "unused" }),
      maxReadBytes: 1024,
    }, 24, undefined, {
      stories: [{ id: "bad", target: { path: "bad.ts", range: { startLine: 1, endLine: 1 } }, prose: "bad" }],
    });
    await unreadable.workbench.start();
    await unreadable.workbench.selectFile("current.ts");
    unreadable.component.handleInput("\x1b[1;3C");
    unreadable.component.handleInput("]");
    await vi.waitFor(() => expect(unreadable.component.render(100).join("\n")).toContain("permission denied"));
    expect(unreadable.workbench.selectedPath).toBe("current.ts");
    expect(unreadable.workbench.bufferText).toBe("current");
    expect(unreadable.workbench.isDirty).toBe(false);
  });

  it("renders sanitized story prose with an ellipsis and keeps its card in INSERT", async () => {
    const story = {
      id: "unsafe\u001b[31mid",
      target: { path: "file.ts", range: { startLine: 1, endLine: 1 } },
      prose: `${"short ".repeat(200)}\u0007`,
    };
    const { component, workbench } = createHarness({
      listFiles: async () => "file.ts\0",
      readText: async () => ({ text: "source", revision: "r1" }),
      saveText: async () => ({ status: "error" as const, message: "unused" }),
      maxReadBytes: 1024,
    }, 24, undefined, { stories: [story] });
    await workbench.start();
    await workbench.selectFile("file.ts");
    component.handleInput("\x1b[1;3C");
    component.handleInput("]");
    await vi.waitFor(() => expect(component.render(100).join("\n")).toContain("Story 1/1"));
    const controls = /[\u0000-\u001f\u007f-\u009f]/;
    const normalRows = component.render(100).map((row) => row.replace(/\u001b\[[0-9;]*m/g, ""));
    expect(normalRows.join("\n")).toContain("…");
    expect(normalRows.every((row) => !controls.test(row))).toBe(true);

    component.handleInput("i");
    const insert = component.render(100).join("\n");
    expect(insert).toContain("INSERT SOURCE");
    expect(insert).toContain("short");
    expect(insert).toContain("…");
    component.handleInput("]");
    expect(workbench.bufferText).toBe("source]");
  });

  it("keeps story-card presence bounded across representative terminal heights", async () => {
    const { component, tui, workbench } = createHarness({
      listFiles: async () => "file.ts\0",
      readText: async () => ({ text: "source", revision: "r1" }),
      saveText: async () => ({ status: "error" as const, message: "unused" }),
      maxReadBytes: 1024,
    }, 24, undefined, {
      stories: [{ id: "card", target: { path: "file.ts", range: { startLine: 1, endLine: 1 } }, prose: "CARD ".repeat(200) }],
      capabilities: { discuss: true },
    });
    await workbench.start();
    await workbench.selectFile("file.ts");
    component.handleInput("\x1b[1;3C");
    component.handleInput("]");
    await vi.waitFor(() => expect(component.render(80).join("\n")).toContain("Story 1/1"));

    for (const [mode, enter] of [["NORMAL", undefined], ["INSERT", "i"]] as const) {
      if (enter) component.handleInput(enter);
      for (const [terminalRows, hasCard] of [[12, false], [24, true], [32, true]] as const) {
        tui.terminal.rows = terminalRows;
        const rendered = component.render(80);
        expect(rendered.length).toBeLessThanOrEqual(terminalRows);
        expect(rendered.some((line) => line.includes("CARD"))).toBe(hasCard);
      }
      if (mode === "INSERT") component.handleInput("\x1b");
    }

    component.handleInput("d");
    tui.terminal.rows = 24;
    expect(component.render(80).join("\n")).not.toContain("CARD");
  });

  it("keeps a 25k-line story viewport bounded", async () => {
    const text = Array.from({ length: 25_000 }, (_, index) => `line ${index + 1}`).join("\n");
    const { component, workbench } = createHarness({
      listFiles: async () => "large.ts\0",
      readText: async () => ({ text, revision: "r1" }),
      saveText: async () => ({ status: "error" as const, message: "unused" }),
      maxReadBytes: Buffer.byteLength(text, "utf8") + 1,
    }, 24, undefined, {
      stories: [{ id: "large", target: { path: "large.ts", range: { startLine: 24_999, endLine: 25_000 } }, prose: "large" }],
    });
    await workbench.start();
    await workbench.selectFile("large.ts");
    component.handleInput("\x1b[1;3C");
    component.handleInput("]");
    await vi.waitFor(() => expect(workbench.selectedLine).toBe(24_999));
    const rendered = component.render(100);
    expect(rendered.length).toBeLessThanOrEqual(24);
    expect(rendered.every((line) => visibleWidth(line) === 100)).toBe(true);
    expect(rendered.join("\n")).toContain("24999");
  });

  it("keeps story keys isolated in NOTE mode", async () => {
    const { component, workbench } = createHarness({
      listFiles: async () => "file.ts\0",
      readText: async () => ({ text: "source", revision: "r1" }),
      saveText: async () => ({ status: "error" as const, message: "unused" }),
      maxReadBytes: 1024,
    }, 24, undefined, {
      stories: [{ id: "one", target: { path: "file.ts", range: { startLine: 1, endLine: 1 } }, prose: "one" }],
      capabilities: { discuss: true },
    });
    await workbench.start();
    await workbench.selectFile("file.ts");
    component.handleInput("\x1b[1;3C");
    component.handleInput("]");
    await vi.waitFor(() => expect(component.render(80).join("\n")).toContain("Story 1/1"));
    component.handleInput("d");
    expect(component.render(80).join("\n")).toContain("NOTE SOURCE");
    component.handleInput("]");
    expect(workbench.selectedLine).toBe(1);
    expect(workbench.bufferText).toBe("source");
  });

  it("emits a location-only DISCUSS result with a bounded optional note", async () => {
    const { component: discuss, done, workbench } = createHarness({
      listFiles: async () => "file.ts\0",
      readText: async () => ({ text: "one\ntwo", revision: "r1" }),
      saveText: async () => ({ status: "error" as const, message: "unused" }),
      maxReadBytes: 1024,
    }, 24, undefined, { capabilities: { discuss: true } });
    await workbench.start(); await workbench.selectFile("file.ts");
    discuss.handleInput("\x1b[1;3C");
    discuss.handleInput("d");
    discuss.handleInput("n");
    discuss.handleInput("\r");
    expect(done).toHaveBeenCalledWith(expect.objectContaining({ status: "discuss", changedPaths: [], note: "n", target: expect.objectContaining({ path: "file.ts", range: { startLine: 1, endLine: 1 } }) }));
  });

  it("keeps the dirty-choice prompt and buffer after a conflicted save", async () => {
    const { component, done, workbench } = createHarness({
      listFiles: async () => "src/file.ts\0",
      readText: async () => ({ text: "old", revision: "r1" }),
      saveText: async () => ({ status: "conflict", message: "external change" }),
      maxReadBytes: 1024,
    });
    await workbench.start();
    await workbench.selectFile("src/file.ts");
    workbench.replaceBuffer("dirty");

    component.handleInput("\x1b");
    component.handleInput("s");
    await vi.waitFor(() => expect(component.render(100).join("\n")).toContain("external change"));

    expect(component.render(100).join("\n")).toContain("Save / Discard / Cancel");
    expect(workbench.bufferText).toBe("dirty");
    expect(workbench.isDirty).toBe(true);
    expect(done).not.toHaveBeenCalled();
  });

  it("clamps the final DISCUSS range and hashes the post-discard buffer", async () => {
    const { component, done, workbench } = createHarness({
      listFiles: async () => "file.ts\0",
      readText: async () => ({ text: "one\ntwo", revision: "r1" }),
      saveText: async () => ({ status: "error", message: "unused" }),
      maxReadBytes: 1024,
    }, 24, undefined, { capabilities: { discuss: true } });
    await workbench.start();
    await workbench.selectFile("file.ts");
    component.handleInput("\x1b[1;3C");
    workbench.replaceBuffer("one\ntwo\nthree\nfour");
    workbench.setSelectedRange({ startLine: 3, endLine: 4 });

    component.handleInput("d");
    component.handleInput("\r");
    component.handleInput("d");
    await vi.waitFor(() => expect(component.render(100).join("\n")).toContain("Save / Discard / Cancel"));
    component.handleInput("d");

    await vi.waitFor(() => expect(done).toHaveBeenCalledOnce());
    expect(done.mock.calls[0]?.[0]).toMatchObject({
      status: "discuss",
      target: { path: "file.ts", range: { startLine: 2, endLine: 2 } },
    });
    expect(done.mock.calls[0]?.[0]).toMatchObject({ target: { anchor: { algorithm: "sha256", value: "3fc4ccfe745870e2c0d99f71f30ff0656c8dedd41cc1d7d3d376b0dbe685e2f3" } } });
  });

  it("lets a conflicted DISCUSS save retry with discard and keeps the pending handoff", async () => {
    const saveText = vi.fn()
      .mockResolvedValueOnce({ status: "conflict" as const, message: "external change" })
      .mockResolvedValueOnce({ status: "success" as const, effect: "saved" as const, revision: "r2" });
    const { component, done, workbench } = createHarness({
      listFiles: async () => "file.ts\0",
      readText: async () => ({ text: "old", revision: "r1" }),
      saveText,
      maxReadBytes: 1024,
    }, 24, undefined, { capabilities: { discuss: true } });
    await workbench.start();
    await workbench.selectFile("file.ts");
    component.handleInput("\x1b[1;3C");
    workbench.replaceBuffer("dirty");

    component.handleInput("d");
    component.handleInput("n");
    component.handleInput("\r");
    component.handleInput("s");
    await vi.waitFor(() => expect(component.render(100).join("\n")).toContain("external change"));
    component.handleInput("d");

    await vi.waitFor(() => expect(done).toHaveBeenCalledWith(expect.objectContaining({ status: "discuss", note: "n" })));
    expect(workbench.pendingAction).toBeNull();
  });

  it("renders a visible note editor with isolated arrows and Shift+Enter newline", async () => {
    const { component, done, workbench } = createHarness({
      listFiles: async () => "file.ts\0",
      readText: async () => ({ text: "source", revision: "r1" }),
      saveText: async () => ({ status: "error", message: "unused" }),
      maxReadBytes: 1024,
    }, 24, undefined, { capabilities: { discuss: true } });
    await workbench.start();
    await workbench.selectFile("file.ts");
    component.handleInput("\x1b[1;3C");

    component.handleInput("d");
    expect(component.render(100).join("\n")).toContain("NOTE SOURCE");
    component.handleInput("a");
    component.handleInput("\x1b[D");
    component.handleInput("b");
    component.handleInput("\x1b[13;2u");
    component.handleInput("c");
    expect(component.render(100).join("\n")).toContain("b");
    expect(component.render(100).join("\n")).toContain("c");
    component.handleInput("\r");

    expect(done).toHaveBeenCalledWith(expect.objectContaining({ status: "discuss", note: "b\nca" }));
    expect(Object.keys(done.mock.calls[0]?.[0] ?? {})).toEqual(["status", "changedPaths", "target", "note"]);
    expect(done.mock.calls[0]?.[0]).not.toEqual(expect.objectContaining({ note: expect.stringContaining("\x1b[D") }));
  });

  it("gives a clean DISCUSS completion to a latched terminal failure", async () => {
    const { component, done, workbench } = createHarness({
      listFiles: async () => "file.ts\0",
      readText: async () => ({ text: "source", revision: "r1" }),
      saveText: async () => ({ status: "error", message: "unused" }),
      maxReadBytes: 1024,
    }, 24, undefined, { capabilities: { discuss: true } });
    await workbench.start();
    await workbench.selectFile("file.ts");
    component.handleInput("\x1b[1;3C");
    (component as unknown as { terminalFailure: { status: "failed"; message: string; code: string } }).terminalFailure = {
      status: "failed", message: CHILD_CLOSURE_UNCONFIRMED_MESSAGE, code: CHILD_CLOSURE_UNCONFIRMED,
    };

    component.handleInput("d");
    component.handleInput("\r");

    expect(done).toHaveBeenCalledWith({
      status: "failed",
      message: CHILD_CLOSURE_UNCONFIRMED_MESSAGE,
      code: CHILD_CLOSURE_UNCONFIRMED,
    });
  });

  it("clears a cancelled DISCUSS and requires a later explicit d", async () => {
    const { component, done, workbench } = createHarness({
      listFiles: async () => "file.ts\0",
      readText: async () => ({ text: "old", revision: "r1" }),
      saveText: async () => ({ status: "error", message: "unused" }),
      maxReadBytes: 1024,
    }, 24, undefined, { capabilities: { discuss: true } });
    await workbench.start();
    await workbench.selectFile("file.ts");
    component.handleInput("\x1b[1;3C");
    workbench.replaceBuffer("dirty");

    component.handleInput("d");
    component.handleInput("first");
    component.handleInput("\r");
    component.handleInput("c");
    await vi.waitFor(() => expect(workbench.pendingAction).toBeNull());
    expect(done).not.toHaveBeenCalled();

    component.handleInput("d");
    component.handleInput("second");
    component.handleInput("\r");
    component.handleInput("d");
    await vi.waitFor(() => expect(done).toHaveBeenCalledWith(expect.objectContaining({ status: "discuss", note: "second" })));
  });

  it("clears a warned DISCUSS and requires a later explicit d", async () => {
    const saveText = vi.fn().mockResolvedValue({ status: "success" as const, effect: "saved" as const, revision: "r2", warning: "cleanup warning" });
    const { component, done, workbench } = createHarness({
      listFiles: async () => "file.ts\0",
      readText: async () => ({ text: "old", revision: "r1" }),
      saveText,
      maxReadBytes: 1024,
    }, 24, undefined, { capabilities: { discuss: true } });
    await workbench.start();
    await workbench.selectFile("file.ts");
    component.handleInput("\x1b[1;3C");
    workbench.replaceBuffer("dirty");

    component.handleInput("d");
    component.handleInput("first");
    component.handleInput("\r");
    component.handleInput("s");
    await vi.waitFor(() => expect(component.render(100).join("\n")).toContain("cleanup warning"));
    expect(done).not.toHaveBeenCalled();

    workbench.replaceBuffer("dirty again");
    component.handleInput("d");
    component.handleInput("second");
    component.handleInput("\r");
    component.handleInput("d");
    await vi.waitFor(() => expect(done).toHaveBeenCalledWith(expect.objectContaining({ status: "discuss", note: "second" })));
  });
});
