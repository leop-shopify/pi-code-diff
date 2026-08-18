import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, rename, rm, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { SaveTextResult, SourceLocation, SourceSearchResponse, SymbolLocation, TextFileSnapshot, WorkbenchRepository } from "../contracts.js";
import { parseDeclarationLine, parseRgJsonResults } from "../navigator.js";
import { buildHermeticGitInvocation, type HermeticGitInvocation } from "./git-process.js";
import { createChildTermination, DEFAULT_TERMINATION_GRACE_MS, isChildClosureError, utf8Prefix } from "./process-termination.js";

const RESULT_CAP = 200;
const COMMAND_TIMEOUT_MS = 5_000;
const STDERR_CAP = 8_192;
const STREAM_STDOUT_CAP = 256 * 1024;

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Legacy injectable runner retained for deterministic parser/fallback consumers. */
export type CommandRunner = (command: string, args: string[], signal: AbortSignal) => Promise<CommandResult>;
export type SpawnCommand = (command: string, args: string[]) => ChildProcess;
export type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: { cwd: string; stdio: ["ignore", "pipe", "pipe"]; env?: NodeJS.ProcessEnv },
) => ChildProcess;

export interface NodeFileAccessOptions {
  /** Injectable only so atomic rename and cleanup outcomes can be proven deterministically. */
  renameFile?: (from: string, to: string) => Promise<void>;
  removeFile?: (path: string) => Promise<void>;
  openLockFile?: (path: string) => Promise<FileHandle>;
  removeLockFile?: (path: string) => Promise<void>;
}

type NodeFileAccess = Pick<WorkbenchRepository, "canReadFile" | "maxReadBytes" | "readText" | "saveText">;

interface OpenedFileSnapshot {
  snapshot: TextFileSnapshot;
  bytes: Buffer;
  mode: number;
  resolvedPath: string;
}

function isContained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

