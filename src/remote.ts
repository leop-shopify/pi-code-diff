import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, posix } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getDefaultBranchRef } from "./git.js";
import { getShortcutConfigPath } from "./shortcuts.js";

export interface RemoteParseResult {
  branch: string;
  repo?: string;
  prNumber?: string;
}

export interface StackParentMetadata {
  number: string;
  title: string;
  headRefName: string;
  state: string;
  url?: string;
}

export interface PullRequestMetadata {
  number: string;
  repo?: string;
  title: string;
  body: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  authorLogin: string;
  state: string;
  reviews: Array<{ author: { login: string }; state: string }>;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  stackParent?: StackParentMetadata;
}

export interface RemoteReviewTarget {
  gitRoot: string;
  baseRef: string;
  headRef: string;
  remote: string;
  branch: string;
  repo?: string;
  pullRequest?: PullRequestMetadata;
  workspacePath?: string;
  pathspecs?: string[];
  importAliases?: Record<string, string>;
}

export type RemoteProgress = (message: string) => void;

function originRef(branch: string): string {
  return `refs/remotes/origin/${branch}`;
}

function originShortRef(branch: string): string {
  return `origin/${branch}`;
}

function sourceBranchRef(branch: string): string {
  return `refs/heads/${branch}`;
}

function stripOriginPrefix(ref: string): string {
  return ref.replace(/^origin\//, "");
}

export function extractBranchFromRemote(input: string): RemoteParseResult | null {
  const trimmed = input.trim();
  const ghMatch = trimmed.match(/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/);
  if (ghMatch != null) return { branch: `__pr__${ghMatch[2]}`, repo: ghMatch[1], prNumber: ghMatch[2] };

  const graphiteMatch = trimmed.match(/graphite\.dev\/github\/pr\/([^/\s]+\/[^/\s]+)\/(\d+)/);
  if (graphiteMatch != null) return { branch: `__pr__${graphiteMatch[2]}`, repo: graphiteMatch[1], prNumber: graphiteMatch[2] };

  const shortMatch = trimmed.match(/^([^/\s]+\/[^#\s]+)#(\d+)$/);
  if (shortMatch != null) return { branch: `__pr__${shortMatch[2]}`, repo: shortMatch[1], prNumber: shortMatch[2] };

  if (/^[\w./-]+$/.test(trimmed)) return { branch: trimmed };
  return null;
}

interface RemoteRepositoryConfig {
  cwd?: unknown;
  path?: unknown;
  subdir?: unknown;
  pathspecs?: unknown;
  importAliases?: unknown;
}

interface ConfiguredRepositoryProfile {
  gitRoot: string;
  workspacePath?: string;
  pathspecs?: string[];
  importAliases?: Record<string, string>;
}

interface CodeDiffConfigFile {
  repositories?: Record<string, string | RemoteRepositoryConfig>;
}

function normalizeRepoName(repo: string): string {
  return repo.trim().toLowerCase();
}

function getCodeDiffConfigPath(): string {
  return process.env.PI_CODE_DIFF_CONFIG_PATH ?? getShortcutConfigPath();
}

function normalizeConfiguredPathspec(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0 || isAbsolute(value)) return undefined;
  const normalized = posix.normalize(value.trim().replace(/\\/g, "/")).replace(/^\.\//, "");
  return normalized === "." || normalized === ".." || normalized.startsWith("../") ? undefined : normalized;
}

function getConfiguredRepositoryProfile(repo: string): ConfiguredRepositoryProfile | undefined {
  const configPath = getCodeDiffConfigPath();
  if (!existsSync(configPath)) return undefined;

  let config: CodeDiffConfigFile;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8")) as CodeDiffConfigFile;
  } catch {
    return undefined;
  }

  const repositories = config.repositories ?? {};
  const entry = repositories[repo] ?? repositories[normalizeRepoName(repo)];
  const candidate = typeof entry === "string" ? entry : typeof entry?.cwd === "string" ? entry.cwd : typeof entry?.path === "string" ? entry.path : undefined;
  if (candidate == null || !existsSync(candidate)) return undefined;
  if (typeof entry === "string") return { gitRoot: candidate };

  const workspacePath = normalizeConfiguredPathspec(entry.subdir);
  if (entry.subdir != null && workspacePath == null) throw new Error(`Invalid subdir configured for ${repo}.`);
  const configuredPathspecs = Array.isArray(entry.pathspecs)
    ? entry.pathspecs.map(normalizeConfiguredPathspec).filter((path): path is string => path != null)
    : [];
  if (Array.isArray(entry.pathspecs) && configuredPathspecs.length !== entry.pathspecs.length) {
    throw new Error(`Invalid pathspec configured for ${repo}.`);
  }
  const pathspecs = configuredPathspecs.length > 0 ? [...new Set(configuredPathspecs)] : workspacePath == null ? undefined : [workspacePath];
  const importAliases = entry.importAliases != null && typeof entry.importAliases === "object" && !Array.isArray(entry.importAliases)
    ? Object.fromEntries(Object.entries(entry.importAliases)
        .map(([prefix, target]) => [prefix.trim(), normalizeConfiguredPathspec(target)] as const)
        .filter((item): item is readonly [string, string] => item[0].length > 0 && item[1] != null))
    : undefined;
  if (entry.importAliases != null && (importAliases == null || Object.keys(importAliases).length !== Object.keys(entry.importAliases as object).length)) {
    throw new Error(`Invalid import alias configured for ${repo}.`);
  }
  return { gitRoot: candidate, workspacePath, pathspecs, importAliases };
}

function repoMatchesRemoteUrl(repo: string, remoteUrl: string): boolean {
  const normalizedRepo = normalizeRepoName(repo).replace(/\.git$/, "");
  const normalizedRemote = remoteUrl.trim().toLowerCase().replace(/\.git$/, "");
  return normalizedRemote.endsWith(`/${normalizedRepo}`) || normalizedRemote.endsWith(`:${normalizedRepo}`);
}

async function getMatchingLocalRepoRoot(pi: ExtensionAPI, cwd: string, repo: string): Promise<string | undefined> {
  const rootResult = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 10000 });
  if (rootResult.code !== 0) return undefined;

  const gitRoot = rootResult.stdout.trim();
  if (gitRoot.length === 0) return undefined;

  const remoteResult = await pi.exec("git", ["remote", "get-url", "origin"], { cwd: gitRoot, timeout: 10000 });
  if (remoteResult.code !== 0 || !repoMatchesRemoteUrl(repo, remoteResult.stdout)) return undefined;
  return gitRoot;
}

function getRemoteCacheRoot(repo: string): string {
  const safeParts = repo.split("/").map((part) => part.replace(/[^\w.-]/g, "_")).filter(Boolean);
  const root = process.env.PI_CODE_DIFF_REMOTE_CACHE_ROOT ?? join(homedir(), ".pi", "agent", "cache", "pi-code-diff", "remotes");
  return join(root, ...safeParts);
}

async function ensureRemoteCacheRepo(pi: ExtensionAPI, repo: string, onProgress?: RemoteProgress): Promise<string> {
  const gitRoot = getRemoteCacheRoot(repo);
  onProgress?.(`Preparing remote review cache for ${repo}…`);
  await mkdir(gitRoot, { recursive: true });
  if (!existsSync(join(gitRoot, ".git"))) {
    const result = await pi.exec("git", ["init"], { cwd: gitRoot, timeout: 10000 });
    if (result.code !== 0) throw new Error(result.stderr || result.stdout || `Could not initialize remote review cache for ${repo}.`);
  }

  const ok = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd: gitRoot, timeout: 10000 });
  if (ok.code !== 0) throw new Error(`Remote review cache is not a usable git repository at ${gitRoot}.`);
  return ok.stdout.trim() || gitRoot;
}

