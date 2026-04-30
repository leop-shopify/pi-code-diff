import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { ChangeStatus, ReviewFile, ReviewFileComparison, ReviewFileContents, ReviewScope } from "./types.js";

export interface ChangedPath {
  status: ChangeStatus;
  oldPath: string | null;
  newPath: string | null;
}

interface ReviewFileSeed {
  path: string;
  worktreeStatus: ChangeStatus | null;
  hasWorkingTreeFile: boolean;
  inGitDiff: boolean;
  inLastCommit: boolean;
  inAllFiles: boolean;
  gitDiff: ReviewFileComparison | null;
  lastCommit: ReviewFileComparison | null;
  allFiles: ReviewFileComparison | null;
}

async function runGit(pi: ExtensionAPI, repoRoot: string, args: string[]): Promise<string> {
  const result = await pi.exec("git", args, { cwd: repoRoot });
  if (result.code !== 0) {
    const message = result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} failed`;
    throw new Error(message);
  }
  return result.stdout;
}

async function runGitAllowFailure(pi: ExtensionAPI, repoRoot: string, args: string[]): Promise<string> {
  const result = await pi.exec("git", args, { cwd: repoRoot });
  if (result.code !== 0) return "";
  return result.stdout;
}

export async function getRepoRoot(pi: ExtensionAPI, cwd: string): Promise<string> {
  const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd });
  if (result.code !== 0) {
    throw new Error("Not inside a git repository.");
  }
  return result.stdout.trim();
}

async function hasHead(pi: ExtensionAPI, repoRoot: string): Promise<boolean> {
  const result = await pi.exec("git", ["rev-parse", "--verify", "HEAD"], { cwd: repoRoot });
  return result.code === 0;
}

export function parseNameStatus(output: string): ChangedPath[] {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const changes: ChangedPath[] = [];

  for (const line of lines) {
    const parts = line.split("\t");
    const rawStatus = parts[0] ?? "";
    const code = rawStatus[0];

    if (code === "R") {
      const oldPath = parts[1] ?? null;
      const newPath = parts[2] ?? null;
      if (oldPath != null && newPath != null) {
        changes.push({ status: "renamed", oldPath, newPath });
      }
      continue;
    }

    if (code === "M") {
      const path = parts[1] ?? null;
      if (path != null) changes.push({ status: "modified", oldPath: path, newPath: path });
      continue;
    }

    if (code === "A") {
      const path = parts[1] ?? null;
      if (path != null) changes.push({ status: "added", oldPath: null, newPath: path });
      continue;
    }

    if (code === "D") {
      const path = parts[1] ?? null;
      if (path != null) changes.push({ status: "deleted", oldPath: path, newPath: null });
    }
  }

  return changes;
}

export function parseUntrackedPaths(output: string): ChangedPath[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((path) => ({ status: "added" as const, oldPath: null, newPath: path }));
}

function parseTrackedPaths(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function mergeChangedPaths(tracked: ChangedPath[], untracked: ChangedPath[]): ChangedPath[] {
  const seen = new Set(tracked.map((change) => `${change.status}:${change.oldPath ?? ""}:${change.newPath ?? ""}`));
  const merged = [...tracked];

  for (const change of untracked) {
    const key = `${change.status}:${change.oldPath ?? ""}:${change.newPath ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(change);
  }

  return merged;
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)];
}

function toDisplayPath(change: ChangedPath): string {
  if (change.status === "renamed") {
    return `${change.oldPath ?? ""} -> ${change.newPath ?? ""}`;
  }
  return change.newPath ?? change.oldPath ?? "(unknown)";
}

function toComparison(change: ChangedPath): ReviewFileComparison {
  return {
    status: change.status,
    oldPath: change.oldPath,
    newPath: change.newPath,
    displayPath: toDisplayPath(change),
    hasOriginal: change.oldPath != null,
    hasModified: change.newPath != null,
  };
}

function buildReviewFileId(
  path: string,
  hasWorkingTreeFile: boolean,
  gitDiff: ReviewFileComparison | null,
  lastCommit: ReviewFileComparison | null,
  allFiles: ReviewFileComparison | null,
): string {
  return [path, hasWorkingTreeFile ? "working" : "gone", gitDiff?.displayPath ?? "", lastCommit?.displayPath ?? "", allFiles?.displayPath ?? ""].join("::");
}