function revisionFor(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function resolveContainedFile(root: string, path: string): Promise<string | null> {
  const candidate = resolve(root, path);
  if (!isContained(root, candidate)) return null;
  try {
    const resolvedPath = await realpath(candidate);
    return isContained(root, resolvedPath) ? resolvedPath : null;
  } catch {
    return null;
  }
}

async function readBounded(handle: FileHandle, maxBytes: number): Promise<Buffer> {
  const buffer = Buffer.alloc(maxBytes + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset > maxBytes) throw new Error("Selected file exceeds the workbench read limit.");
  return buffer.subarray(0, offset);
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error("Selected file is not valid UTF-8 text.");
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function appendCleanupFailures(message: string, failures: readonly string[]): string {
  return failures.length === 0 ? message : `${message}; temporary save cleanup failed: ${failures.join("; ")}`;
}

function appendLockCleanupFailures(message: string, failures: readonly string[]): string {
  return failures.length === 0 ? message : `${message}; save lock cleanup failed: ${failures.join("; ")}`;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error == null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function lockPathFor(canonicalTarget: string): string {
  const digest = createHash("sha256").update(canonicalTarget).digest("hex");
  return resolve(dirname(canonicalTarget), `.pi-workbench-${digest}.lock`);
}

async function openSnapshot(root: string, path: string, maxBytes: number): Promise<OpenedFileSnapshot> {
  const resolvedPath = await resolveContainedFile(root, path);
  if (resolvedPath == null) throw new Error("Selected file is outside the repository.");
  const handle = await open(resolvedPath, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const details = await handle.stat();
    if (!details.isFile()) throw new Error("Selected path is not a regular file.");
    if (details.size > maxBytes) throw new Error("Selected file exceeds the workbench read limit.");
    const bytes = await readBounded(handle, maxBytes);
    return {
      snapshot: { text: decodeUtf8(bytes), revision: revisionFor(bytes) },
      bytes,
      mode: details.mode & 0o7777,
      resolvedPath,
    };
  } finally {
    await handle.close();
  }
}

async function writeAtomic(
  root: string,
  path: string,
  text: string,
  expectedRevision: string,
  maxBytes: number,
  renameFile: (from: string, to: string) => Promise<void>,
  removeFile: (path: string) => Promise<void>,
  openLockFile: (path: string) => Promise<FileHandle>,
  removeLockFile: (path: string) => Promise<void>,
): Promise<SaveTextResult> {
  const canonicalTarget = await resolveContainedFile(root, path);
  if (canonicalTarget == null) throw new Error("Selected file is outside the repository.");
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length > maxBytes) return { status: "error", message: "Edited file exceeds the workbench write limit." };
  if (decodeUtf8(bytes) !== text) return { status: "error", message: "Edited text cannot be represented exactly as UTF-8." };

  const lockPath = lockPathFor(canonicalTarget);
  let lockHandle: FileHandle;
  try {
    lockHandle = await openLockFile(lockPath);
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      return { status: "error", message: "Another save is already in progress for this file; retry." };
    }
    throw new Error(`save lock acquisition failed: ${errorMessage(error)}`);
  }

  let tempHandle: FileHandle | null = null;
  let tempPath: string | null = null;
  let ownsTempPath = false;
  let outcome: SaveTextResult | null = null;
  let committedOutcome: Extract<SaveTextResult, { status: "success" }> | null = null;
  let primaryError: Error | null = null;
  try {
    const loaded = await openSnapshot(root, path, maxBytes);
    if (loaded.resolvedPath !== canonicalTarget || loaded.snapshot.revision !== expectedRevision) {
      outcome = { status: "conflict", message: "File changed outside the workbench; reload before saving." };
    } else {
      const revision = revisionFor(bytes);
      if (bytes.equals(loaded.bytes)) {
        outcome = { status: "success", effect: "unchanged", revision };
      } else {
        const directory = dirname(loaded.resolvedPath);
        tempPath = resolve(directory, `${basename(lockPath, ".lock")}-${process.pid}-${randomUUID()}.tmp`);
        tempHandle = await open(tempPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, loaded.mode);
        ownsTempPath = true;
        await tempHandle.writeFile(bytes);
        await tempHandle.chmod(loaded.mode);
        await tempHandle.sync();
        await tempHandle.close();
        tempHandle = null;

        const rechecked = await openSnapshot(root, path, maxBytes);
        if (rechecked.resolvedPath !== loaded.resolvedPath || rechecked.snapshot.revision !== expectedRevision) {
          outcome = { status: "conflict", message: "File changed outside the workbench; reload before saving." };
        } else {
          await renameFile(tempPath, loaded.resolvedPath);
          ownsTempPath = false;
          committedOutcome = { status: "success", effect: "saved", revision };
          outcome = committedOutcome;
        }
      }
    }
  } catch (error) {
    primaryError = error instanceof Error ? error : new Error(String(error));
  }

  const cleanupFailures: string[] = [];
  if (tempHandle != null) {
    try { await tempHandle.close(); } catch (error) { cleanupFailures.push(`close: ${errorMessage(error)}`); }
  }
  if (ownsTempPath && tempPath != null) {
    try { await removeFile(tempPath); } catch (error) { cleanupFailures.push(`remove: ${errorMessage(error)}`); }
  }

  const lockCleanupFailures: string[] = [];
  let lockClosed = false;
  try {
    await lockHandle.close();
    lockClosed = true;
  } catch (error) {
    lockCleanupFailures.push(`close: ${errorMessage(error)}`);
  }
  if (lockClosed) {
    try {
      await removeLockFile(lockPath);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") lockCleanupFailures.push(`remove: ${errorMessage(error)}`);
    }
  }

  if (primaryError != null) {
    const withTempCleanup = appendCleanupFailures(primaryError.message, cleanupFailures);
    throw new Error(appendLockCleanupFailures(withTempCleanup, lockCleanupFailures));
  }
  if (outcome == null) {
    const withTempCleanup = appendCleanupFailures("Atomic save did not produce a result.", cleanupFailures);
    throw new Error(appendLockCleanupFailures(withTempCleanup, lockCleanupFailures));
  }
  if (committedOutcome != null) {
    if (lockCleanupFailures.length === 0) return committedOutcome;
    return {
      ...committedOutcome,
      warning: `Save committed, but save lock cleanup failed: ${lockCleanupFailures.join("; ")}`,
    };
  }
  if (cleanupFailures.length > 0) {
    const message = outcome.status === "success" ? "No-op save cleanup failed." : outcome.message;
    return { status: "error", message: appendCleanupFailures(message, cleanupFailures) };
  }
  if (lockCleanupFailures.length > 0) {
    const message = outcome.status === "success" ? "No-op save completed." : outcome.message;
    return { status: "error", message: appendLockCleanupFailures(message, lockCleanupFailures) };
  }
  return outcome;
}

/**
 * Creates revision-aware Node file access. Containment and file limits are checked
 * again on every read/save; writes hold an exclusive target-directory lock through
 * an fsynced same-directory temp file, final revision recheck, rename, and cleanup.
 */
export async function createNodeFileAccess(rootPath: string, maxReadBytes: number, options: NodeFileAccessOptions = {}): Promise<NodeFileAccess> {
  const root = await realpath(rootPath);
  const renameFile = options.renameFile ?? rename;
  const removeFile = options.removeFile ?? (async (path: string) => { await rm(path, { force: true }); });
  const openLockFile = options.openLockFile ?? (async (path: string) => open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  ));
  const removeLockFile = options.removeLockFile ?? (async (path: string) => { await rm(path); });
  return {
    maxReadBytes,
    async canReadFile(path) {
      try {
        await openSnapshot(root, path, maxReadBytes);
        return true;
      } catch {
        return false;
      }
    },
    async readText(path, maxBytes) {
      const loaded = await openSnapshot(root, path, Math.min(maxBytes, maxReadBytes));
      return loaded.snapshot;
    },
    async saveText(path, text, expectedRevision) {
      try {
        return await writeAtomic(root, path, text, expectedRevision, maxReadBytes, renameFile, removeFile, openLockFile, removeLockFile);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message === "Selected file is outside the repository."
          || message === "Selected path is not a regular file."
          || message === "Selected file exceeds the workbench read limit."
          || message === "Selected file is not valid UTF-8 text.") {
          return { status: "error", message };
        }
        return { status: "error", message: `Could not atomically save ${path}: ${message}` };
      }
    },
  };
}