async function validateConfiguredRepoRoot(pi: ExtensionAPI, repo: string, gitRoot: string): Promise<void> {
  const remoteResult = await pi.exec("git", ["remote", "get-url", "--all", "origin"], { cwd: gitRoot, timeout: 10000 });
  const matches = remoteResult.code === 0 && remoteResult.stdout.split(/\r?\n/).some((url) => repoMatchesRemoteUrl(repo, url));
  if (!matches) throw new Error(`Configured checkout ${gitRoot} does not match ${repo}.`);
}

async function resolveRepoRoot(pi: ExtensionAPI, fallbackCwd: string, repo: string | undefined, explicitCwd: string | undefined, onProgress?: RemoteProgress): Promise<{ gitRoot: string; fetchRemote?: string; workspacePath?: string; pathspecs?: string[]; importAliases?: Record<string, string> }> {
  if (explicitCwd != null) {
    onProgress?.(`Using local checkout ${explicitCwd}…`);
    return { gitRoot: explicitCwd };
  }
  if (repo == null) {
    onProgress?.("Using current repository for remote branch review…");
    return { gitRoot: fallbackCwd };
  }

  const configuredProfile = getConfiguredRepositoryProfile(repo);
  if (configuredProfile != null) {
    await validateConfiguredRepoRoot(pi, repo, configuredProfile.gitRoot);
    onProgress?.(`Using configured checkout for ${repo}${configuredProfile.workspacePath == null ? "" : ` at ${configuredProfile.workspacePath}`}…`);
    return configuredProfile;
  }

  const localRoot = await getMatchingLocalRepoRoot(pi, fallbackCwd, repo);
  if (localRoot != null) {
    onProgress?.(`Using current checkout for ${repo}…`);
    return { gitRoot: localRoot };
  }

  return {
    gitRoot: await ensureRemoteCacheRepo(pi, repo, onProgress),
    fetchRemote: `https://github.com/${repo}.git`,
  };
}

