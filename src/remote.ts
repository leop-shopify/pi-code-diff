import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getDefaultBranchRef } from "./git.js";
import { getShortcutConfigPath } from "./shortcuts.js";

export interface RemoteParseResult {
  branch: string;
  repo?: string;
  prNumber?: string;
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
}

export interface RemoteReviewTarget {
  gitRoot: string;
  baseRef: string;
  headRef: string;
  remote: string;
  branch: string;
  repo?: string;
  pullRequest?: PullRequestMetadata;
}

export type RemoteProgress = (message: string) => void;

function originRef(branch: string): string {
  return `refs/remotes/origin/${branch}`;
}

function originShortRef(branch: string): string {
  return `origin/${branch}`;
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

function getConfiguredRepoRoot(repo: string): string | undefined {
  const configPath = getCodeDiffConfigPath();
  if (!existsSync(configPath)) return undefined;

  try {
    const config = JSON.parse(readFileSync(configPath, "utf8")) as CodeDiffConfigFile;
    const repositories = config.repositories ?? {};
    const entry = repositories[repo] ?? repositories[normalizeRepoName(repo)];
    const candidate = typeof entry === "string" ? entry : typeof entry?.cwd === "string" ? entry.cwd : typeof entry?.path === "string" ? entry.path : undefined;
    return candidate != null && existsSync(candidate) ? candidate : undefined;
  } catch {
    return undefined;
  }
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

async function resolveRepoRoot(pi: ExtensionAPI, fallbackCwd: string, repo: string | undefined, explicitCwd: string | undefined, onProgress?: RemoteProgress): Promise<{ gitRoot: string; fetchRemote?: string }> {
  if (explicitCwd != null) {
    onProgress?.(`Using local checkout ${explicitCwd}…`);
    return { gitRoot: explicitCwd };
  }
  if (repo == null) {
    onProgress?.("Using current repository for remote branch review…");
    return { gitRoot: fallbackCwd };
  }

  const configuredRoot = getConfiguredRepoRoot(repo);
  if (configuredRoot != null) {
    onProgress?.(`Using configured checkout for ${repo}…`);
    return { gitRoot: configuredRoot };
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
    baseRefName: parsed.baseRefName ?? "main",
  };
}

async function fetchRemoteRefs(pi: ExtensionAPI, gitRoot: string, refspecs: string[], remote = "origin", onProgress?: RemoteProgress): Promise<void> {
  onProgress?.(`Fetching remote refs from ${remote === "origin" ? "origin" : "GitHub"}…`);
  const result = await pi.exec("git", ["--no-pager", "fetch", "--no-tags", remote, ...refspecs], { cwd: gitRoot, timeout: 15000 });
  if (result.killed) throw new Error(`Timed out fetching remote refs after 15s. stderr: ${result.stderr || "(none)"}`);
  if (result.code !== 0) throw new Error(result.stderr || result.stdout || "Failed to fetch remote refs.");
}

async function fetchPullRequestRefs(pi: ExtensionAPI, gitRoot: string, metadata: PullRequestMetadata, remote = "origin", onProgress?: RemoteProgress): Promise<{ baseRef: string; headRef: string }> {
  const baseBranch = metadata.baseRefName || "main";
  try {
    await fetchRemoteRefs(pi, gitRoot, [
      `+${baseBranch}:${originRef(baseBranch)}`,
      `+${metadata.headRefName}:${originRef(metadata.headRefName)}`,
    ], remote, onProgress);
    return { baseRef: originShortRef(baseBranch), headRef: originShortRef(metadata.headRefName) };
  } catch {
    const prHeadBranch = `pr/${metadata.number}/head`;
    await fetchRemoteRefs(pi, gitRoot, [
      `+${baseBranch}:${originRef(baseBranch)}`,
      `+refs/pull/${metadata.number}/head:${originRef(prHeadBranch)}`,
    ], remote, onProgress);
    return { baseRef: originShortRef(baseBranch), headRef: originShortRef(prHeadBranch) };
  }
}

async function fetchPlainRemoteBranch(pi: ExtensionAPI, gitRoot: string, branch: string, onProgress?: RemoteProgress): Promise<{ baseRef: string; headRef: string }> {
  const defaultBranchRef = await getDefaultBranchRef(pi, gitRoot);
  const baseBranch = stripOriginPrefix(defaultBranchRef ?? "origin/main");
  await fetchRemoteRefs(pi, gitRoot, [
    `+${baseBranch}:${originRef(baseBranch)}`,
    `+${branch}:${originRef(branch)}`,
  ], "origin", onProgress);
  return { baseRef: originShortRef(baseBranch), headRef: originShortRef(branch) };
}

export async function resolveRemoteReviewTarget(pi: ExtensionAPI, fallbackCwd: string, remote: string, explicitCwd?: string, onProgress?: RemoteProgress): Promise<RemoteReviewTarget> {
  const parsed = extractBranchFromRemote(remote);
  if (parsed == null) throw new Error(`Could not extract branch name from: ${remote}`);

  onProgress?.(`Preparing remote review for ${remote}…`);
  const { gitRoot, fetchRemote } = await resolveRepoRoot(pi, fallbackCwd, parsed.repo, explicitCwd, onProgress);

  if (parsed.prNumber != null) {
    const pullRequest = await getPullRequestMetadata(pi, gitRoot, parsed.prNumber, parsed.repo, onProgress);
    const refs = await fetchPullRequestRefs(pi, gitRoot, pullRequest, fetchRemote, onProgress);
    return {
      gitRoot,
      baseRef: refs.baseRef,
      headRef: refs.headRef,
      remote,
      branch: pullRequest.headRefName,
      repo: parsed.repo,
      pullRequest,
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
  };
}

export function formatPullRequestContext(metadata: PullRequestMetadata): string {
  const reviewerMap = new Map<string, string>();
  for (const review of metadata.reviews) reviewerMap.set(review.author.login, review.state);
  const reviews = [...reviewerMap.entries()]
    .map(([login, state]) => `${login} (${state.toLowerCase().replace(/_/g, " ")})`)
    .join(", ") || "none yet";
  const repoLabel = metadata.repo == null ? "" : ` (${metadata.repo})`;
  return [
    `PR #${metadata.number}${repoLabel}: ${metadata.title}`,
    `Author: ${metadata.authorLogin} | State: ${metadata.state.toLowerCase()}`,
    `${metadata.changedFiles} file(s) changed, +${metadata.additions} -${metadata.deletions}`,
    `Reviews: ${reviews}`,
  ].join("\n");
}
