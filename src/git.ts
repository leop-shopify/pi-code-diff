import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, posix, relative, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ChangeStatus, ReviewFile, ReviewFileComparison, ReviewFileContents, ReviewScope } from "./types.js";

export interface ChangedPath {
  status: ChangeStatus;
  oldPath: string | null;
  newPath: string | null;
}

export interface ChangeStats {
  additions: number;
  deletions: number;
}

export interface ReviewWindowData {
  repoRoot: string;
  files: ReviewFile[];
  branchBaseRevision: string | null;
  modifiedRevision?: string;
  visibleScopes: ReviewScope[];
}

export const MAX_REVIEW_FILE_BYTES = 1_000_000;
export const MAX_REVIEW_FILE_COUNT = 500;

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
  allFilesReferenceCount: number;
  allFilesOutgoingReferences: string[];
  allFilesIncomingReferences: string[];
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

export function parseStatusPorcelain(output: string): ChangedPath[] {
  const entries = output.split("\0");
  const changes: ChangedPath[] = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry == null || entry.length < 4) continue;

    const indexStatus = entry[0] ?? " ";
    const worktreeStatus = entry[1] ?? " ";
    const path = entry.slice(3);
    if (path.length === 0 || (indexStatus === "!" && worktreeStatus === "!")) continue;

    if (indexStatus === "?" && worktreeStatus === "?") {
      changes.push({ status: "added", oldPath: null, newPath: path });
      continue;
    }

    if (indexStatus === "R" || worktreeStatus === "R") {
      const oldPath = entries[index + 1] ?? null;
      if (oldPath != null && oldPath.length > 0) {
        changes.push({ status: "renamed", oldPath, newPath: path });
        index += 1;
      } else {
        changes.push({ status: "modified", oldPath: path, newPath: path });
      }
      continue;
    }

    if (indexStatus === "C" || worktreeStatus === "C" || indexStatus === "A" || worktreeStatus === "A") {
      changes.push({ status: "added", oldPath: null, newPath: path });
      continue;
    }

    if (indexStatus === "D" || worktreeStatus === "D") {
      changes.push({ status: "deleted", oldPath: path, newPath: null });
      continue;
    }

    if (indexStatus !== " " || worktreeStatus !== " ") {
      changes.push({ status: "modified", oldPath: path, newPath: path });
    }
  }

  return changes;
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

function getChangedPathCoverage(changes: ChangedPath[]): Set<string> {
  const paths = new Set<string>();
  for (const change of changes) {
    if (change.oldPath != null) paths.add(normalizeGitPath(change.oldPath));
    if (change.newPath != null) paths.add(normalizeGitPath(change.newPath));
  }
  return paths;
}

function mergeMissingChangedPaths(primary: ChangedPath[], supplemental: ChangedPath[]): ChangedPath[] {
  const coveredPaths = getChangedPathCoverage(primary);
  const merged = [...primary];

  for (const change of supplemental) {
    const paths = [change.oldPath, change.newPath]
      .filter((path): path is string => path != null)
      .map(normalizeGitPath);
    if (paths.length === 0 || paths.every((path) => coveredPaths.has(path))) continue;
    for (const path of paths) coveredPaths.add(path);
    merged.push(change);
  }

  return merged;
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)];
}

