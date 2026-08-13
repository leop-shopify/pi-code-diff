import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PullRequestProvider } from "./remote.js";
import type { DiffReviewComment, ReviewFile, ReviewSubmitPayload } from "./types.js";
import { joinReviewPath } from "./types.js";

export type ReviewVerdict = "approve" | "request_changes" | "comment";

export interface ReviewInlineComment {
  path: string;
  body: string;
  line?: number;
  side?: "LEFT" | "RIGHT";
  start_line?: number;
  start_side?: "LEFT" | "RIGHT";
  subject_type?: "file";
}

export interface SubmitReviewInput {
  provider?: PullRequestProvider;
  repo: string;
  prNumber: string;
  commitId: string;
  baseCommitId?: string;
  verdict: ReviewVerdict;
  body?: string;
  comments?: ReviewInlineComment[];
  prAuthorLogin?: string;
  gitRoot?: string;
}

export interface SubmitReviewResult {
  ok: boolean;
  message: string;
  blockedSelfApproval?: boolean;
}

interface ReviewSubmission {
  verdict: ReviewVerdict;
  body?: string;
  comments?: ReviewInlineComment[];
}

const EVENT_BY_VERDICT: Record<ReviewVerdict, string> = {
  approve: "APPROVE",
  request_changes: "REQUEST_CHANGES",
  comment: "COMMENT",
};

function getCommentFilePath(files: ReviewFile[], fileId: string): string {
  const file = files.find((candidate) => candidate.id === fileId);
  return file == null ? fileId : joinReviewPath(file.pathPrefix, file.path);
}

function cleanReviewText(text: string): string {
  return text.trim().replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
}

function formatModifyInlineBody(comment: DiffReviewComment): string {
  const oldText = comment.originalText;
  if (oldText == null || oldText.length === 0) return comment.body;

  const lines = ["Suggested change:", "", "```diff"];
  for (const line of oldText.split(/\r\n|\n|\r/)) lines.push(`- ${line}`);
  if (comment.body.length > 0) {
    for (const line of comment.body.split(/\r\n|\n|\r/)) lines.push(`+ ${line}`);
  }
  lines.push("```");
  return lines.join("\n");
}

function getInlineCommentBody(comment: DiffReviewComment): string {
  return comment.intent === "modify" ? formatModifyInlineBody(comment) : cleanReviewText(comment.body);
}

export function buildInlineComments(files: ReviewFile[], comments: DiffReviewComment[]): ReviewInlineComment[] {
  const inline: ReviewInlineComment[] = [];
  for (const comment of comments) {
    if (comment.intent !== "comment" && comment.intent !== "modify") continue;
    if (comment.side === "file" || comment.startLine == null) continue;
    const file = files.find((candidate) => candidate.id === comment.fileId);
    if (file?.pathPrefix != null) continue;
    const path = getCommentFilePath(files, comment.fileId);
    const side = comment.side === "deleted" ? "LEFT" : "RIGHT";
    const line = comment.endLine ?? comment.startLine;
    const entry: ReviewInlineComment = { path, line, side, body: getInlineCommentBody(comment) };
    if (comment.startLine !== line) {
      entry.start_line = comment.startLine;
      entry.start_side = side;
    }
    inline.push(entry);
  }
  return inline;
}

export function buildGitstreamComments(files: ReviewFile[], comments: DiffReviewComment[]): ReviewInlineComment[] {
  const reviewComments: ReviewInlineComment[] = [];
  for (const comment of comments) {
    if (comment.intent !== "comment" && comment.intent !== "modify") continue;
    const file = files.find((candidate) => candidate.id === comment.fileId);
    if (file == null || file.pathPrefix != null) throw new Error(`GitStream cannot safely map review comment ${comment.id} to a repository path.`);
    const path = getCommentFilePath(files, comment.fileId);
    const body = getInlineCommentBody(comment);
    if (body.trim().length === 0) throw new Error(`GitStream review comment ${comment.id} has an empty body.`);
    if (comment.side === "file") {
      if (comment.intent === "modify") throw new Error(`GitStream cannot safely map file-level MODIFY comment ${comment.id}.`);
      reviewComments.push({ path, subject_type: "file", body });
      continue;
    }
    if (comment.startLine == null) throw new Error(`GitStream cannot safely map review comment ${comment.id} without a line.`);
    const side = comment.side === "deleted" ? "LEFT" : "RIGHT";
    const line = comment.endLine ?? comment.startLine;
    const entry: ReviewInlineComment = { path, line, side, body };
    if (comment.startLine !== line) {
      entry.start_line = comment.startLine;
      entry.start_side = side;
    }
    reviewComments.push(entry);
  }
  return reviewComments;
}