function ghArgs(args: string[], repo: string | undefined): string[] {
  return repo == null ? args : [...args, "--repo", repo];
}

function isDefaultBaseBranch(branch: string): boolean {
  return branch === "main" || branch === "master";
}

function toStackParentMetadata(input: { number?: number | string; title?: string; headRefName?: string; state?: string; url?: string }, fallbackHeadRefName: string): StackParentMetadata | undefined {
  if (input.number == null) return undefined;
  return {
    number: String(input.number),
    title: input.title ?? `(PR #${input.number})`,
    headRefName: input.headRefName ?? fallbackHeadRefName,
    state: input.state ?? "UNKNOWN",
    url: input.url,
  };
}

async function getStackParentMetadataForHead(pi: ExtensionAPI, gitRoot: string, headRefName: string, repo?: string, onProgress?: RemoteProgress): Promise<StackParentMetadata | undefined> {
  if (isDefaultBaseBranch(headRefName)) return undefined;

  onProgress?.(`Checking stack parent PR for ${headRefName}…`);
  const result = await pi.exec("gh", ghArgs(["pr", "list", "--state", "all", "--head", headRefName, "--json", "number,title,headRefName,state,url", "--limit", "1"], repo), { cwd: gitRoot, timeout: 15000 });
  if (result.code !== 0 || result.stdout.trim().length === 0) return undefined;

  try {
    const [parent] = JSON.parse(result.stdout.trim()) as Array<{
      number?: number | string;
      title?: string;
      headRefName?: string;
      state?: string;
      url?: string;
    }>;
    return parent == null ? undefined : toStackParentMetadata(parent, headRefName);
  } catch {
    return undefined;
  }
}

async function listStackParentCandidates(pi: ExtensionAPI, gitRoot: string, metadata: PullRequestMetadata, repo?: string, onProgress?: RemoteProgress): Promise<StackParentMetadata[]> {
  onProgress?.("Checking stack parent PR candidates…");
  const result = await pi.exec("gh", ghArgs(["pr", "list", "--state", "all", "--json", "number,title,headRefName,state,url", "--limit", "100"], repo), { cwd: gitRoot, timeout: 15000 });
  if (result.code !== 0 || result.stdout.trim().length === 0) return [];

  try {
    const parsed = JSON.parse(result.stdout.trim()) as Array<{
      number?: number | string;
      title?: string;
      headRefName?: string;
      state?: string;
      url?: string;
    }>;
    return parsed
      .map((candidate) => toStackParentMetadata(candidate, candidate.headRefName ?? ""))
      .filter((candidate): candidate is StackParentMetadata => candidate != null)
      .filter((candidate) => candidate.number !== metadata.number)
      .filter((candidate) => candidate.headRefName.length > 0)
      .filter((candidate) => candidate.headRefName !== metadata.headRefName)
      .filter((candidate) => candidate.headRefName !== metadata.baseRefName)
      .filter((candidate) => !isDefaultBaseBranch(candidate.headRefName));
  } catch {
    return [];
  }
}