function createReviewFile(seed: ReviewFileSeed): ReviewFile {
  return {
    id: buildReviewFileId(seed.path, seed.hasWorkingTreeFile, seed.gitDiff, seed.lastCommit, seed.allFiles),
    path: seed.path,
    worktreeStatus: seed.worktreeStatus,
    hasWorkingTreeFile: seed.hasWorkingTreeFile,
    inGitDiff: seed.inGitDiff,
    inLastCommit: seed.inLastCommit,
    inAllFiles: seed.inAllFiles,
    gitDiff: seed.gitDiff,
    lastCommit: seed.lastCommit,
    allFiles: seed.allFiles,
  };
}

async function getRevisionContent(pi: ExtensionAPI, repoRoot: string, revision: string, path: string): Promise<string> {
  const result = await pi.exec("git", ["show", `${revision}:${path}`], { cwd: repoRoot });
  if (result.code !== 0) return "";
  return result.stdout;
}

async function getWorkingTreeContent(repoRoot: string, path: string): Promise<string> {
  try {
    return await readFile(join(repoRoot, path), "utf8");
  } catch {
    return "";
  }
}

export function isReviewableFilePath(path: string): boolean {
  const lowerPath = path.toLowerCase();
  const fileName = lowerPath.split("/").pop() ?? lowerPath;
  const extension = extname(fileName);

  if (fileName.length === 0) return false;

  const binaryExtensions = new Set([
    ".7z",
    ".a",
    ".avi",
    ".avif",
    ".bin",
    ".bmp",
    ".class",
    ".dll",
    ".dylib",
    ".eot",
    ".exe",
    ".gif",
    ".gz",
    ".ico",
    ".jar",
    ".jpeg",
    ".jpg",
    ".lockb",
    ".map",
    ".mov",
    ".mp3",
    ".mp4",
    ".o",
    ".otf",
    ".pdf",
    ".png",
    ".pyc",
    ".so",
    ".svgz",
    ".tar",
    ".ttf",
    ".wasm",
    ".webm",
    ".webp",
    ".woff",
    ".woff2",
    ".zip",
  ]);

  if (binaryExtensions.has(extension)) return false;
  if (fileName.endsWith(".min.js") || fileName.endsWith(".min.css")) return false;

  return true;
}

function compareReviewFiles(a: ReviewFile, b: ReviewFile): number {
  return a.path.localeCompare(b.path);
}

function upsertSeed(seeds: Map<string, ReviewFileSeed>, key: string, create: () => ReviewFileSeed): ReviewFileSeed {
  const existing = seeds.get(key);
  if (existing != null) return existing;
  const seed = create();
  seeds.set(key, seed);
  return seed;
}

function createSeed(path: string, hasWorkingTreeFile: boolean): ReviewFileSeed {
  return {
    path,
    worktreeStatus: null,
    hasWorkingTreeFile,
    inGitDiff: false,
    inLastCommit: false,
    inAllFiles: false,
    gitDiff: null,
    lastCommit: null,
    allFiles: null,
  };
}

async function getFirstExistingRef(pi: ExtensionAPI, repoRoot: string, refs: string[]): Promise<string | null> {
  for (const ref of refs) {
    const result = await pi.exec("git", ["rev-parse", "--verify", "--quiet", ref], { cwd: repoRoot });
    if (result.code === 0) return ref;
  }
  return null;
}

export async function getDefaultBranchRef(pi: ExtensionAPI, repoRoot: string): Promise<string | null> {
  const originHead = (await runGitAllowFailure(pi, repoRoot, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])).trim();
  if (originHead.length > 0 && originHead !== "origin/HEAD") return originHead;

  return getFirstExistingRef(pi, repoRoot, ["origin/main", "origin/master", "main", "master"]);
}

async function getBranchBaseRevision(pi: ExtensionAPI, repoRoot: string): Promise<string | null> {
  const defaultBranch = await getDefaultBranchRef(pi, repoRoot);
  if (defaultBranch == null) return null;
  const result = await pi.exec("git", ["merge-base", defaultBranch, "HEAD"], { cwd: repoRoot });
  if (result.code !== 0) return null;
  return result.stdout.trim() || null;
}

