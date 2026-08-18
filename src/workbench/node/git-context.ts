import { spawn, type ChildProcess } from "node:child_process";
import { FILTER_CONFIG_ARGS, filterOverrideArgs, parseFilterConfigPrefixes } from "../../git-filter-policy.js";
import { CHILD_CLOSURE_UNCONFIRMED } from "../contracts.js";
import type { GitContext } from "../git.js";
import { parseGitBranch, parseGitLog, parsePorcelainStatus } from "../git.js";
import { buildHermeticGitInvocation, type HermeticGitInvocation } from "./git-process.js";
import { createChildTermination, DEFAULT_TERMINATION_GRACE_MS, utf8Prefix } from "./process-termination.js";

const COMMAND_TIMEOUT_MS = 3_000;
const METADATA_OUTPUT_CAP = 64 * 1024;
const DIFF_OUTPUT_CAP = 128 * 1024;
const STDERR_CAP = 8 * 1024;

export interface GitCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  capped: boolean;
}

/** Restricted argument-vector command boundary for read-only Git context. */
export type GitCommand = (args: readonly string[], signal: AbortSignal) => Promise<GitCommandResult>;
export type GitSpawn = (args: readonly string[]) => ChildProcess;

const SYMBOLIC_REF_ARGS = ["symbolic-ref", "--quiet", "--short", "HEAD"] as const;
const REV_PARSE_ARGS = ["rev-parse", "--short", "HEAD"] as const;
const STATUS_ARGS = ["status", "--porcelain=v1", "-z", "--untracked-files=normal", "--ignore-submodules=all"] as const;
const LOG_ARGS = ["log", "-20", "--format=%h%x00%s%x00"] as const;
const DIFF_ARGS = ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--unified=3", "--ignore-submodules=all", "--", "."] as const;
const STATIC_READ_ONLY_COMMANDS = [FILTER_CONFIG_ARGS, SYMBOLIC_REF_ARGS, REV_PARSE_ARGS, LOG_ARGS] as const;
const FILTER_PREFIX = /^filter\.[A-Za-z0-9][A-Za-z0-9._-]*$/;

function sameArgs(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((argument, index) => argument === expected[index]);
}

function parseSanitizedWorktreePrefixes(args: readonly string[], semanticArgs: readonly string[]): string[] | null {
  let index = 0;
  let previousPrefix: string | undefined;
  const prefixes: string[] = [];
  while (args[index] === "-c") {
    const cleanOverride = args[index + 1];
    if (typeof cleanOverride !== "string" || !cleanOverride.endsWith(".clean=")) return null;
    const prefix = cleanOverride.slice(0, -".clean=".length);
    if (!FILTER_PREFIX.test(prefix) || (previousPrefix != null && prefix <= previousPrefix)) return null;
    const overrides = filterOverrideArgs(prefix);
    if (!sameArgs(args.slice(index, index + overrides.length), overrides)) return null;
    prefixes.push(prefix);
    previousPrefix = prefix;
    index += overrides.length;
  }
  return sameArgs(args.slice(index), semanticArgs) ? prefixes : null;
}

function canonicalReadOnlyArgs(args: readonly string[]): readonly string[] | null {
  const staticArgs = STATIC_READ_ONLY_COMMANDS.find((allowed) => sameArgs(args, allowed));
  if (staticArgs != null) return staticArgs;
  const statusPrefixes = parseSanitizedWorktreePrefixes(args, STATUS_ARGS);
  if (statusPrefixes != null) return withFilterOverrides(statusPrefixes, STATUS_ARGS);
  const diffPrefixes = parseSanitizedWorktreePrefixes(args, DIFF_ARGS);
  return diffPrefixes == null ? null : withFilterOverrides(diffPrefixes, DIFF_ARGS);
}

function assertReadOnly(args: readonly string[]): readonly string[] {
  const canonicalArgs = canonicalReadOnlyArgs(args);
  if (canonicalArgs == null) throw new Error("Git context command is not allowlisted.");
  return canonicalArgs;
}

export type ReadOnlyGitInvocation = HermeticGitInvocation;

export function buildReadOnlyGitInvocation(cwd: string, args: readonly string[]): ReadOnlyGitInvocation {
  const canonicalArgs = assertReadOnly(args);
  return buildHermeticGitInvocation(cwd, args, [canonicalArgs], "Git context command is not allowlisted.");
}

/** Runs one allowlisted Git command with output, stderr, and time bounds. */
export function createGitCommand(
  spawnGit: GitSpawn,
  timeoutMs = COMMAND_TIMEOUT_MS,
  outputCap = METADATA_OUTPUT_CAP,
  terminationGraceMs = DEFAULT_TERMINATION_GRACE_MS,
): GitCommand {
  return (args, signal) => new Promise((resolve, reject) => {
    assertReadOnly(args);
    if (signal.aborted) { reject(signal.reason ?? new Error("Git context request aborted.")); return; }
    const child = spawnGit(args);
    let stdout = "";
    let stdoutBytes = 0;
    let stderr = "";
    let stderrBytes = 0;
    let settled = false;
    let capped = false;
    let pendingError: unknown;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      termination.dispose();
      callback();
    };
    const termination = createChildTermination(child, "Git context command", (error) => finish(() => reject(error)), terminationGraceMs);
    const terminateWithError = (error: unknown) => {
      pendingError = error;
      termination.request();
    };
    const abort = () => terminateWithError(signal.reason ?? new Error("Git context request aborted."));
    const timeout = setTimeout(() => terminateWithError(new Error("Git context command timed out.")), timeoutMs);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (settled || capped) return;
      const prefix = utf8Prefix(chunk, Math.max(0, outputCap - stdoutBytes));
      stdout += prefix.text;
      stdoutBytes += prefix.bytes;
      if (prefix.text.length < chunk.length || stdoutBytes >= outputCap) {
        capped = true;
        termination.request();
      }
    });
    child.stderr?.on("data", (chunk: string) => {
      if (settled || stderrBytes >= STDERR_CAP) return;
      const prefix = utf8Prefix(chunk, STDERR_CAP - stderrBytes);
      stderr += prefix.text;
      stderrBytes += prefix.bytes;
    });
    child.on("error", (error) => {
      if (settled) return;
      if (pendingError == null && !capped) pendingError = error;
      termination.request();
    });
    child.on("close", (exitCode) => {
      termination.markClosed();
      if (pendingError != null) finish(() => reject(pendingError));
      else finish(() => resolve({ stdout, stderr, exitCode: exitCode ?? 2, capped }));
    });
    signal.addEventListener("abort", abort, { once: true });
  });
}