function parseStatCount(value: string | undefined): number {
  if (value == null || value === "-") return 0;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeNumStatPath(path: string): string {
  if (!path.includes(" => ")) return path;
  const expanded = path.replace(/\{[^{}]* => ([^{}]*)\}/g, "$1");
  if (!expanded.includes(" => ")) return expanded;
  return expanded.split(" => ").pop() ?? expanded;
}

export function parseNumStat(output: string): Map<string, ChangeStats> {
  const stats = new Map<string, ChangeStats>();

  for (const line of output.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const parts = line.split("\t");
    const rawPath = parts.slice(2).join("\t");
    if (rawPath.length === 0) continue;
    stats.set(normalizeGitPath(normalizeNumStatPath(rawPath)), {
      additions: parseStatCount(parts[0]),
      deletions: parseStatCount(parts[1]),
    });
  }

  return stats;
}

function countContentLines(content: string): number {
  if (content.length === 0) return 0;
  const lines = content.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.length;
}

function toDisplayPath(change: ChangedPath): string {
  if (change.status === "renamed") {
    return `${change.oldPath ?? ""} -> ${change.newPath ?? ""}`;
  }
  return change.newPath ?? change.oldPath ?? "(unknown)";
}

function toComparison(change: ChangedPath, stats?: ChangeStats): ReviewFileComparison {
  return {
    status: change.status,
    oldPath: change.oldPath,
    newPath: change.newPath,
    displayPath: toDisplayPath(change),
    hasOriginal: change.oldPath != null,
    hasModified: change.newPath != null,
    additions: stats?.additions,
    deletions: stats?.deletions,
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
    allFilesReferenceCount: seed.allFilesReferenceCount,
    allFilesOutgoingReferences: seed.allFilesOutgoingReferences,
    allFilesIncomingReferences: seed.allFilesIncomingReferences,
  };
}

export function isPathInside(parentPath: string, childPath: string): boolean {
  const relativePath = relative(parentPath, childPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

export function isReviewFileSizeAllowed(size: number): boolean {
  return size <= MAX_REVIEW_FILE_BYTES;
}

export function limitReviewItems<T>(items: T[]): T[] {
  return items.length <= MAX_REVIEW_FILE_COUNT ? items : items.slice(0, MAX_REVIEW_FILE_COUNT);
}

async function getRevisionContent(pi: ExtensionAPI, repoRoot: string, revision: string, path: string): Promise<string> {
  const objectSpec = `${revision}:${path}`;
  const sizeResult = await pi.exec("git", ["cat-file", "-s", objectSpec], { cwd: repoRoot });
  if (sizeResult.code === 0) {
    const size = Number.parseInt(sizeResult.stdout.trim(), 10);
    if (Number.isFinite(size) && !isReviewFileSizeAllowed(size)) return "";
  }

  const result = await pi.exec("git", ["show", objectSpec], { cwd: repoRoot });
  if (result.code !== 0) return "";
  return result.stdout;
}

export async function getWorkingTreeContent(repoRoot: string, path: string): Promise<string> {
  try {
    const realRepoRoot = await realpath(repoRoot);
    const candidatePath = resolve(realRepoRoot, path);
    if (!isPathInside(realRepoRoot, candidatePath)) return "";

    const linkStats = await lstat(candidatePath);
    const targetPath = linkStats.isSymbolicLink() ? await realpath(candidatePath) : candidatePath;
    if (!isPathInside(realRepoRoot, targetPath)) return "";

    const targetStats = linkStats.isSymbolicLink() ? await stat(targetPath) : linkStats;
    if (!targetStats.isFile() || !isReviewFileSizeAllowed(targetStats.size)) return "";

    return await readFile(targetPath, "utf8");
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

function normalizeGitPath(path: string): string {
  return posix.normalize(path).replace(/^\.\//, "");
}

function getChangeKey(change: ChangedPath): string {
  return change.newPath ?? change.oldPath ?? toDisplayPath(change);
}

function getImportAliases(path: string): string[] {
  const normalized = normalizeGitPath(path);
  const aliases = [normalized];
  const extension = posix.extname(normalized);

  if (extension.length > 0) {
    aliases.push(normalized.slice(0, -extension.length));
  }

  const directory = posix.dirname(normalized);
  const basename = posix.basename(normalized, extension);
  if (basename === "index" && directory !== ".") {
    aliases.push(directory);
  }

  return aliases;
}

function extractImportSpecifiers(content: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g,
    /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];

  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier != null) specifiers.push(specifier);
    }
  }

  return specifiers;
}

function resolveRelativeImport(sourcePath: string, specifier: string, aliases: Map<string, string>): string | null {
  if (!specifier.startsWith(".")) return null;
  const resolved = normalizeGitPath(posix.join(posix.dirname(sourcePath), specifier));
  return aliases.get(resolved) ?? null;
}

export interface ChangedFileReferenceGraph {
  counts: Map<string, number>;
  outgoing: Map<string, string[]>;
  incoming: Map<string, string[]>;
}

export function getChangedFileReferenceGraph(changes: ChangedPath[], contentsByPath: Map<string, string>): ChangedFileReferenceGraph {
  const paths = changes.map(getChangeKey).map(normalizeGitPath);
  const pathSet = new Set(paths);
  const aliases = new Map<string, string>();
  const counts = new Map<string, number>(paths.map((path) => [path, 0]));
  const outgoingSets = new Map<string, Set<string>>(paths.map((path) => [path, new Set<string>()]));
  const incomingSets = new Map<string, Set<string>>(paths.map((path) => [path, new Set<string>()]));

  for (const path of paths) {
    for (const alias of getImportAliases(path)) {
      if (!aliases.has(alias)) aliases.set(alias, path);
    }
  }

  for (const change of changes) {
    if (change.newPath == null) continue;
    const sourcePath = normalizeGitPath(change.newPath);
    const content = contentsByPath.get(sourcePath) ?? contentsByPath.get(change.newPath) ?? "";
    const referencedPaths = new Set<string>();

    for (const specifier of extractImportSpecifiers(content)) {
      const referencedPath = resolveRelativeImport(sourcePath, specifier, aliases);
      if (referencedPath == null || referencedPath === sourcePath || !pathSet.has(referencedPath)) continue;
      referencedPaths.add(referencedPath);
    }

    for (const referencedPath of referencedPaths) {
      counts.set(referencedPath, (counts.get(referencedPath) ?? 0) + 1);
      outgoingSets.get(sourcePath)?.add(referencedPath);
      incomingSets.get(referencedPath)?.add(sourcePath);
    }
  }

  const toSortedArrays = (map: Map<string, Set<string>>): Map<string, string[]> => new Map(
    [...map.entries()].map(([path, relatedPaths]) => [path, [...relatedPaths].sort((a, b) => a.localeCompare(b))]),
  );

  return {
    counts,
    outgoing: toSortedArrays(outgoingSets),
    incoming: toSortedArrays(incomingSets),
  };
}

export function getChangedFileReferenceCounts(changes: ChangedPath[], contentsByPath: Map<string, string>): Map<string, number> {
  return getChangedFileReferenceGraph(changes, contentsByPath).counts;
}

function compareReviewFiles(a: ReviewFile, b: ReviewFile): number {
  return a.path.localeCompare(b.path);
}

function getLocalReviewLimitRank(file: ReviewFile): number {
  if (file.inGitDiff) return 0;
  if (file.inLastCommit) return 1;
  if (file.inAllFiles) return 2;
  return 3;
}

function compareLocalReviewFilesForLimit(a: ReviewFile, b: ReviewFile): number {
  const scopeDelta = getLocalReviewLimitRank(a) - getLocalReviewLimitRank(b);
  if (scopeDelta !== 0) return scopeDelta;
  return compareReviewFiles(a, b);
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
    allFilesReferenceCount: 0,
    allFilesOutgoingReferences: [],
    allFilesIncomingReferences: [],
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

export interface LocalBranchRef {
  name: string;
  commit: string;
}

export interface AncestorBranchCandidate {
  name: string;
  distanceFromHead: number;
}

export function parseLocalBranchRefs(output: string): LocalBranchRef[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      const separatorIndex = line.indexOf("\t");
      if (separatorIndex <= 0) return [];
      const name = line.slice(0, separatorIndex).trim();
      const commit = line.slice(separatorIndex + 1).trim();
      if (name.length === 0 || commit.length === 0) return [];
      return [{ name, commit }];
    });
}

export function selectClosestAncestorBranch(candidates: AncestorBranchCandidate[]): string | null {
  const sorted = candidates
    .filter((candidate) => candidate.distanceFromHead > 0)
    .sort((a, b) => a.distanceFromHead - b.distanceFromHead || a.name.localeCompare(b.name));
  return sorted[0]?.name ?? null;
}

async function getCurrentBranchName(pi: ExtensionAPI, repoRoot: string): Promise<string | null> {
  const result = await pi.exec("git", ["branch", "--show-current"], { cwd: repoRoot });
  if (result.code !== 0) return null;
  return result.stdout.trim() || null;
}

async function getClosestAncestorBranchRef(pi: ExtensionAPI, repoRoot: string, currentBranch: string | null): Promise<string | null> {
  if (currentBranch == null) return null;

  const branchRefsOutput = await runGitAllowFailure(pi, repoRoot, ["for-each-ref", "--format=%(refname:short)%09%(objectname)", "refs/heads"]);
  const localBranches = parseLocalBranchRefs(branchRefsOutput).filter((branch) => branch.name !== currentBranch);
  const candidates: AncestorBranchCandidate[] = [];

  for (const branch of localBranches) {
    const ancestorResult = await pi.exec("git", ["merge-base", "--is-ancestor", branch.name, "HEAD"], { cwd: repoRoot });
    if (ancestorResult.code !== 0) continue;

    const distanceResult = await pi.exec("git", ["rev-list", "--count", `${branch.name}..HEAD`], { cwd: repoRoot });
    if (distanceResult.code !== 0) continue;

    const distanceFromHead = Number.parseInt(distanceResult.stdout.trim(), 10);
    if (!Number.isFinite(distanceFromHead)) continue;
    candidates.push({ name: branch.name, distanceFromHead });
  }

  return selectClosestAncestorBranch(candidates);
}

export async function getBranchBaseRef(pi: ExtensionAPI, repoRoot: string): Promise<string | null> {
  const currentBranch = await getCurrentBranchName(pi, repoRoot);
  const closestAncestorBranch = await getClosestAncestorBranchRef(pi, repoRoot, currentBranch);
  if (closestAncestorBranch != null) return closestAncestorBranch;
  return getDefaultBranchRef(pi, repoRoot);
}

async function getBranchBaseRevision(pi: ExtensionAPI, repoRoot: string): Promise<string | null> {
  const branchBaseRef = await getBranchBaseRef(pi, repoRoot);
  if (branchBaseRef == null) return null;
  const result = await pi.exec("git", ["merge-base", branchBaseRef, "HEAD"], { cwd: repoRoot });
  if (result.code !== 0) return null;
  return result.stdout.trim() || null;
}

export async function getReviewWindowData(pi: ExtensionAPI, cwd: string): Promise<ReviewWindowData> {
  const repoRoot = await getRepoRoot(pi, cwd);
  const repositoryHasHead = await hasHead(pi, repoRoot);

  const trackedDiffOutput = repositoryHasHead
    ? await runGit(pi, repoRoot, ["diff", "--find-renames", "-M", "--name-status", "HEAD", "--"])
    : "";
  const worktreeNumStatOutput = repositoryHasHead
    ? await runGitAllowFailure(pi, repoRoot, ["diff", "--find-renames", "-M", "--numstat", "HEAD", "--"])
    : "";
  const untrackedOutput = await runGitAllowFailure(pi, repoRoot, ["ls-files", "--others", "--exclude-standard"]);
  const statusOutput = await runGitAllowFailure(pi, repoRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const trackedFilesOutput = await runGitAllowFailure(pi, repoRoot, ["ls-files", "--cached"]);
  const deletedFilesOutput = await runGitAllowFailure(pi, repoRoot, ["ls-files", "--deleted"]);
  const lastCommitOutput = repositoryHasHead
    ? await runGitAllowFailure(pi, repoRoot, ["diff-tree", "--root", "--find-renames", "-M", "--name-status", "--no-commit-id", "-r", "HEAD"])
    : "";
  const lastCommitNumStatOutput = repositoryHasHead
    ? await runGitAllowFailure(pi, repoRoot, ["diff-tree", "--root", "--find-renames", "-M", "--numstat", "--no-commit-id", "-r", "HEAD"])
    : "";
  const branchBaseRevision = repositoryHasHead ? await getBranchBaseRevision(pi, repoRoot) : null;
  const branchDiffOutput = branchBaseRevision == null
    ? ""
    : await runGitAllowFailure(pi, repoRoot, ["diff", "--find-renames", "-M", "--name-status", branchBaseRevision, "HEAD", "--"]);
  const branchNumStatOutput = branchBaseRevision == null
    ? ""
    : await runGitAllowFailure(pi, repoRoot, ["diff", "--find-renames", "-M", "--numstat", branchBaseRevision, "HEAD", "--"]);

  const untrackedChanges = parseUntrackedPaths(untrackedOutput);
  const statusChanges = parseStatusPorcelain(statusOutput);
  const diffChanges = mergeChangedPaths(parseNameStatus(trackedDiffOutput), untrackedChanges);
  const localChanges = statusChanges.length > 0 ? mergeMissingChangedPaths(statusChanges, diffChanges) : diffChanges;
  const lastCommitStats = parseNumStat(lastCommitNumStatOutput);
  const branchStats = parseNumStat(branchNumStatOutput);
  const worktreeChanges = limitReviewItems(localChanges
    .filter((change) => isReviewableFilePath(change.newPath ?? change.oldPath ?? "")));
  const worktreeStats = parseNumStat(worktreeNumStatOutput);
  await Promise.all(worktreeChanges.map(async (change) => {
    if (change.oldPath != null || change.newPath == null || worktreeStats.has(normalizeGitPath(change.newPath))) return;
    const content = await getWorkingTreeContent(repoRoot, change.newPath);
    worktreeStats.set(normalizeGitPath(change.newPath), { additions: countContentLines(content), deletions: 0 });
  }));
  const deletedPaths = new Set(parseTrackedPaths(deletedFilesOutput));
  const statusCurrentPaths = statusChanges.flatMap((change) => (change.newPath == null ? [] : [change.newPath]));
  const currentPaths = limitReviewItems(uniquePaths([...parseTrackedPaths(trackedFilesOutput), ...parseTrackedPaths(untrackedOutput), ...statusCurrentPaths])
    .filter((path) => !deletedPaths.has(path))
    .filter(isReviewableFilePath));
  const currentPathSet = new Set(currentPaths);
  const lastCommitChanges = limitReviewItems(parseNameStatus(lastCommitOutput)
    .filter((change) => isReviewableFilePath(change.newPath ?? change.oldPath ?? "")));
  const branchChanges = limitReviewItems(parseNameStatus(branchDiffOutput)
    .filter((change) => isReviewableFilePath(change.newPath ?? change.oldPath ?? "")));
  const branchContentsByPath = new Map<string, string>();
  await Promise.all(branchChanges.map(async (change) => {
    if (change.newPath == null) return;
    branchContentsByPath.set(normalizeGitPath(change.newPath), await getWorkingTreeContent(repoRoot, change.newPath));
  }));
  const branchReferenceGraph = getChangedFileReferenceGraph(branchChanges, branchContentsByPath);

  const seeds = new Map<string, ReviewFileSeed>();

  for (const change of worktreeChanges) {
    const key = getChangeKey(change);
    const seed = upsertSeed(seeds, key, () => createSeed(key, change.newPath != null));
    seed.worktreeStatus = change.status;
    seed.hasWorkingTreeFile = change.newPath != null;
    seed.inGitDiff = true;
    seed.gitDiff = toComparison(change, worktreeStats.get(normalizeGitPath(key)));
  }

  for (const change of branchChanges) {
    const key = getChangeKey(change);
    const seed = upsertSeed(seeds, key, () => createSeed(key, change.newPath != null && currentPathSet.has(change.newPath)));
    seed.inAllFiles = true;
    seed.allFiles = toComparison(change, branchStats.get(normalizeGitPath(key)));
    seed.allFilesReferenceCount = branchReferenceGraph.counts.get(normalizeGitPath(key)) ?? 0;
    seed.allFilesOutgoingReferences = branchReferenceGraph.outgoing.get(normalizeGitPath(key)) ?? [];
    seed.allFilesIncomingReferences = branchReferenceGraph.incoming.get(normalizeGitPath(key)) ?? [];
  }

  for (const change of lastCommitChanges) {
    const key = getChangeKey(change);
    const seed = upsertSeed(seeds, key, () => createSeed(key, change.newPath != null && currentPathSet.has(change.newPath)));
    seed.inLastCommit = true;
    seed.lastCommit = toComparison(change, lastCommitStats.get(normalizeGitPath(key)));
  }

  if (seeds.size === 0) {
    for (const path of currentPaths) {
      const seed = createSeed(path, true);
      seed.inAllFiles = true;
      seeds.set(path, seed);
    }
  }

  const files = limitReviewItems([...seeds.values()].map(createReviewFile).sort(compareLocalReviewFilesForLimit));
  return { repoRoot, files, branchBaseRevision, visibleScopes: ["git-diff", "last-commit"] };
}

export async function getReviewWindowDataForRevisionRange(pi: ExtensionAPI, cwd: string, branchBaseRevision: string, modifiedRevision: string): Promise<ReviewWindowData> {
  const repoRoot = await getRepoRoot(pi, cwd);
  const branchDiffOutput = await runGitAllowFailure(pi, repoRoot, ["diff", "--find-renames", "-M", "--name-status", branchBaseRevision, modifiedRevision, "--"]);
  const branchNumStatOutput = await runGitAllowFailure(pi, repoRoot, ["diff", "--find-renames", "-M", "--numstat", branchBaseRevision, modifiedRevision, "--"]);
  const branchStats = parseNumStat(branchNumStatOutput);
  const branchChanges = limitReviewItems(parseNameStatus(branchDiffOutput)
    .filter((change) => isReviewableFilePath(change.newPath ?? change.oldPath ?? "")));
  const branchContentsByPath = new Map<string, string>();

  await Promise.all(branchChanges.map(async (change) => {
    if (change.newPath == null) return;
    branchContentsByPath.set(normalizeGitPath(change.newPath), await getRevisionContent(pi, repoRoot, modifiedRevision, change.newPath));
  }));

  const branchReferenceGraph = getChangedFileReferenceGraph(branchChanges, branchContentsByPath);
  const seeds = new Map<string, ReviewFileSeed>();

  for (const change of branchChanges) {
    const key = getChangeKey(change);
    const seed = upsertSeed(seeds, key, () => createSeed(key, false));
    seed.inAllFiles = true;
    seed.allFiles = toComparison(change, branchStats.get(normalizeGitPath(key)));
    seed.allFilesReferenceCount = branchReferenceGraph.counts.get(normalizeGitPath(key)) ?? 0;
    seed.allFilesOutgoingReferences = branchReferenceGraph.outgoing.get(normalizeGitPath(key)) ?? [];
    seed.allFilesIncomingReferences = branchReferenceGraph.incoming.get(normalizeGitPath(key)) ?? [];
  }

  const files = limitReviewItems([...seeds.values()].map(createReviewFile).sort(compareReviewFiles));
  return { repoRoot, files, branchBaseRevision, modifiedRevision, visibleScopes: ["all-files"] };
}

export async function loadReviewFileContents(pi: ExtensionAPI, repoRoot: string, file: ReviewFile, scope: ReviewScope, branchBaseRevision?: string | null, modifiedRevision = "HEAD"): Promise<ReviewFileContents> {
  const comparison = scope === "git-diff" ? file.gitDiff : scope === "last-commit" ? file.lastCommit : file.allFiles;

  if (scope === "all-files" && comparison == null) {
    const content = file.hasWorkingTreeFile ? await getWorkingTreeContent(repoRoot, file.path) : "";
    return { originalContent: content, modifiedContent: content };
  }

  if (comparison == null) {
    return { originalContent: "", modifiedContent: "" };
  }

  const allFilesBaseRevision = scope === "all-files" ? branchBaseRevision ?? await getBranchBaseRevision(pi, repoRoot) : null;
  const originalRevision = scope === "git-diff" ? "HEAD" : scope === "last-commit" ? "HEAD^" : allFilesBaseRevision;
  const comparisonModifiedRevision = scope === "git-diff" ? null : scope === "last-commit" ? "HEAD" : modifiedRevision;

  const originalContent = comparison.oldPath == null || originalRevision == null ? "" : await getRevisionContent(pi, repoRoot, originalRevision, comparison.oldPath);
  const modifiedContent = comparison.newPath == null
    ? ""
    : comparisonModifiedRevision == null
      ? await getWorkingTreeContent(repoRoot, comparison.newPath)
      : await getRevisionContent(pi, repoRoot, comparisonModifiedRevision, comparison.newPath);

  return { originalContent, modifiedContent };
}
