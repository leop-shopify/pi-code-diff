import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DiffReviewComment, ReviewFile } from "./types.js";

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

const EVENT_BY_VERDICT: Record<ReviewVerdict, string> = {
  approve: "APPROVE",
  request_changes: "REQUEST_CHANGES",
  comment: "COMMENT",
};

export function buildInlineComments(files: ReviewFile[], comments: DiffReviewComment[]): ReviewInlineComment[] {
  const fileMap = new Map(files.map((file) => [file.id, file]));
  const inline: ReviewInlineComment[] = [];
  for (const comment of comments) {
    if (comment.intent !== "comment") continue;
    if (comment.side === "file" || comment.startLine == null) continue;
    const file = fileMap.get(comment.fileId);
    const path = file?.path ?? comment.fileId;
    const side = comment.side === "deleted" ? "LEFT" : "RIGHT";
    const line = comment.endLine ?? comment.startLine;
    const entry: ReviewInlineComment = { path, line, side, body: comment.body };
    if (comment.startLine !== line) {
      entry.start_line = comment.startLine;
      entry.start_side = side;
    }
    inline.push(entry);
  }
  return inline;
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

  const payload = buildReviewPayload(input);
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
    return { ok: true, message: `Submitted ${EVENT_BY_VERDICT[input.verdict]} review on PR #${input.prNumber}.` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