function emptyContext(branch: GitContext["branch"]): GitContext {
  return { branch, status: [], commits: [], diff: "", statusCapped: false, commitsCapped: false, diffCapped: false };
}

function hasUnconfirmedChildClosureCode(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === CHILD_CLOSURE_UNCONFIRMED;
}

function parseFilterPrefixes(result: GitCommandResult): string[] {
  if (result.capped) throw new Error("Git filter configuration inspection exceeded its output cap.");
  if (result.exitCode === 1) {
    if (result.stdout !== "") throw new Error("Git filter configuration inspection returned malformed output.");
    return [];
  }
  if (result.exitCode !== 0) throw new Error("Git filter configuration inspection failed.");
  const parsed = parseFilterConfigPrefixes(result.stdout);
  if (parsed.kind === "failure") {
    if (parsed.reason === "unsafe") throw new Error("Git returned an unsafe filter configuration key.");
    throw new Error("Git filter configuration inspection returned malformed output.");
  }
  return parsed.prefixes;
}

function withFilterOverrides(prefixes: readonly string[], semanticArgs: readonly string[]): string[] {
  // Status and diff may execute configured filters; empty per-command drivers force passthrough instead.
  return [...prefixes.flatMap(filterOverrideArgs), ...semanticArgs];
}

async function runGitContextGroup(command: GitCommand, argsList: readonly (readonly string[])[], signal: AbortSignal): Promise<GitCommandResult[]> {
  if (signal.aborted) throw signal.reason ?? new Error("Git context request aborted.");
  const group = new AbortController();
  const relayAbort = () => group.abort(signal.reason ?? new Error("Git context request aborted."));
  signal.addEventListener("abort", relayAbort, { once: true });
  let firstFailure: unknown;
  const run = (args: readonly string[]) => command(args, group.signal).catch((error: unknown) => {
    if (firstFailure == null) firstFailure = error;
    if (!group.signal.aborted) group.abort(error);
    throw error;
  });
  try {
    const outcomes = await Promise.allSettled(argsList.map(run));
    for (const outcome of outcomes) {
      if (outcome.status === "rejected" && hasUnconfirmedChildClosureCode(outcome.reason)) throw outcome.reason;
    }
    if (firstFailure != null) throw firstFailure;
    return outcomes.map((outcome) => {
      if (outcome.status === "rejected") throw outcome.reason;
      return outcome.value;
    });
  } finally {
    signal.removeEventListener("abort", relayAbort);
  }
}

/** Loads bounded, read-only Git metadata. Exit 1 represents detached/no-commit/empty output. */
export async function loadNodeGitContext(command: GitCommand, signal: AbortSignal): Promise<GitContext> {
  const filterPrefixes = parseFilterPrefixes(await command(FILTER_CONFIG_ARGS, signal));
  const symbolic = await command(SYMBOLIC_REF_ARGS, signal);
  const head = await command(REV_PARSE_ARGS, signal);
  const branch = parseGitBranch(symbolic.exitCode === 0 ? symbolic.stdout : "", head.exitCode === 0 ? head.stdout : "");
  if (head.exitCode !== 0 && head.exitCode !== 1) return emptyContext(branch);
  const statusArgs = withFilterOverrides(filterPrefixes, STATUS_ARGS);
  const diffArgs = withFilterOverrides(filterPrefixes, DIFF_ARGS);
  const [status, log, diff] = await runGitContextGroup(command, [statusArgs, LOG_ARGS, diffArgs], signal);
  return {
    branch,
    status: status.exitCode === 0 || status.capped ? parsePorcelainStatus(status.stdout) : [],
    commits: log.exitCode === 0 || log.capped ? parseGitLog(log.stdout) : [],
    diff: diff.exitCode === 0 || diff.exitCode === 1 || diff.capped ? diff.stdout : "",
    statusCapped: status.capped,
    commitsCapped: log.capped,
    diffCapped: diff.capped,
  };
}

/** Creates a host Node service without exposing Pi runtime dependencies. */
export function createNodeGitContext(cwd: string): (signal: AbortSignal) => Promise<GitContext> {
  const spawnGit: GitSpawn = (args) => {
    const invocation = buildReadOnlyGitInvocation(cwd, args);
    return spawn(invocation.command, invocation.args, invocation.options);
  };
  const metadata = createGitCommand(spawnGit, COMMAND_TIMEOUT_MS, METADATA_OUTPUT_CAP);
  const diff = createGitCommand(spawnGit, COMMAND_TIMEOUT_MS, DIFF_OUTPUT_CAP);
  return async (signal) => {
    const command: GitCommand = (args, commandSignal) => parseSanitizedWorktreePrefixes(args, DIFF_ARGS) != null ? diff(args, commandSignal) : metadata(args, commandSignal);
    return loadNodeGitContext(command, signal);
  };
}