const gitGrepArgs = (query: string): string[] => ["grep", "-n", "-I", "-z", "--fixed-strings", "--", query];
const ripgrepTextArgs = (query: string): string[] => ["--no-config", "--no-pre", "--json", "--fixed-strings", "--", query];
const ripgrepSymbolArgs = (query: string): string[] => [
  "--no-config", "--no-pre", "--json", "-I", "--regexp", query,
  "--glob", "*.ts", "--glob", "*.tsx", "--glob", "*.js", "--glob", "*.jsx", "--glob", "*.rb", "--glob", "*.py",
];

export function buildGitGrepInvocation(cwd: string, args: readonly string[]): HermeticGitInvocation {
  const query = args.length === 7 ? args[6] : undefined;
  return buildHermeticGitInvocation(cwd, args, query == null ? [] : [gitGrepArgs(query)], "Git grep command is not allowlisted.");
}

const defaultSpawnProcess: SpawnProcess = (command, args, options) => spawn(command, args, options);

function spawnRepositoryProcess(cwd: string, command: string, args: string[], spawnProcess = defaultSpawnProcess): ChildProcess {
  if (command === "git") {
    const invocation = buildGitGrepInvocation(cwd, args);
    return spawnProcess(invocation.command, invocation.args, invocation.options);
  }
  if (command !== "rg" || args[0] !== "--no-config" || args[1] !== "--no-pre") {
    throw new Error("Repository search command is not allowlisted.");
  }
  return spawnProcess(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

export interface BoundedMatchResponse<T> {
  results: T[];
  stderr: string;
  exitCode: number;
  capped: boolean;
  capReason: "results" | "stdout" | null;
}

interface StreamingParser<T> {
  push(chunk: string): T[];
  finish(): T[];
}

function streamBoundedOutput<T>(
  spawnCommand: SpawnCommand,
  command: string,
  args: string[],
  signal: AbortSignal,
  parser: StreamingParser<T>,
  timeoutMs: number,
  stdoutCap: number,
  terminationGraceMs: number,
): Promise<BoundedMatchResponse<T>> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason ?? new Error("Search aborted.")); return; }
    const child = spawnCommand(command, args);
    let stdoutBytes = 0;
    let stderr = "";
    let stderrBytes = 0;
    let settled = false;
    let capReason: BoundedMatchResponse<T>["capReason"] = null;
    let pendingError: unknown;
    const results: T[] = [];
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      termination.dispose();
      callback();
    };
    const termination = createChildTermination(child, `${command} search`, (error) => finish(() => reject(error)), terminationGraceMs);
    const terminateWithError = (error: unknown) => {
      pendingError = error;
      termination.request();
    };
    const abort = () => terminateWithError(signal.reason ?? new Error("Search aborted."));
    const timeout = setTimeout(() => terminateWithError(new Error(`${command} search timed out.`)), timeoutMs);
    const consume = (matches: T[]) => {
      for (const match of matches) {
        if (settled || capReason != null) break;
        results.push(match);
        if (results.length === RESULT_CAP) {
          capReason = "results";
          termination.request();
        }
      }
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (settled || capReason != null) return;
      const prefix = utf8Prefix(chunk, Math.max(0, stdoutCap - stdoutBytes));
      stdoutBytes += prefix.bytes;
      if (prefix.text.length > 0) consume(parser.push(prefix.text));
      if (capReason == null && (prefix.text.length < chunk.length || stdoutBytes >= stdoutCap)) {
        capReason = "stdout";
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
      if (pendingError == null && capReason == null) pendingError = error;
      termination.request();
    });
    child.on("close", (exitCode) => {
      termination.markClosed();
      if (settled) return;
      if (pendingError != null) { finish(() => reject(pendingError)); return; }
      if (capReason !== "stdout") consume(parser.finish());
      finish(() => resolve({ results, stderr, exitCode: exitCode ?? 2, capped: capReason != null, capReason }));
    });
    signal.addEventListener("abort", abort, { once: true });
  });
}

