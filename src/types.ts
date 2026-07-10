export type ReviewScope = "git-diff" | "last-commit" | "all-files";

export type ChangeStatus = "modified" | "added" | "deleted" | "renamed";

export interface ReviewFileComparison {
  status: ChangeStatus;
  oldPath: string | null;
  newPath: string | null;
  displayPath: string;
  hasOriginal: boolean;
  hasModified: boolean;
  additions?: number;
  deletions?: number;
  originalRevision?: string | null;
  modifiedRevision?: string | null;
}

export interface ReviewSubmoduleInfo {
  repoRoot: string;
  path: string;
  oldSha: string | null;
  newSha: string | null;
  available: boolean;
  unavailableReason?: string;
}

export type ReviewSubmoduleByScope = Partial<Record<ReviewScope, ReviewSubmoduleInfo>>;

export interface ReviewFile {
  id: string;
  path: string;
  pathPrefix?: string;
  worktreeStatus: ChangeStatus | null;
  hasWorkingTreeFile: boolean;
  inGitDiff: boolean;
  inLastCommit: boolean;
  inAllFiles: boolean;
  gitDiff: ReviewFileComparison | null;
  lastCommit: ReviewFileComparison | null;
  allFiles: ReviewFileComparison | null;
  allFilesReferenceCount?: number;
  allFilesOutgoingReferences?: string[];
  allFilesIncomingReferences?: string[];
  submodule?: ReviewSubmoduleByScope;
}

export interface ReviewFileContents {
  originalContent: string;
  modifiedContent: string;
}

export interface ReviewContextPanelSource {
  title: string;
  loadingText: string;
  load: () => Promise<string>;
}

export type CommentSide = "added" | "deleted" | "file";

export type CommentIntent = "discuss" | "comment" | "modify";
export type FileCommentTarget = "file" | "all-lines";

export interface DiffReviewComment {
  id: string;
  fileId: string;
  scope: ReviewScope;
  side: CommentSide;
  intent: CommentIntent;
  startLine: number | null;
  endLine: number | null;
  body: string;
  fileTarget?: FileCommentTarget;
  /** Original source text of the edited line(s), captured when a CHANGE edit is started. */
  originalText?: string;
}

export interface ReviewDraft {
  allComment: string;
  allIntent: CommentIntent;
  comments: DiffReviewComment[];
}

export type ReviewFocus = "navigator" | "diff" | "comments";

export interface ReviewLineTarget {
  side: Exclude<CommentSide, "file">;
  /** Active cursor line for the selection. */
  line: number;
  /** Anchor line when the selection spans multiple diff lines. */
  endLine?: number;
}

export interface ReviewState {
  activeScope: ReviewScope;
  activeFileId: string | null;
  searchQuery: string;
  focus: ReviewFocus;
  wrapLines: boolean;
  hideUnchanged: boolean;
  selectedCommentIndex: number;
  selectedLineTargetByScopeFile: Record<string, ReviewLineTarget>;
  draft: ReviewDraft;
}

export interface ReviewSubmitPayload extends ReviewDraft {
  type: "submit";
}

export interface ReviewCancelPayload {
  type: "cancel";
}

export type ReviewResult = ReviewSubmitPayload | ReviewCancelPayload;

export function formatScopeLabel(scope: ReviewScope): string {
  switch (scope) {
    case "git-diff": return "git diff";
    case "last-commit": return "last commit";
    case "all-files": return "all files";
  }
}

export function scopeFileKey(scope: ReviewScope, fileId: string): string {
  return `${scope}::${fileId}`;
}

export function formatIntentLabel(intent: CommentIntent): string {
  switch (intent) {
    case "discuss": return "DISCUSS";
    case "comment": return "COMMENT";
    case "modify": return "MODIFY";
  }
}

export function getSubmoduleInfo(file: ReviewFile | null | undefined, scope: ReviewScope): ReviewSubmoduleInfo | null {
  return file?.submodule?.[scope] ?? null;
}

export function hasExactSubmoduleRange(submodule: ReviewSubmoduleInfo): submodule is ReviewSubmoduleInfo & { oldSha: string; newSha: string } {
  return submodule.oldSha != null && submodule.newSha != null && submodule.oldSha !== submodule.newSha;
}

export function joinReviewPath(prefix: string | undefined, path: string): string {
  return prefix == null || prefix.length === 0 ? path : `${prefix}/${path}`;
}

export function getReviewFileDisplayPath(file: ReviewFile | null | undefined, scope: ReviewScope): string {
  if (file == null) return "(no file)";
  const comparison = scope === "git-diff" ? file.gitDiff : scope === "last-commit" ? file.lastCommit : file.allFiles;
  if (comparison == null) return joinReviewPath(file.pathPrefix, file.path);
  if (comparison.status === "renamed" && comparison.oldPath != null && comparison.newPath != null) {
    return `${joinReviewPath(file.pathPrefix, comparison.oldPath)} -> ${joinReviewPath(file.pathPrefix, comparison.newPath)}`;
  }
  return joinReviewPath(file.pathPrefix, comparison.displayPath);
}