async function getRefDistance(pi: ExtensionAPI, gitRoot: string, baseRef: string, headRef: string): Promise<number | undefined> {
  const result = await pi.exec("git", ["rev-list", "--count", `${baseRef}..${headRef}`], { cwd: gitRoot, timeout: 10000 });
  if (result.code !== 0) return undefined;
  const distance = Number.parseInt(result.stdout.trim(), 10);
  return Number.isFinite(distance) ? distance : undefined;
}

async function isAncestorRef(pi: ExtensionAPI, gitRoot: string, candidateRef: string, headRef: string): Promise<boolean> {
  const result = await pi.exec("git", ["merge-base", "--is-ancestor", candidateRef, headRef], { cwd: gitRoot, timeout: 10000 });
  return result.code === 0;
}

async function fetchStackParentCandidateRef(pi: ExtensionAPI, gitRoot: string, candidate: StackParentMetadata, remote = "origin", repo?: string): Promise<string | undefined> {
  try {
    await fetchRemoteRefs(pi, gitRoot, [`+${sourceBranchRef(candidate.headRefName)}:${originRef(candidate.headRefName)}`], remote);
    return originShortRef(candidate.headRefName);
  } catch {
    const prHeadBranch = `stack-parent/${candidate.number}/head`;
    const pullRemote = repo == null || remote !== "origin" ? remote : `https://github.com/${repo}.git`;
    try {
      await fetchRemoteRefs(pi, gitRoot, [`+refs/pull/${candidate.number}/head:${originRef(prHeadBranch)}`], pullRemote);
      return originShortRef(prHeadBranch);
    } catch {
      return undefined;
    }
  }
}

function shouldScanStackParentCandidates(): boolean {
  return process.env.PI_CODE_DIFF_SCAN_STACK_PARENTS === "1";
}

async function findClosestStackParent(pi: ExtensionAPI, gitRoot: string, metadata: PullRequestMetadata, currentBaseRef: string, headRef: string, remote = "origin", repo?: string, onProgress?: RemoteProgress): Promise<{ baseRef: string; stackParent: StackParentMetadata } | undefined> {
  const candidates = await listStackParentCandidates(pi, gitRoot, metadata, repo, onProgress);
  if (candidates.length === 0) return undefined;

  const currentBaseDistance = await getRefDistance(pi, gitRoot, currentBaseRef, headRef);
  if (currentBaseDistance == null) return undefined;

  let best: { candidate: StackParentMetadata; ref: string; distance: number } | undefined;

  for (const candidate of candidates) {
    const candidateRef = await fetchStackParentCandidateRef(pi, gitRoot, candidate, remote, repo);
    if (candidateRef == null) continue;
    if (!await isAncestorRef(pi, gitRoot, candidateRef, headRef)) continue;

    const distance = await getRefDistance(pi, gitRoot, candidateRef, headRef);
    if (distance == null || distance <= 0) continue;
    if (distance >= currentBaseDistance) continue;
    if (best == null || distance < best.distance || (distance === best.distance && candidate.headRefName.localeCompare(best.candidate.headRefName) < 0)) {
      best = { candidate, ref: candidateRef, distance };
    }
  }

  return best == null ? undefined : { baseRef: await getMergeBase(pi, gitRoot, best.ref, headRef), stackParent: best.candidate };
}