function createLineParser<T>(parseLine: (line: string) => T | null): StreamingParser<T> {
  let buffer = "";
  const consume = (complete: boolean): T[] => {
    const matches: T[] = [];
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const match = line.length === 0 ? null : parseLine(line);
      if (match != null) matches.push(match);
    }
    if (complete && buffer.length > 0) {
      const match = parseLine(buffer);
      buffer = "";
      if (match != null) matches.push(match);
    }
    return matches;
  };
  return {
    push(chunk) { buffer += chunk; return consume(false); },
    finish() { return consume(true); },
  };
}

/** Streams newline-delimited command output, retaining no more than 200 parsed matches. */
export function streamBoundedMatches<T>(
  spawnCommand: SpawnCommand,
  command: string,
  args: string[],
  signal: AbortSignal,
  parseLine: (line: string) => T | null,
  timeoutMs = COMMAND_TIMEOUT_MS,
  stdoutCap = STREAM_STDOUT_CAP,
  terminationGraceMs = DEFAULT_TERMINATION_GRACE_MS,
): Promise<BoundedMatchResponse<T>> {
  return streamBoundedOutput(spawnCommand, command, args, signal, createLineParser(parseLine), timeoutMs, stdoutCap, terminationGraceMs);
}

function createGitGrepParser(): StreamingParser<SourceLocation> {
  let buffer = "";
  const consume = (complete: boolean): SourceLocation[] => {
    const results: SourceLocation[] = [];
    while (true) {
      const pathEnd = buffer.indexOf("\0");
      if (pathEnd < 0) break;
      const lineEnd = buffer.indexOf("\0", pathEnd + 1);
      if (lineEnd < 0) break;
      let textEnd = buffer.indexOf("\n", lineEnd + 1);
      if (textEnd < 0) {
        if (!complete) break;
        textEnd = buffer.length;
      }
      const line = Number.parseInt(buffer.slice(pathEnd + 1, lineEnd), 10);
      if (Number.isInteger(line) && line > 0) {
        results.push({
          path: buffer.slice(0, pathEnd),
          line,
          column: 1,
          text: buffer.slice(lineEnd + 1, textEnd).replace(/\r$/, ""),
        });
      }
      buffer = buffer.slice(Math.min(textEnd + 1, buffer.length));
    }
    return results;
  };
  return {
    push(chunk) { buffer += chunk; return consume(false); },
    finish() { return consume(true); },
  };
}

export function parseGitGrepNullResults(output: string, cap = RESULT_CAP): SourceLocation[] {
  const parser = createGitGrepParser();
  return [...parser.push(output), ...parser.finish()].slice(0, cap);
}

function streamBoundedGitGrep(spawnCommand: SpawnCommand, args: string[], signal: AbortSignal): Promise<BoundedMatchResponse<SourceLocation>> {
  return streamBoundedOutput(spawnCommand, "git", args, signal, createGitGrepParser(), COMMAND_TIMEOUT_MS, STREAM_STDOUT_CAP, DEFAULT_TERMINATION_GRACE_MS);
}

