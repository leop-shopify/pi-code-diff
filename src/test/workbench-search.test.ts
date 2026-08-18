import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createWorkbench } from "../workbench/app.js";
import { parseRgJsonResults, findDeclarationSymbols } from "../workbench/navigator.js";
import { buildGitGrepInvocation, parseGitGrepNullResults, searchRepositorySymbols, searchRepositoryText, streamBoundedMatches, withNodeSourceSearch, type CommandRunner, type SpawnCommand, type SpawnProcess } from "../workbench/node/repository.js";

function productionSearchWith(spawnProcess: SpawnProcess) {
  return withNodeSourceSearch({
    listFiles: async () => "",
    readText: async () => ({ text: "", revision: "unused" }),
    saveText: async () => ({ status: "error", message: "unused" }),
    maxReadBytes: 1,
  }, "/repo", spawnProcess).searchText!;
}

function productionSymbolsWith(spawnProcess: SpawnProcess) {
  return withNodeSourceSearch({
    listFiles: async () => "",
    readText: async () => ({ text: "", revision: "unused" }),
    saveText: async () => ({ status: "error", message: "unused" }),
    maxReadBytes: 1,
  }, "/repo", spawnProcess).searchSymbols!;
}

describe("workbench source search", () => {
  it("parses ripgrep JSON matches and caps results at 200", () => {
    const line = (number: number) => JSON.stringify({ type: "match", data: { path: { text: `src/${number}.ts` }, lines: { text: `needle ${number}\n` }, line_number: number, submatches: [{ start: 0, end: 6 }] } });
    const results = parseRgJsonResults(Array.from({ length: 201 }, (_, index) => line(index + 1)).join("\n"));

    expect(results).toHaveLength(200);
    expect(results[0]).toEqual({ path: "src/1.ts", line: 1, column: 1, text: "needle 1" });
  });

  it("preserves capped output when kill errors synchronously but close is confirmed", async () => {
    const killError = Object.assign(new Error("kill EPERM"), { code: "EPERM" });
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => { child.emit("error", killError); child.emit("close", 0); return false; }),
    });
    const spawn: SpawnCommand = vi.fn(() => child as never);
    const pending = streamBoundedMatches(spawn, "rg", [], new AbortController().signal, (line) => parseRgJsonResults(line, 1)[0] ?? null);
    for (let index = 1; index <= 201; index += 1) child.stdout.write(JSON.stringify({ type: "match", data: { path: { text: `src/${index}.ts` }, lines: { text: "needle\\n" }, line_number: index } }) + "\n");
    await expect(pending).resolves.toMatchObject({ capped: true, results: Array.from({ length: 200 }, () => expect.anything()) });
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("waits for close and then rejects the original child error", async () => {
    const originalError = Object.assign(new Error("spawn EACCES"), { code: "EACCES" });
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => true),
    });
    const pending = streamBoundedMatches(() => child as never, "rg", [], new AbortController().signal, () => null);
    let settled = false;
    const observed = pending.then(
      (value) => { settled = true; return value; },
      (error: unknown) => { settled = true; throw error; },
    );
    const rejected = expect(observed).rejects.toBe(originalError);

    child.emit("error", originalError);
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");

    child.emit("close", null);
    await rejected;
  });

  it("escalates streaming timeout and cancellation to SIGKILL before settling", async () => {
    vi.useFakeTimers();
    const ignoringChild = () => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: vi.fn((signal: NodeJS.Signals) => { if (signal === "SIGKILL") child.emit("close", null); return true; }),
      });
      return child;
    };
    const child = ignoringChild();
    const timeout = streamBoundedMatches(() => child as never, "rg", [], new AbortController().signal, () => null, 10, 256, 5);
    const timedOut = expect(timeout).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(10);
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    await vi.advanceTimersByTimeAsync(5);
    await timedOut;
    expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);

    const abortedChild = ignoringChild();
    const controller = new AbortController();
    const aborted = streamBoundedMatches(() => abortedChild as never, "rg", [], controller.signal, () => null, 100, 256, 5);
    const rejected = expect(aborted).rejects.toThrow("cancelled");
    controller.abort(new Error("cancelled"));
    expect(abortedChild.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    await vi.advanceTimersByTimeAsync(5);
    await rejected;
    expect(abortedChild.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
    vi.useRealTimers();
  });

  it("caps UTF-8 stdout bytes even when a record never terminates", async () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn((signal: NodeJS.Signals) => { if (signal === "SIGKILL") child.emit("close", null); return true; }),
    });
    const pending = streamBoundedMatches(() => child as never, "rg", [], new AbortController().signal, () => null, 100, 16, 5);
    child.stdout.write("🙂".repeat(5));
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    await vi.advanceTimersByTimeAsync(5);
    await expect(pending).resolves.toMatchObject({ results: [], capped: true, capReason: "stdout" });
    expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
    vi.useRealTimers();
  });

  it("rejects oversized unterminated production rg output without spawning fallback", async () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => { child.emit("close", 0); return true; }),
    });
    const spawnProcess: SpawnProcess = vi.fn(() => child as never);
    const pending = productionSearchWith(spawnProcess)("untracked needle", new AbortController().signal);

    child.stdout.write("x".repeat(256 * 1024 + 1));

    await expect(pending).rejects.toThrow("rg search output exceeded its byte limit.");
    expect(spawnProcess).toHaveBeenCalledOnce();
  });

  it("propagates unconfirmed production rg closure after a synchronous kill error without spawning fallback", async () => {
    vi.useFakeTimers();
    try {
      const killError = Object.assign(new Error("kill EPERM"), { code: "EPERM" });
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: vi.fn((signal: NodeJS.Signals) => { if (signal === "SIGTERM") child.emit("error", killError); return false; }),
      });
      const spawnProcess: SpawnProcess = vi.fn(() => child as never);
      const pending = productionSearchWith(spawnProcess)("needle", new AbortController().signal);
      let settled = false;
      const observed = pending.then(
        (value) => { settled = true; return value; },
        (error: unknown) => { settled = true; throw error; },
      );
      const rejected = expect(observed).rejects.toMatchObject({ code: "CHILD_CLOSURE_UNCONFIRMED" });

      child.stdout.write("x".repeat(256 * 1024 + 1));
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
      await vi.advanceTimersByTimeAsync(100);
      expect(settled).toBe(false);
      expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
      await vi.advanceTimersByTimeAsync(100);

      await rejected;
      expect(spawnProcess).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back after a confirmed rg exit 2 through the exact hermetic git-grep spawn", async () => {
    const rg = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
    const git = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
    const spawnProcess: SpawnProcess = vi.fn()
      .mockImplementationOnce(() => { queueMicrotask(() => rg.emit("close", 2)); return rg as never; })
      .mockImplementationOnce(() => {
        queueMicrotask(() => {
          git.stdout.write(["src/a.ts", "7", "needle\n"].join("\0"));
          git.emit("close", 0);
        });
        return git as never;
      });

    await expect(productionSearchWith(spawnProcess)("needle", new AbortController().signal)).resolves.toEqual({
      results: [{ path: "src/a.ts", line: 7, column: 1, text: "needle" }],
      coverage: "tracked-only",
    });
    expect(spawnProcess).toHaveBeenCalledTimes(2);
    expect(spawnProcess).toHaveBeenNthCalledWith(
      2,
      "git",
      ["-c", "core.fsmonitor=false", "grep", "-n", "-I", "-z", "--fixed-strings", "--", "needle"],
      expect.objectContaining({
        cwd: "/repo",
        stdio: ["ignore", "pipe", "pipe"],
        env: expect.objectContaining({ GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat", GIT_TERMINAL_PROMPT: "0" }),
      }),
    );
  });

  it("retains injectable text search with bounded-compatible fallback semantics", async () => {
    const run: CommandRunner = vi.fn()
      .mockResolvedValueOnce({ stdout: "", stderr: "rg missing", exitCode: 2 })
      .mockResolvedValueOnce({ stdout: ["src/a.ts", "7", "needle\n"].join("\0"), stderr: "", exitCode: 0 });

    await expect(searchRepositoryText(run, "needle", new AbortController().signal)).resolves.toEqual({
      results: [{ path: "src/a.ts", line: 7, column: 1, text: "needle" }], coverage: "tracked-only",
    });
    expect(run).toHaveBeenNthCalledWith(1, "rg", ["--no-config", "--no-pre", "--json", "--fixed-strings", "--", "needle"], expect.any(AbortSignal));
    expect(run).toHaveBeenLastCalledWith("git", ["grep", "-n", "-I", "-z", "--fixed-strings", "--", "needle"], expect.any(AbortSignal));
  });

  it("retains injectable symbol search and propagates runner cancellation", async () => {
    const cancelled = new Error("cancelled");
    const run: CommandRunner = vi.fn(async (_command, _args, signal) => {
      if (signal.aborted) throw signal.reason;
      return { stdout: "", stderr: "", exitCode: 1 };
    });
    const controller = new AbortController();

    await expect(searchRepositorySymbols(run, "   ", controller.signal)).resolves.toEqual([]);
    controller.abort(cancelled);
    await expect(searchRepositorySymbols(run, "thing", controller.signal)).rejects.toBe(cancelled);
    expect(run).toHaveBeenCalledExactlyOnceWith("rg", expect.any(Array), controller.signal);
  });

  it("uses exact config-free ripgrep arguments and preserves empty-query behavior", async () => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
    const spawnProcess: SpawnProcess = vi.fn(() => { queueMicrotask(() => child.emit("close", 1)); return child as never; });
    const search = productionSearchWith(spawnProcess);

    await expect(search("needle", new AbortController().signal)).resolves.toEqual({ results: [], coverage: "working-tree" });
    expect(spawnProcess).toHaveBeenCalledExactlyOnceWith("rg", ["--no-config", "--no-pre", "--json", "--fixed-strings", "--", "needle"], expect.objectContaining({ cwd: "/repo" }));
    await expect(search("   ", new AbortController().signal)).resolves.toEqual({ results: [], coverage: "working-tree" });
    expect(spawnProcess).toHaveBeenCalledOnce();
  });

  it("reports a failure when bounded fallback git grep exits at least 2", async () => {
    const rg = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
    const git = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
    const spawnProcess: SpawnProcess = vi.fn()
      .mockImplementationOnce(() => { queueMicrotask(() => rg.emit("close", 2)); return rg as never; })
      .mockImplementationOnce(() => { queueMicrotask(() => { git.stderr.write("git failed"); git.emit("close", 2); }); return git as never; });

    await expect(productionSearchWith(spawnProcess)("needle", new AbortController().signal)).rejects.toThrow("git grep failed");
  });

  it("refuses stale or cancelled searches from overwriting a newer query", async () => {
    let finishFirst!: (value: { results: { path: string; line: number; column: number; text: string }[]; coverage: "working-tree" }) => void;
    const searchText = vi.fn((query: string) => query === "first"
      ? new Promise<typeof finishFirst extends (value: infer T) => void ? T : never>((resolve) => { finishFirst = resolve; })
      : Promise.resolve({ results: [{ path: "new.ts", line: 1, column: 1, text: "second" }], coverage: "working-tree" as const }));
    const workbench = createWorkbench({
      listFiles: async () => "old.ts\0new.ts\0",
      readText: async (path) => ({ text: path, revision: `revision:${path}` }),
      saveText: async () => ({ status: "error", message: "not used" }),
      searchText,
      maxReadBytes: 10,
    });
    await workbench.start();

    const first = workbench.searchText("first");
    await workbench.searchText("second");
    finishFirst({ results: [{ path: "old.ts", line: 1, column: 1, text: "first" }], coverage: "working-tree" });
    await first;

    expect(workbench.searchQuery).toBe("second");
    expect(workbench.searchResults).toEqual([{ path: "new.ts", line: 1, column: 1, text: "second" }]);
  });

  it("opens only the file selected from source search results", async () => {
    const readText = vi.fn(async (path: string) => ({ text: path, revision: `revision:${path}` }));
    const workbench = createWorkbench({
      listFiles: async () => "one.ts\0two.ts\0",
      readText,
      saveText: async () => ({ status: "error", message: "not used" }),
      searchText: async () => ({ results: [{ path: "two.ts", line: 4, column: 1, text: "needle" }], coverage: "working-tree" }),
      maxReadBytes: 10,
    });
    await workbench.start();
    await workbench.searchText("needle");
    await workbench.selectSearchResult(0);

    expect(readText).toHaveBeenCalledExactlyOnceWith("two.ts", 10);
    expect(workbench.selectedPath).toBe("two.ts");
  });

  it("parses NUL-delimited git-grep results without confusing colons or newlines in paths", () => {
    const output = ["src/a:b\nc.ts", "7", "needle: value\n"].join("\0");

    expect(parseGitGrepNullResults(output)).toEqual([
      { path: "src/a:b\nc.ts", line: 7, column: 1, text: "needle: value" },
    ]);
  });


  it("searches declarations through bounded ripgrep and preserves empty-query behavior", async () => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
    const spawnProcess: SpawnProcess = vi.fn(() => {
      queueMicrotask(() => {
        child.stdout.write(JSON.stringify({ type: "match", data: { path: { text: "src/a.ts" }, lines: { text: "export function findThing() {}\n" }, line_number: 2, submatches: [{ start: 0 }] } }) + "\n");
        child.emit("close", 0);
      });
      return child as never;
    });
    const symbols = productionSymbolsWith(spawnProcess);

    await expect(symbols("find", new AbortController().signal)).resolves.toEqual([
      { path: "src/a.ts", line: 2, column: 17, text: "export function findThing() {}", name: "findThing" },
    ]);
    expect(spawnProcess).toHaveBeenCalledExactlyOnceWith("rg", ["--no-config", "--no-pre", "--json", "-I", "--regexp", "find", "--glob", "*.ts", "--glob", "*.tsx", "--glob", "*.js", "--glob", "*.jsx", "--glob", "*.rb", "--glob", "*.py"], expect.objectContaining({ cwd: "/repo" }));
    await expect(symbols("   ", new AbortController().signal)).resolves.toEqual([]);
    expect(spawnProcess).toHaveBeenCalledOnce();
  });

  it("opens only the selected query-time symbol file", async () => {
    const readText = vi.fn(async (path: string) => ({ text: path, revision: `revision:${path}` }));
    const workbench = createWorkbench({
      listFiles: async () => "one.ts\0two.rb\0",
      readText,
      saveText: async () => ({ status: "error", message: "not used" }),
      searchSymbols: async () => [{ path: "two.rb", line: 3, column: 1, text: "def thing", name: "thing" }],
      maxReadBytes: 10,
    });
    await workbench.start();
    await workbench.searchSymbols("thing");
    await workbench.selectSymbol(0);
    expect(readText).toHaveBeenCalledExactlyOnceWith("two.rb", 10);
  });

  it.each([
    ["src/a.ts", "export class Thing {}\nfunction makeIt() {}", [{ name: "Thing", line: 1 }, { name: "makeIt", line: 2 }]],
    ["src/a.js", "const makeIt = () => {}", [{ name: "makeIt", line: 1 }]],
    ["app/a.rb", "class Thing\n  def make_it\n  end\nend", [{ name: "Thing", line: 1 }, { name: "make_it", line: 2 }]],
    ["app/a.py", "class Thing:\n    def make_it(self):\n        pass", [{ name: "Thing", line: 1 }, { name: "make_it", line: 2 }]],
  ])("finds declaration symbols in %s", (path, source, expected) => {
    expect(findDeclarationSymbols(path, source).map(({ name, line }) => ({ name, line }))).toEqual(expected);
  });
});