export function buildReviewBody(files: ReviewFile[], payload: ReviewSubmitPayload, includeFileComments = true): string | undefined {
  const sections: string[] = [];
  const allComment = cleanReviewText(payload.allComment);
  if (payload.allIntent === "comment" && allComment.length > 0) sections.push(allComment);

  for (const comment of payload.comments) {
    if (!includeFileComments || comment.intent !== "comment" || comment.side !== "file") continue;
    const body = cleanReviewText(comment.body);
    if (body.length === 0) continue;
    sections.push(`${getCommentFilePath(files, comment.fileId)}:\n${body}`);
  }

  return sections.length > 0 ? sections.join("\n\n") : undefined;
}

export async function getCurrentGitHubLogin(pi: ExtensionAPI, gitRoot?: string): Promise<string | null> {
  const result = await pi.exec("gh", ["api", "user", "--jq", ".login"], { cwd: gitRoot, timeout: 15000 });
  if (result.code !== 0) return null;
  const login = result.stdout.trim();
  return login.length > 0 ? login : null;
}

async function getCurrentGitstreamLogin(pi: ExtensionAPI, gitRoot?: string): Promise<string> {
  const result = await pi.exec("gs", ["api", "/user"], { cwd: gitRoot, timeout: 15000 });
  if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || "GitStream identity lookup failed.");
  try {
    const parsed = JSON.parse(result.stdout.trim()) as { login?: unknown };
    if (typeof parsed.login !== "string" || parsed.login.length === 0) throw new Error();
    return parsed.login;
  } catch {
    throw new Error("Malformed GitStream response for current user.");
  }
}

export function buildReviewPayload(input: SubmitReviewInput): Record<string, unknown> {
  const payload: Record<string, unknown> = { event: EVENT_BY_VERDICT[input.verdict] };
  const body = input.body?.trim();
  if (body != null && body.length > 0) payload.body = body;
  if (input.provider === "gitstream" || (input.comments != null && input.comments.length > 0)) payload.commit_id = input.commitId;
  if (input.comments != null && input.comments.length > 0) payload.comments = input.comments;
  return payload;
}

function formatReviewSummary(input: SubmitReviewInput, commentCount: number, bodyIncluded: boolean): string {
  const url = input.provider === "gitstream"
    ? `https://meteorite.shopify.io/repos/${input.repo}/pulls/${input.prNumber}`
    : `https://github.com/${input.repo}/pull/${input.prNumber}`;
  const time = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
  const action = input.verdict === "approve" ? "PR was approved" : input.verdict === "request_changes" ? "Changes were requested" : "Review comment was posted";
  const comments = commentCount === 0 ? "No inline comments were added." : `${commentCount} inline comment${commentCount === 1 ? " was" : "s were"} added.`;
  const body = bodyIncluded
    ? input.verdict === "approve"
      ? "Your review body comment was included in the approval."
      : input.verdict === "request_changes"
        ? "Your review body comment was included in the change request."
        : "Your review body comment was included."
    : undefined;
  return [url, `${action} at ${time}.`, comments, body].filter((line): line is string => line != null).join("\n");
}

async function validateGitstreamTarget(pi: ExtensionAPI, input: SubmitReviewInput): Promise<void> {
  if (input.baseCommitId == null || input.baseCommitId.length === 0) throw new Error("GitStream review submission requires the immutable base commit SHA.");
  const endpoint = `repos/${input.repo}/pulls/${input.prNumber}`;
  const result = await pi.exec("gs", ["api", endpoint], { cwd: input.gitRoot, timeout: 15000 });
  if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || "GitStream target validation failed.");
  try {
    const parsed = JSON.parse(result.stdout.trim()) as { state?: unknown; head?: { sha?: unknown }; base?: { sha?: unknown } };
    if (typeof parsed.state !== "string" || typeof parsed.head?.sha !== "string" || typeof parsed.base?.sha !== "string") throw new Error();
    if (parsed.state.toLowerCase() !== "open") throw new Error(`GitStream PR #${input.prNumber} is no longer open.`);
    if (parsed.head.sha !== input.commitId) throw new Error(`GitStream PR #${input.prNumber} head changed from ${input.commitId} to ${parsed.head.sha}. Reopen the review before submitting.`);
    if (parsed.base.sha !== input.baseCommitId) throw new Error(`GitStream PR #${input.prNumber} base changed from ${input.baseCommitId} to ${parsed.base.sha}. Reopen the review before submitting.`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("GitStream PR #")) throw error;
    throw new Error(`Malformed GitStream response for PR #${input.prNumber} target validation.`);
  }
}

