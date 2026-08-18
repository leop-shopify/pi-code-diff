import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createWorkbench } from "../workbench/app.js";
import { CHILD_CLOSURE_UNCONFIRMED } from "../workbench/contracts.js";
import { parseGitBranch, parseGitLog, parsePorcelainStatus, type GitContext } from "../workbench/git.js";
import { buildReadOnlyGitInvocation, createGitCommand, loadNodeGitContext, type GitCommand, type GitCommandResult } from "../workbench/node/git-context.js";

const FILTER_CONFIG_ARGS = ["config", "--null", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|smudge|process|required)$"] as const;
const STATUS_ARGS = ["status", "--porcelain=v1", "-z", "--untracked-files=normal", "--ignore-submodules=all"] as const;
const DIFF_ARGS = ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--unified=3", "--ignore-submodules=all", "--", "."] as const;

function semanticGitCommand(args: readonly string[]): string | undefined {
  let index = 0;
  while (args[index] === "-c") index += 2;
  return args[index];
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(reason: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe("workbench Git context", () => {
  it("parses symbolic and detached HEAD branch representations", () => {
    expect(parseGitBranch("feature/one\n", "a1b2c3d4\n")).toEqual({ kind: "branch", name: "feature/one" });
    expect(parseGitBranch("", "a1b2c3d4\n")).toEqual({ kind: "detached", head: "a1b2c3d4" });
  });

  it("parses porcelain -z statuses, unusual paths, and rename origins", () => {
    expect(parsePorcelainStatus(" M src/a\nb.ts\0R  new name.ts\0old name.ts\0?? odd\u0007name\0")).toEqual([
      { index: " ", worktree: "M", path: "src/a\nb.ts" },
      { index: "R", worktree: " ", path: "new name.ts", originalPath: "old name.ts" },
      { index: "?", worktree: "?", path: "odd\u0007name" },
    ]);
  });

  it("parses bounded recent commit records", () => {
    expect(parseGitLog("abcdef1\0subject one\0abcdef2\0subject two\0", 1)).toEqual([{ shortHash: "abcdef1", subject: "subject one" }]);
  });

  it("inspects the exact filter command-key vector before exact read-only Git invocations", async () => {
    const run: GitCommand = vi.fn(async (_args) => ({ stdout: "", stderr: "", exitCode: 1, capped: false }));
    await expect(loadNodeGitContext(run, new AbortController().signal)).resolves.toMatchObject({
      branch: { kind: "detached", head: "unknown" }, status: [], commits: [], diff: "",
    });
    expect(vi.mocked(run).mock.calls[0]?.[0]).toEqual(FILTER_CONFIG_ARGS);
    for (const [args] of vi.mocked(run).mock.calls) {
      expect(["config", "symbolic-ref", "rev-parse", "status", "log", "diff"]).toContain(semanticGitCommand(args));
      expect(args).not.toEqual(expect.arrayContaining(["add", "commit", "checkout", "switch", "reset", "clean", "fetch", "push"]));
    }

    const spawn = vi.fn();
    const command = createGitCommand(spawn as never);
    const signal = new AbortController().signal;
    await expect(command(["diff", "--output=/tmp/not-read-only"], signal)).rejects.toThrow("not allowlisted");
    await expect(command(["config", "--null", "--name-only", "--get-regexp", "^filter\\..*\\.clean$"], signal)).rejects.toThrow("not allowlisted");
    await expect(command(["-c", "filter.lfs.clean=echo unsafe", ...STATUS_ARGS], signal)).rejects.toThrow("not allowlisted");
    expect(spawn).not.toHaveBeenCalled();

    const statusInvocation = buildReadOnlyGitInvocation("/repo", STATUS_ARGS);
    expect(statusInvocation.args).toEqual(["-c", "core.fsmonitor=false", ...STATUS_ARGS]);
    const configInvocation = buildReadOnlyGitInvocation("/repo", FILTER_CONFIG_ARGS);
    expect(configInvocation.args).toEqual(["-c", "core.fsmonitor=false", ...FILTER_CONFIG_ARGS]);
    expect(configInvocation.options.env).toMatchObject({
      GIT_NO_LAZY_FETCH: "1",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_PAGER: "cat",
      GIT_TERMINAL_PROMPT: "0",
    });
  });

  it("generates only validated passthrough filter overrides for status and diff", async () => {
    const run: GitCommand = vi.fn(async (args) => {
      switch (semanticGitCommand(args)) {
        case "config":
          return {
            stdout: "filter.zed.required\0filter.lfs.clean\0filter.lfs.process\0filter.zed.smudge\0filter.lfs.clean\0",
            stderr: "",
            exitCode: 0,
            capped: false,
          };
        case "symbolic-ref": return { stdout: "main\n", stderr: "", exitCode: 0, capped: false };
        case "rev-parse": return { stdout: "abc1234\n", stderr: "", exitCode: 0, capped: false };
        default: return { stdout: "", stderr: "", exitCode: 0, capped: false };
      }
    });

    await loadNodeGitContext(run, new AbortController().signal);

    const overrides = [
      "-c", "filter.lfs.clean=",
      "-c", "filter.lfs.smudge=",
      "-c", "filter.lfs.process=",
      "-c", "filter.lfs.required=false",
      "-c", "filter.zed.clean=",
      "-c", "filter.zed.smudge=",
      "-c", "filter.zed.process=",
      "-c", "filter.zed.required=false",
    ];
    const calls = vi.mocked(run).mock.calls.map(([args]) => args);
    expect(calls.find((args) => semanticGitCommand(args) === "status")).toEqual([...overrides, ...STATUS_ARGS]);
    expect(calls.find((args) => semanticGitCommand(args) === "diff")).toEqual([...overrides, ...DIFF_ARGS]);
    expect(calls.find((args) => semanticGitCommand(args) === "log")?.[0]).toBe("log");

    const invocation = buildReadOnlyGitInvocation("/repo", [...overrides, ...DIFF_ARGS]);
    expect(invocation.args).toEqual(["-c", "core.fsmonitor=false", ...overrides, ...DIFF_ARGS]);
  });

  it.each([
    ["capped", { stdout: "filter.lfs.clean\0", stderr: "", exitCode: 0, capped: true }],
    ["malformed", { stdout: "filter.lfs.clean", stderr: "", exitCode: 0, capped: false }],
    ["nonzero", { stdout: "", stderr: "failed", exitCode: 2, capped: false }],
  ])("refuses %s filter config inspection before any other Git command", async (_label, result) => {
    const run: GitCommand = vi.fn(async () => result);
    await expect(loadNodeGitContext(run, new AbortController().signal)).rejects.toThrow("filter configuration");
    expect(run).toHaveBeenCalledTimes(1);
    expect(vi.mocked(run).mock.calls[0]?.[0]).toEqual(FILTER_CONFIG_ARGS);
  });

  it("rejects unsafe filter config keys instead of skipping their drivers", async () => {
    const run: GitCommand = vi.fn(async () => ({ stdout: "filter.bad=driver.clean\0", stderr: "", exitCode: 0, capped: false }));
    await expect(loadNodeGitContext(run, new AbortController().signal)).rejects.toThrow("unsafe filter configuration key");
    expect(run).toHaveBeenCalledTimes(1);
    expect(vi.mocked(run).mock.calls[0]?.[0]).toEqual(FILTER_CONFIG_ARGS);
  });

  it("bounds output and escalates Git timeout or cancellation before settling", async () => {
    vi.useFakeTimers();
    const cappedKillError = Object.assign(new Error("kill EPERM"), { code: "EPERM" });
    const cappedChild = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => { cappedChild.emit("error", cappedKillError); cappedChild.emit("close", null); return false; }),
    });
    const command = createGitCommand(() => cappedChild as never, 10, 32, 5);
    const pending = command(DIFF_ARGS, new AbortController().signal);
    cappedChild.stdout.write("🙂".repeat(20));
    const capped = await pending;
    expect(capped).toMatchObject({ capped: true, exitCode: 2 });
    expect(Buffer.byteLength(capped.stdout, "utf8")).toBeLessThanOrEqual(32);
    expect(capped.stdout).toBe("🙂".repeat(8));
    expect(cappedChild.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");

    const ignoringChild = () => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: vi.fn((signal: NodeJS.Signals) => { if (signal === "SIGKILL") child.emit("close", 0); return true; }),
      });
      return child;
    };
    const slow = ignoringChild();
    const timed = createGitCommand(() => slow as never, 10, 32, 5)(STATUS_ARGS, new AbortController().signal);
    const rejection = expect(timed).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(10);
    expect(slow.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    await vi.advanceTimersByTimeAsync(5);
    await rejection;
    expect(slow.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);

    const cancellable = ignoringChild();
    const controller = new AbortController();
    const cancelled = createGitCommand(() => cancellable as never, 100, 32, 5)(["log", "-20", "--format=%h%x00%s%x00"], controller.signal);
    const aborted = expect(cancelled).rejects.toThrow("cancelled");
    controller.abort(new Error("cancelled"));
    expect(cancellable.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    await vi.advanceTimersByTimeAsync(5);
    await aborted;
    expect(cancellable.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
    vi.useRealTimers();
  });

  it("keeps a kill error pending through escalation and rejects unconfirmed closure with the stable code", async () => {
    vi.useFakeTimers();
    try {
      const killError = Object.assign(new Error("kill EPERM"), { code: "EPERM" });
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: vi.fn((signal: NodeJS.Signals) => { if (signal === "SIGTERM") child.emit("error", killError); return false; }),
      });
      const controller = new AbortController();
      const pending = createGitCommand(() => child as never, 100, 32, 5)(STATUS_ARGS, controller.signal);
      let settled = false;
      const observed = pending.then(
        (value) => { settled = true; return value; },
        (error: unknown) => { settled = true; throw error; },
      );
      const rejected = expect(observed).rejects.toMatchObject({ code: CHILD_CLOSURE_UNCONFIRMED });

      controller.abort(new Error("cancelled"));
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
      await vi.advanceTimersByTimeAsync(5);
      expect(settled).toBe(false);
      expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
      await vi.advanceTimersByTimeAsync(5);

      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels and joins parallel Git-context siblings before reporting a command failure", async () => {
    const siblingSignals: AbortSignal[] = [];
    const run: GitCommand = vi.fn((args, signal): Promise<GitCommandResult> => {
      if (semanticGitCommand(args) === "config") return Promise.resolve({ stdout: "", stderr: "", exitCode: 1, capped: false });
      if (semanticGitCommand(args) === "symbolic-ref") return Promise.resolve({ stdout: "main\n", stderr: "", exitCode: 0, capped: false });
      if (semanticGitCommand(args) === "rev-parse") return Promise.resolve({ stdout: "abc1234\n", stderr: "", exitCode: 0, capped: false });
      if (semanticGitCommand(args) === "status") return Promise.reject(new Error("status failed"));
      siblingSignals.push(signal);
      return new Promise<GitCommandResult>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    });

    await expect(loadNodeGitContext(run, new AbortController().signal)).rejects.toThrow("status failed");

    expect(siblingSignals).toHaveLength(2);
    expect(siblingSignals.every((signal) => signal.aborted)).toBe(true);
  });

  it("joins every Git-context sibling and prioritizes a late unconfirmed child closure", async () => {
    const status = deferred<GitCommandResult>();
    const log = deferred<GitCommandResult>();
    const diff = deferred<GitCommandResult>();
    const groupStarted = deferred<void>();
    const logAborted = deferred<void>();
    let groupCallCount = 0;
    const markGroupCall = () => {
      groupCallCount += 1;
      if (groupCallCount === 3) groupStarted.resolve();
    };
    const run: GitCommand = vi.fn((args, signal): Promise<GitCommandResult> => {
      switch (semanticGitCommand(args)) {
        case "config": return Promise.resolve({ stdout: "", stderr: "", exitCode: 1, capped: false });
        case "symbolic-ref": return Promise.resolve({ stdout: "main\n", stderr: "", exitCode: 0, capped: false });
        case "rev-parse": return Promise.resolve({ stdout: "abc1234\n", stderr: "", exitCode: 0, capped: false });
        case "status": markGroupCall(); return status.promise;
        case "log":
          markGroupCall();
          signal.addEventListener("abort", () => {
            log.reject(signal.reason);
            logAborted.resolve();
          }, { once: true });
          return log.promise;
        default: markGroupCall(); return diff.promise;
      }
    });

    const pending = loadNodeGitContext(run, new AbortController().signal);
    let settled = false;
    const rejection = expect(pending.catch((error: unknown) => {
      settled = true;
      throw error;
    })).rejects.toMatchObject({ code: CHILD_CLOSURE_UNCONFIRMED });
    await groupStarted.promise;

    const firstFailure = new Error("status failed");
    status.reject(firstFailure);
    await logAborted.promise;
    expect(settled).toBe(false);

    const terminalFailure = Object.assign(new Error("unconfirmed child closure"), { code: CHILD_CLOSURE_UNCONFIRMED });
    diff.reject(terminalFailure);
    await rejection;
  });

  it("retains and labels partial metadata and diff when Git is terminated at an output cap", async () => {
    const run: GitCommand = vi.fn(async (args) => {
      if (semanticGitCommand(args) === "config") return { stdout: "", stderr: "", exitCode: 1, capped: false };
      if (semanticGitCommand(args) === "symbolic-ref") return { stdout: "feature/capped\n", stderr: "", exitCode: 0, capped: false };
      if (semanticGitCommand(args) === "rev-parse") return { stdout: "abc1234\n", stderr: "", exitCode: 0, capped: false };
      if (semanticGitCommand(args) === "status") return { stdout: " M src/file.ts\0", stderr: "", exitCode: 2, capped: true };
      if (semanticGitCommand(args) === "log") return { stdout: "abc1234\0subject\0", stderr: "", exitCode: 2, capped: true };
      return { stdout: "diff --git a/src/file.ts b/src/file.ts\n", stderr: "", exitCode: 2, capped: true };
    });

    await expect(loadNodeGitContext(run, new AbortController().signal)).resolves.toEqual({
      branch: { kind: "branch", name: "feature/capped" },
      status: [{ index: " ", worktree: "M", path: "src/file.ts" }],
      commits: [{ shortHash: "abc1234", subject: "subject" }],
      diff: "diff --git a/src/file.ts b/src/file.ts\n",
      statusCapped: true,
      commitsCapped: true,
      diffCapped: true,
    });
  });

  it("suppresses stale Git context results after cancellation", async () => {
    let resolveFirst!: (context: GitContext) => void;
    const workbench = createWorkbench({
      listFiles: async () => "file.ts\0",
      readText: async () => ({ text: "", revision: "r" }),
      saveText: async () => ({ status: "error", message: "unused" }),
      getGitContext: vi.fn((_signal: AbortSignal) => new Promise<GitContext>((resolve) => { resolveFirst = resolve; })),
      maxReadBytes: 1,
    });
    await workbench.start();
    const first = workbench.loadGitContext();
    workbench.cancelGitContext();
    resolveFirst({ branch: { kind: "branch", name: "stale" }, status: [], commits: [], diff: "", statusCapped: false, commitsCapped: false, diffCapped: false });
    await first;
    expect(workbench.gitContext).toBeNull();
  });
});
