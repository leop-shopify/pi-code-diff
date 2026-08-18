export type GitBranch =
  | { kind: "branch"; name: string }
  | { kind: "detached"; head: string };

export interface GitStatusEntry {
  index: string;
  worktree: string;
  path: string;
  originalPath?: string;
}

export interface GitCommit {
  shortHash: string;
  subject: string;
}

export interface GitContext {
  branch: GitBranch;
  status: GitStatusEntry[];
  commits: GitCommit[];
  diff: string;
  statusCapped: boolean;
  commitsCapped: boolean;
  diffCapped: boolean;
}

export function parseGitBranch(symbolicRef: string, shortHead: string): GitBranch {
  const name = symbolicRef.trim();
  if (name.length > 0) return { kind: "branch", name };
  return { kind: "detached", head: shortHead.trim() || "unknown" };
}

/** Parses `git status --porcelain=v1 -z`, including rename/copy origin records. */
export function parsePorcelainStatus(output: string, cap = 200): GitStatusEntry[] {
  const fields = output.split("\0");
  const entries: GitStatusEntry[] = [];
  for (let index = 0; index < fields.length && entries.length < cap; index += 1) {
    const record = fields[index]!;
    if (record.length < 4) continue;
    const indexStatus = record[0]!;
    const worktree = record[1]!;
    const path = record.slice(3);
    if (path.length === 0) continue;
    const renamedOrCopied = indexStatus === "R" || indexStatus === "C" || worktree === "R" || worktree === "C";
    const originalPath = renamedOrCopied ? fields[++index] : undefined;
    entries.push({ index: indexStatus, worktree, path, ...(originalPath == null || originalPath.length === 0 ? {} : { originalPath }) });
  }
  return entries;
}

/** Parses NUL-separated `%h%x00%s%x00` records to keep subjects/path-like text unambiguous. */
export function parseGitLog(output: string, cap = 20): GitCommit[] {
  const fields = output.split("\0");
  const commits: GitCommit[] = [];
  for (let index = 0; index + 1 < fields.length && commits.length < cap; index += 2) {
    const shortHash = fields[index]!;
    const subject = fields[index + 1]!;
    if (shortHash.length > 0) commits.push({ shortHash, subject });
  }
  return commits;
}