async function postReview(pi: ExtensionAPI, input: SubmitReviewInput, submission: ReviewSubmission): Promise<SubmitReviewResult> {
  const payload = buildReviewPayload({ ...input, verdict: submission.verdict, body: submission.body, comments: submission.comments });
  const dir = mkdtempSync(join(tmpdir(), "pi-code-diff-review-"));
  const payloadPath = join(dir, "review.json");
  try {
    writeFileSync(payloadPath, JSON.stringify(payload), "utf8");
    const gitstream = input.provider === "gitstream";
    const result = await pi.exec(
      gitstream ? "gs" : "gh",
      gitstream
        ? ["api", `repos/${input.repo}/pulls/${input.prNumber}/reviews`, "-X", "POST", "--input", payloadPath]
        : ["api", `repos/${input.repo}/pulls/${input.prNumber}/reviews`, "--method", "POST", "--input", payloadPath],
      { cwd: input.gitRoot, timeout: 20000 },
    );
    if (result.code !== 0) {
      return { ok: false, message: result.stderr.trim() || result.stdout.trim() || `${gitstream ? "gs" : "gh"} api review submission failed.` };
    }
    if (gitstream) {
      try {
        const parsed = JSON.parse(result.stdout.trim()) as { id?: unknown; state?: unknown };
        if ((typeof parsed.id !== "number" && typeof parsed.id !== "string") || typeof parsed.state !== "string") throw new Error();
      } catch {
        return { ok: false, message: "Malformed GitStream response after review submission; inspect the PR before retrying." };
      }
    }
    return { ok: true, message: "submitted" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function validateReviewComments(input: SubmitReviewInput): string | undefined {
  for (const [index, comment] of (input.comments ?? []).entries()) {
    const segments = comment.path.split("/");
    if (comment.path.length === 0 || comment.path.startsWith("/") || comment.path.includes("\\") || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
      return `Review comment ${index + 1} has an unsafe repository path.`;
    }
    if (comment.body.trim().length === 0) return `Review comment ${index + 1} has an empty body.`;
    if (comment.subject_type === "file") {
      if (input.provider !== "gitstream") return `File-level review comment ${index + 1} is only supported for GitStream submissions.`;
      if (comment.line != null || comment.side != null || comment.start_line != null || comment.start_side != null) return `File-level review comment ${index + 1} contains unsupported line fields.`;
      continue;
    }
    if (!Number.isInteger(comment.line) || comment.line == null || comment.line < 1 || (comment.side !== "LEFT" && comment.side !== "RIGHT")) {
      return `Review comment ${index + 1} has an unsupported inline location.`;
    }
    if (comment.start_line != null && (!Number.isInteger(comment.start_line) || comment.start_line < 1 || comment.start_line > comment.line || comment.start_side !== comment.side)) {
      return `Review comment ${index + 1} has an unsupported inline range.`;
    }
  }
  return undefined;
}

export async function submitPullRequestReview(pi: ExtensionAPI, input: SubmitReviewInput): Promise<SubmitReviewResult> {
  const invalidComment = validateReviewComments(input);
  if (invalidComment != null) return { ok: false, message: invalidComment };
  const gitstream = input.provider === "gitstream";
  if (input.verdict === "approve") {
    let me: string | null;
    try {
      me = gitstream ? await getCurrentGitstreamLogin(pi, input.gitRoot) : await getCurrentGitHubLogin(pi, input.gitRoot);
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    if (me != null && input.prAuthorLogin != null && me.toLowerCase() === input.prAuthorLogin.toLowerCase()) {
      return {
        ok: false,
        blockedSelfApproval: true,
        message: `Refusing to approve your own pull request. You are signed in as ${me}, who authored PR #${input.prNumber}. ${gitstream ? "GitStream" : "GitHub"} does not allow self-approval. Use Comment or Request changes instead.`,
      };
    }
  }

  const hasBody = input.body != null && input.body.trim().length > 0;
  const hasComments = input.comments != null && input.comments.length > 0;
  if (input.verdict === "request_changes" && (!hasBody && (!hasComments || gitstream))) {
    return { ok: false, message: gitstream ? "GitStream request changes needs a review body." : "Request changes needs a review body or at least one inline comment." };
  }

  const body = input.body?.trim();
  const comments = input.comments ?? [];

  if (gitstream) {
    try {
      await validateGitstreamTarget(pi, input);
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    const result = await postReview(pi, input, { verdict: input.verdict, body, comments });
    if (!result.ok) return result;
    return { ok: true, message: formatReviewSummary(input, comments.length, body != null && body.length > 0) };
  }

  if (input.verdict === "approve" && comments.length > 0) {
    const commentResult = await postReview(pi, input, { verdict: "comment", comments });
    if (!commentResult.ok) return { ok: false, message: `Could not add review comments before approval: ${commentResult.message}` };

    const approvalResult = await postReview(pi, input, { verdict: "approve", body });
    if (!approvalResult.ok) return { ok: false, message: `Review comments were added, but approval failed: ${approvalResult.message}` };
    return { ok: true, message: formatReviewSummary(input, comments.length, body != null && body.length > 0) };
  }

  const result = await postReview(pi, input, { verdict: input.verdict, body, comments });
  if (!result.ok) return result;
  return { ok: true, message: formatReviewSummary(input, comments.length, body != null && body.length > 0) };
}