export async function getPullRequestMetadata(pi: ExtensionAPI, gitRoot: string, prNumber: string, repo?: string, onProgress?: RemoteProgress): Promise<PullRequestMetadata> {
  onProgress?.(`Fetching PR #${prNumber} metadata${repo == null ? "" : ` from ${repo}`}…`);
  const result = await pi.exec("gh", ghArgs(["pr", "view", prNumber, "--json", "title,body,additions,deletions,changedFiles,author,reviews,state,headRefName,headRefOid,baseRefName"], repo), { cwd: gitRoot, timeout: 15000 });
  if (result.code !== 0 || result.stdout.trim().length === 0) {
    throw new Error(`Could not resolve PR #${prNumber}: ${result.stderr || "empty gh response"}`);
  }

  const parsed = JSON.parse(result.stdout.trim()) as {
    title?: string;
    body?: string;
    additions?: number;
    deletions?: number;
    changedFiles?: number;
    author?: { login?: string };
    state?: string;
    reviews?: Array<{ author: { login: string }; state: string }>;
    headRefName?: string;
    headRefOid?: string;
    baseRefName?: string;
  };

  if (parsed.headRefName == null || parsed.headRefOid == null) throw new Error(`PR #${prNumber} metadata is missing head ref information.`);

  const baseRefName = parsed.baseRefName ?? "main";
  const stackParent = await getStackParentMetadataForHead(pi, gitRoot, baseRefName, repo, onProgress);

  return {
    number: prNumber,
    repo,
    title: parsed.title ?? `(PR #${prNumber})`,
    body: parsed.body ?? "",
    additions: parsed.additions ?? 0,
    deletions: parsed.deletions ?? 0,
    changedFiles: parsed.changedFiles ?? 0,
    authorLogin: parsed.author?.login ?? "unknown",
    state: parsed.state ?? "UNKNOWN",
    reviews: parsed.reviews ?? [],
    headRefName: parsed.headRefName,
    headRefOid: parsed.headRefOid,
    baseRefName,
    stackParent,
  };
}

async function fetchRemoteRefs(pi: ExtensionAPI, gitRoot: string, refspecs: string[], remote = "origin", onProgress?: RemoteProgress): Promise<void> {
  onProgress?.(`Fetching remote refs from ${remote === "origin" ? "origin" : "GitHub"}…`);
  const result = await pi.exec("git", ["--no-pager", "fetch", "--no-tags", remote, ...refspecs], { cwd: gitRoot, timeout: 60000 });
  if (result.killed) throw new Error(`Timed out fetching remote refs after 60s. stderr: ${result.stderr || "(none)"}`);
  if (result.code !== 0) throw new Error(result.stderr || result.stdout || "Failed to fetch remote refs.");
}

async function getMergeBase(pi: ExtensionAPI, gitRoot: string, baseRef: string, headRef: string): Promise<string> {
  const result = await pi.exec("git", ["merge-base", baseRef, headRef], { cwd: gitRoot, timeout: 10000 });
  const mergeBase = result.code === 0 ? result.stdout.trim().split("\n").pop()?.trim() : undefined;
  return mergeBase != null && mergeBase.length > 0 ? mergeBase : baseRef;
}

async function fetchPullRequestRefs(pi: ExtensionAPI, gitRoot: string, metadata: PullRequestMetadata, remote = "origin", onProgress?: RemoteProgress): Promise<{ baseRef: string; headRef: string }> {
  const baseBranch = metadata.baseRefName || "main";
  try {
    await fetchRemoteRefs(pi, gitRoot, [
      `+${sourceBranchRef(baseBranch)}:${originRef(baseBranch)}`,
      `+${sourceBranchRef(metadata.headRefName)}:${originRef(metadata.headRefName)}`,
    ], remote, onProgress);
    const baseRef = originShortRef(baseBranch);
    const headRef = originShortRef(metadata.headRefName);
    return { baseRef: await getMergeBase(pi, gitRoot, baseRef, headRef), headRef };
  } catch {
    const prHeadBranch = `pr/${metadata.number}/head`;
    const pullRemote = metadata.repo == null || remote !== "origin" ? remote : `https://github.com/${metadata.repo}.git`;
    await fetchRemoteRefs(pi, gitRoot, [
      `+${sourceBranchRef(baseBranch)}:${originRef(baseBranch)}`,
      `+refs/pull/${metadata.number}/head:${originRef(prHeadBranch)}`,
    ], pullRemote, onProgress);
    const baseRef = originShortRef(baseBranch);
    const headRef = originShortRef(prHeadBranch);
    return { baseRef: await getMergeBase(pi, gitRoot, baseRef, headRef), headRef };
  }
}