/** Legacy injectable text-search delegate retaining allowlisted arguments and fallback coverage. */
export async function searchRepositoryText(run: CommandRunner, query: string, signal: AbortSignal): Promise<SourceSearchResponse> {
  if (query.trim().length === 0) return { results: [], coverage: "working-tree" };
  try {
    const rg = await run("rg", ripgrepTextArgs(query), signal);
    if (rg.exitCode === 0) return { results: parseRgJsonResults(rg.stdout), coverage: "working-tree" };
    if (rg.exitCode === 1) return { results: [], coverage: "working-tree" };
  } catch (error) {
    if (signal.aborted || isChildClosureError(error)) throw error;
  }
  const fallback = await run("git", gitGrepArgs(query), signal);
  if (fallback.exitCode === 0) return { results: parseGitGrepNullResults(fallback.stdout), coverage: "tracked-only" };
  if (fallback.exitCode === 1) return { results: [], coverage: "tracked-only" };
  throw new Error(`git grep failed: ${fallback.stderr.trim() || `exit ${fallback.exitCode}`}`);
}

/** Legacy injectable declaration-search delegate retaining bounded parser results. */
export async function searchRepositorySymbols(run: CommandRunner, query: string, signal: AbortSignal): Promise<SymbolLocation[]> {
  if (query.trim().length === 0) return [];
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const result = await run("rg", ripgrepSymbolArgs(escaped), signal);
  if (result.exitCode === 1) return [];
  if (result.exitCode !== 0) throw new Error(`rg symbol search failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
  return parseRgJsonResults(result.stdout).flatMap(({ path, line, text }) => {
    const symbol = parseDeclarationLine(path, text, line);
    return symbol == null ? [] : [symbol];
  });
}

async function nodeSearch(spawnCommand: SpawnCommand, query: string, signal: AbortSignal): Promise<SourceSearchResponse> {
  if (query.trim().length === 0) return { results: [], coverage: "working-tree" };
  let rg: BoundedMatchResponse<SourceLocation> | null = null;
  try {
    rg = await streamBoundedMatches(spawnCommand, "rg", ripgrepTextArgs(query), signal, (line) => parseRgJsonResults(line, 1)[0] ?? null);
  } catch (error) {
    if (signal.aborted || isChildClosureError(error)) throw error;
  }
  if (rg?.capReason === "stdout") throw new Error("rg search output exceeded its byte limit.");
  if (rg?.capReason === "results" || rg?.exitCode === 0) return { results: rg.results, coverage: "working-tree" };
  if (rg?.exitCode === 1) return { results: [], coverage: "working-tree" };

  const fallback = await streamBoundedGitGrep(spawnCommand, gitGrepArgs(query), signal);
  if (fallback.capReason === "stdout") throw new Error("git grep search output exceeded its byte limit.");
  if (fallback.capReason === "results" || fallback.exitCode === 0) return { results: fallback.results, coverage: "tracked-only" };
  if (fallback.exitCode === 1) return { results: [], coverage: "tracked-only" };
  throw new Error(`git grep failed: ${fallback.stderr.trim() || `exit ${fallback.exitCode}`}`);
}

function nodeSymbols(spawnCommand: SpawnCommand, query: string, signal: AbortSignal): Promise<SymbolLocation[]> {
  if (query.trim().length === 0) return Promise.resolve([]);
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return streamBoundedMatches(spawnCommand, "rg", ripgrepSymbolArgs(escaped), signal, (line) => {
    const location = parseRgJsonResults(line, 1)[0];
    return location == null ? null : parseDeclarationLine(location.path, location.text, location.line);
  }).then((result) => {
    if (result.capReason === "stdout") throw new Error("rg symbol search output exceeded its byte limit.");
    if (result.capReason === "results" || result.exitCode === 0 || result.exitCode === 1) return result.results;
    throw new Error(`rg symbol search failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
  });
}

/** Adds bounded, query-time source and declaration search to a host repository. */
export function withNodeSourceSearch(repository: WorkbenchRepository, cwd: string, spawnProcess = defaultSpawnProcess): WorkbenchRepository {
  const spawnCommand: SpawnCommand = (command, args) => spawnRepositoryProcess(cwd, command, args, spawnProcess);
  return { ...repository, searchText: (query, signal) => nodeSearch(spawnCommand, query, signal), searchSymbols: (query, signal) => nodeSymbols(spawnCommand, query, signal) };
}