export async function getReviewWindowData(pi: ExtensionAPI, cwd: string): Promise<{ repoRoot: string; files: ReviewFile[] }> {
  const repoRoot = await getRepoRoot(pi, cwd);
  const repositoryHasHead = await hasHead(pi, repoRoot);

  const trackedDiffOutput = repositoryHasHead
    ? await runGit(pi, repoRoot, ["diff", "--find-renames", "-M", "--name-status", "HEAD", "--"])
    : "";
  const untrackedOutput = await runGitAllowFailure(pi, repoRoot, ["ls-files", "--others", "--exclude-standard"]);
  const trackedFilesOutput = await runGitAllowFailure(pi, repoRoot, ["ls-files", "--cached"]);
  const deletedFilesOutput = await runGitAllowFailure(pi, repoRoot, ["ls-files", "--deleted"]);
  const lastCommitOutput = repositoryHasHead
    ? await runGitAllowFailure(pi, repoRoot, ["diff-tree", "--root", "--find-renames", "-M", "--name-status", "--no-commit-id", "-r", "HEAD"])
    : "";
  const branchBaseRevision = repositoryHasHead ? await getBranchBaseRevision(pi, repoRoot) : null;
  const branchDiffOutput = branchBaseRevision == null
    ? ""
    : await runGitAllowFailure(pi, repoRoot, ["diff", "--find-renames", "-M", "--name-status", branchBaseRevision, "HEAD", "--"]);

  const worktreeChanges = mergeChangedPaths(parseNameStatus(trackedDiffOutput), parseUntrackedPaths(untrackedOutput))
    .filter((change) => isReviewableFilePath(change.newPath ?? change.oldPath ?? ""));
  const deletedPaths = new Set(parseTrackedPaths(deletedFilesOutput));
  const currentPaths = uniquePaths([...parseTrackedPaths(trackedFilesOutput), ...parseTrackedPaths(untrackedOutput)])
    .filter((path) => !deletedPaths.has(path))
    .filter(isReviewableFilePath);
  const currentPathSet = new Set(currentPaths);
  const lastCommitChanges = parseNameStatus(lastCommitOutput)
    .filter((change) => isReviewableFilePath(change.newPath ?? change.oldPath ?? ""));
  const branchChanges = parseNameStatus(branchDiffOutput)
    .filter((change) => isReviewableFilePath(change.newPath ?? change.oldPath ?? ""));

  const seeds = new Map<string, ReviewFileSeed>();

  for (const change of worktreeChanges) {
    const key = change.newPath ?? change.oldPath ?? toDisplayPath(change);
    const seed = upsertSeed(seeds, key, () => createSeed(key, change.newPath != null));
    seed.worktreeStatus = change.status;
    seed.hasWorkingTreeFile = change.newPath != null;
    seed.inGitDiff = true;
    seed.gitDiff = toComparison(change);
  }

  for (const change of branchChanges) {
    const key = change.newPath ?? change.oldPath ?? toDisplayPath(change);
    const seed = upsertSeed(seeds, key, () => createSeed(key, change.newPath != null && currentPathSet.has(change.newPath)));
    seed.inAllFiles = true;
    seed.allFiles = toComparison(change);
  }

  for (const change of lastCommitChanges) {
    const key = change.newPath ?? change.oldPath ?? toDisplayPath(change);
    const seed = upsertSeed(seeds, key, () => createSeed(key, change.newPath != null && currentPathSet.has(change.newPath)));
    seed.inLastCommit = true;
    seed.lastCommit = toComparison(change);
  }

  if (seeds.size === 0) {
    for (const path of currentPaths) {
      const seed = createSeed(path, true);
      seed.inAllFiles = true;
      seeds.set(path, seed);
    }
  }

  const files = [...seeds.values()].map(createReviewFile).sort(compareReviewFiles);
  return { repoRoot, files };
}

export async function loadReviewFileContents(pi: ExtensionAPI, repoRoot: string, file: ReviewFile, scope: ReviewScope): Promise<ReviewFileContents> {
  const comparison = scope === "git-diff" ? file.gitDiff : scope === "last-commit" ? file.lastCommit : file.allFiles;

  if (scope === "all-files" && comparison == null) {
    const content = file.hasWorkingTreeFile ? await getWorkingTreeContent(repoRoot, file.path) : "";
    return { originalContent: content, modifiedContent: content };
  }

  if (comparison == null) {
    return { originalContent: "", modifiedContent: "" };
  }

  const branchBaseRevision = scope === "all-files" ? await getBranchBaseRevision(pi, repoRoot) : null;
  const originalRevision = scope === "git-diff" ? "HEAD" : scope === "last-commit" ? "HEAD^" : branchBaseRevision;
  const modifiedRevision = scope === "git-diff" ? null : "HEAD";

  const originalContent = comparison.oldPath == null || originalRevision == null ? "" : await getRevisionContent(pi, repoRoot, originalRevision, comparison.oldPath);
  const modifiedContent = comparison.newPath == null
    ? ""
    : modifiedRevision == null
      ? await getWorkingTreeContent(repoRoot, comparison.newPath)
      : await getRevisionContent(pi, repoRoot, modifiedRevision, comparison.newPath);

  return { originalContent, modifiedContent };
}
