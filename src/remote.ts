import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getDefaultBranchRef } from "./git.js";

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

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

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

  const stack-hostMatch = trimmed.match(/stack-host\.dev\/github\/pr\/([^/\s]+\/[^/\s]+)\/(\d+)/);
  if (stack-hostMatch != null) return { branch: `__pr__${stack-hostMatch[2]}`, repo: stack-hostMatch[1], prNumber: stack-hostMatch[2] };

  const shortMatch = trimmed.match(/^([^/\s]+\/[^#\s]+)#(\d+)$/);
  if (shortMatch != null) return { branch: `__pr__${shortMatch[2]}`, repo: shortMatch[1], prNumber: shortMatch[2] };

  if (/^[\w./-]+$/.test(trimmed)) return { branch: trimmed };
  return null;
}

function getWorldRoot(fallbackCwd: string): string {
  const rootSrc = join(homedir(), "world", "trees", "root", "src");
  return existsSync(rootSrc) ? rootSrc : fallbackCwd;
}

async function resolveRepoRoot(pi: ExtensionAPI, fallbackCwd: string, repo: string | undefined, explicitCwd: string | undefined): Promise<{ gitRoot: string; crossRepo: boolean }> {
  if (explicitCwd != null) return { gitRoot: explicitCwd, crossRepo: false };
  if (repo == null || repo.toLowerCase() === "example/widgets") return { gitRoot: getWorldRoot(fallbackCwd), crossRepo: false };

  const repoShortName = repo.split("/").pop() ?? repo;
  if (!/^[\w.-]+$/.test(repoShortName)) return { gitRoot: getWorldRoot(fallbackCwd), crossRepo: true };

  const devCdResult = await pi.exec("bash", ["-lc", `dev cd ${shellQuote(repoShortName)} && pwd`], { cwd: fallbackCwd, timeout: 10000 });
  const devCdPath = devCdResult.code === 0 ? devCdResult.stdout.trim().split("\n").pop()?.trim() : undefined;
  if (devCdPath != null && devCdPath.length > 0 && existsSync(devCdPath)) return { gitRoot: devCdPath, crossRepo: false };

  return { gitRoot: getWorldRoot(fallbackCwd), crossRepo: true };
}

function ghArgs(args: string[], repo: string | undefined): string[] {
  return repo == null ? args : [...args, "--repo", repo];
}

export async function getPullRequestMetadata(pi: ExtensionAPI, gitRoot: string, prNumber: string, repo?: string): Promise<PullRequestMetadata> {
  const result = await pi.exec("provider-cli", ghArgs(["pr", "view", prNumber, "--json", "title,body,additions,deletions,changedFiles,author,reviews,state,headRefName,headRefOid,baseRefName"], repo), { cwd: gitRoot, timeout: 15000 });
  if (result.code !== 0 || result.stdout.trim().length === 0) {
    throw new Error(`Could not resolve PR #${prNumber}: ${result.stderr || "empty provider-cli response"}`);
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

async function fetchRemoteRefs(pi: ExtensionAPI, gitRoot: string, refspecs: string[]): Promise<void> {
  const result = await pi.exec("git", ["--no-pager", "fetch", "--no-tags", "origin", ...refspecs], { cwd: gitRoot, timeout: 15000 });
  if (result.killed) throw new Error(`Timed out fetching remote refs after 15s. stderr: ${result.stderr || "(none)"}`);
  if (result.code !== 0) throw new Error(result.stderr || result.stdout || "Failed to fetch remote refs.");
}

async function fetchPullRequestRefs(pi: ExtensionAPI, gitRoot: string, metadata: PullRequestMetadata): Promise<{ baseRef: string; headRef: string }> {
  const baseBranch = metadata.baseRefName || "main";
  try {
    await fetchRemoteRefs(pi, gitRoot, [
      `+${baseBranch}:${originRef(baseBranch)}`,
      `+${metadata.headRefName}:${originRef(metadata.headRefName)}`,
    ]);
    return { baseRef: originShortRef(baseBranch), headRef: originShortRef(metadata.headRefName) };
  } catch {
    const prHeadBranch = `pr/${metadata.number}/head`;
    await fetchRemoteRefs(pi, gitRoot, [
      `+${baseBranch}:${originRef(baseBranch)}`,
      `+refs/pull/${metadata.number}/head:${originRef(prHeadBranch)}`,
    ]);
    return { baseRef: originShortRef(baseBranch), headRef: originShortRef(prHeadBranch) };
  }
}

async function fetchPlainRemoteBranch(pi: ExtensionAPI, gitRoot: string, branch: string): Promise<{ baseRef: string; headRef: string }> {
  const defaultBranchRef = await getDefaultBranchRef(pi, gitRoot);
  const baseBranch = stripOriginPrefix(defaultBranchRef ?? "origin/main");
  await fetchRemoteRefs(pi, gitRoot, [
    `+${baseBranch}:${originRef(baseBranch)}`,
    `+${branch}:${originRef(branch)}`,
  ]);
  return { baseRef: originShortRef(baseBranch), headRef: originShortRef(branch) };
}

export async function resolveRemoteReviewTarget(pi: ExtensionAPI, fallbackCwd: string, remote: string, explicitCwd?: string): Promise<RemoteReviewTarget> {
  const parsed = extractBranchFromRemote(remote);
  if (parsed == null) throw new Error(`Could not extract branch name from: ${remote}`);

  const { gitRoot, crossRepo } = await resolveRepoRoot(pi, fallbackCwd, parsed.repo, explicitCwd);
  if (crossRepo) throw new Error(`Repository ${parsed.repo} is not checked out locally; cross-repo PR diffs are not supported in pi-code-diff yet.`);

  if (parsed.prNumber != null) {
    const pullRequest = await getPullRequestMetadata(pi, gitRoot, parsed.prNumber, parsed.repo);
    const refs = await fetchPullRequestRefs(pi, gitRoot, pullRequest);
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

  const refs = await fetchPlainRemoteBranch(pi, gitRoot, parsed.branch);
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