async function fetchPlainRemoteBranch(pi: ExtensionAPI, gitRoot: string, branch: string, onProgress?: RemoteProgress): Promise<{ baseRef: string; headRef: string }> {
  const defaultBranchRef = await getDefaultBranchRef(pi, gitRoot);
  const baseBranch = stripOriginPrefix(defaultBranchRef ?? "origin/main");
  await fetchRemoteRefs(pi, gitRoot, [
    `+${sourceBranchRef(baseBranch)}:${originRef(baseBranch)}`,
    `+${sourceBranchRef(branch)}:${originRef(branch)}`,
  ], "origin", onProgress);
  return { baseRef: originShortRef(baseBranch), headRef: originShortRef(branch) };
}

export async function resolveRemoteReviewTarget(pi: ExtensionAPI, fallbackCwd: string, remote: string, explicitCwd?: string, onProgress?: RemoteProgress): Promise<RemoteReviewTarget> {
  const parsed = extractBranchFromRemote(remote);
  if (parsed == null) throw new Error(`Could not extract branch name from: ${remote}`);

  onProgress?.(`Preparing remote review for ${remote}…`);
  const { gitRoot, fetchRemote, workspacePath, pathspecs, importAliases } = await resolveRepoRoot(pi, fallbackCwd, parsed.repo, explicitCwd, onProgress);

  if (parsed.prNumber != null) {
    const pullRequest = await getPullRequestMetadata(pi, gitRoot, parsed.prNumber, parsed.repo, onProgress);
    const refs = await fetchPullRequestRefs(pi, gitRoot, pullRequest, fetchRemote, onProgress);
    if (shouldScanStackParentCandidates()) {
      const closestStackParent = await findClosestStackParent(pi, gitRoot, pullRequest, refs.baseRef, refs.headRef, fetchRemote, parsed.repo, onProgress);
      if (closestStackParent != null) {
        refs.baseRef = closestStackParent.baseRef;
        pullRequest.stackParent = closestStackParent.stackParent;
      }
    }
    return {
      gitRoot,
      baseRef: refs.baseRef,
      headRef: refs.headRef,
      remote,
      branch: pullRequest.headRefName,
      repo: parsed.repo,
      pullRequest,
      workspacePath,
      pathspecs,
      importAliases,
    };
  }

  const refs = await fetchPlainRemoteBranch(pi, gitRoot, parsed.branch, onProgress);
  return {
    gitRoot,
    baseRef: refs.baseRef,
    headRef: refs.headRef,
    remote,
    branch: parsed.branch,
    repo: parsed.repo,
    workspacePath,
    pathspecs,
    importAliases,
  };
}

export function formatPullRequestContext(metadata: PullRequestMetadata): string {
  const reviewerMap = new Map<string, string>();
  for (const review of metadata.reviews) reviewerMap.set(review.author.login, review.state);
  const reviews = [...reviewerMap.entries()]
    .map(([login, state]) => `${login} (${state.toLowerCase().replace(/_/g, " ")})`)
    .join(", ") || "none yet";
  const repoLabel = metadata.repo == null ? "" : ` (${metadata.repo})`;
  const baseContext = metadata.stackParent != null
    ? `Stack parent: PR #${metadata.stackParent.number} ${metadata.stackParent.title} (${metadata.stackParent.headRefName}, ${metadata.stackParent.state.toLowerCase()})`
    : isDefaultBaseBranch(metadata.baseRefName) ? undefined : `Base branch: ${metadata.baseRefName}`;
  return [
    `PR #${metadata.number}${repoLabel}: ${metadata.title}`,
    `Author: ${metadata.authorLogin} | State: ${metadata.state.toLowerCase()}`,
    `${metadata.changedFiles} file(s) changed, +${metadata.additions} -${metadata.deletions}`,
    ...(baseContext == null ? [] : [baseContext]),
    `Reviews: ${reviews}`,
  ].join("\n");
}
