import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DiffReviewComment, ReviewFile, ReviewSubmitPayload } from "./types.js";
import { joinReviewPath } from "./types.js";

export type ReviewVerdict = "approve" | "request_changes" | "comment";

export interface ReviewInlineComment {
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  body: string;
  start_line?: number;
  start_side?: "LEFT" | "RIGHT";
}

export interface SubmitReviewInput {
  repo: string;
  prNumber: string;
  commitId: string;
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

export function buildReviewBody(files: ReviewFile[], payload: ReviewSubmitPayload): string | undefined {
  const sections: string[] = [];
  const allComment = cleanReviewText(payload.allComment);
  if (payload.allIntent === "comment" && allComment.length > 0) sections.push(allComment);

  for (const comment of payload.comments) {
    if (comment.intent !== "comment" || comment.side !== "file") continue;
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

export function buildReviewPayload(input: SubmitReviewInput): Record<string, unknown> {
  const payload: Record<string, unknown> = { event: EVENT_BY_VERDICT[input.verdict] };
  const body = input.body?.trim();
  if (body != null && body.length > 0) payload.body = body;
  if (input.comments != null && input.comments.length > 0) {
    payload.commit_id = input.commitId;
    payload.comments = input.comments;
  }
  return payload;
}

function formatReviewSummary(input: SubmitReviewInput, commentCount: number, bodyIncluded: boolean): string {
  const url = `https://github.com/${input.repo}/pull/${input.prNumber}`;
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

async function postReview(pi: ExtensionAPI, input: SubmitReviewInput, submission: ReviewSubmission): Promise<SubmitReviewResult> {
  const payload = buildReviewPayload({ ...input, verdict: submission.verdict, body: submission.body, comments: submission.comments });
  const dir = mkdtempSync(join(tmpdir(), "pi-code-diff-review-"));
  const payloadPath = join(dir, "review.json");
  try {
    writeFileSync(payloadPath, JSON.stringify(payload), "utf8");
    const result = await pi.exec(
      "gh",
      ["api", `repos/${input.repo}/pulls/${input.prNumber}/reviews`, "--method", "POST", "--input", payloadPath],
      { cwd: input.gitRoot, timeout: 20000 },
    );
    if (result.code !== 0) {
      return { ok: false, message: result.stderr.trim() || result.stdout.trim() || "gh api review submission failed." };
    }
    return { ok: true, message: "submitted" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function submitPullRequestReview(pi: ExtensionAPI, input: SubmitReviewInput): Promise<SubmitReviewResult> {
  if (input.verdict === "approve") {
    const me = await getCurrentGitHubLogin(pi, input.gitRoot);
    if (me != null && input.prAuthorLogin != null && me.toLowerCase() === input.prAuthorLogin.toLowerCase()) {
      return {
        ok: false,
        blockedSelfApproval: true,
        message: `Refusing to approve your own pull request. You are signed in as ${me}, who authored PR #${input.prNumber}. GitHub does not allow self-approval. Use Comment or Request changes instead.`,
      };
    }
  }

  const hasBody = input.body != null && input.body.trim().length > 0;
  const hasComments = input.comments != null && input.comments.length > 0;
  if (input.verdict === "request_changes" && !hasBody && !hasComments) {
    return { ok: false, message: "Request changes needs a review body or at least one inline comment." };
  }

  const body = input.body?.trim();
  const comments = input.comments ?? [];

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
