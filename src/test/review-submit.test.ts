import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildInlineComments, buildReviewPayload, submitPullRequestReview } from "../review-submit.js";
import type { DiffReviewComment, ReviewFile } from "../types.js";

function makeFile(id: string, path: string): ReviewFile {
  return {
    id,
    path,
    worktreeStatus: "modified",
    hasWorkingTreeFile: true,
    inGitDiff: true,
    inLastCommit: false,
    inAllFiles: false,
    gitDiff: null,
    lastCommit: null,
    allFiles: null,
  };
}

function comment(partial: Partial<DiffReviewComment> & Pick<DiffReviewComment, "id" | "fileId" | "side" | "intent">): DiffReviewComment {
  return {
    scope: "git-diff",
    startLine: null,
    endLine: null,
    body: "",
    ...partial,
  } as DiffReviewComment;
}

describe("buildInlineComments", () => {
  it("maps only comment-intent line items, mirroring GitHub sides", () => {
    const files = [makeFile("src/a.ts", "src/a.ts")];
    const comments: DiffReviewComment[] = [
      comment({ id: "1", fileId: "src/a.ts", side: "added", intent: "comment", startLine: 10, endLine: 10, body: "added note" }),
      comment({ id: "2", fileId: "src/a.ts", side: "deleted", intent: "comment", startLine: 5, endLine: 5, body: "deleted note" }),
      comment({ id: "3", fileId: "src/a.ts", side: "added", intent: "discuss", startLine: 7, endLine: 7, body: "discuss skipped" }),
      comment({ id: "4", fileId: "src/a.ts", side: "added", intent: "modify", startLine: 8, endLine: 8, body: "modify skipped" }),
      comment({ id: "5", fileId: "src/a.ts", side: "file", intent: "comment", body: "file skipped" }),
    ];

    const inline = buildInlineComments(files, comments);

    expect(inline).toEqual([
      { path: "src/a.ts", line: 10, side: "RIGHT", body: "added note" },
      { path: "src/a.ts", line: 5, side: "LEFT", body: "deleted note" },
    ]);
  });

  it("encodes a multi-line range with start_line and start_side", () => {
    const files = [makeFile("src/a.ts", "src/a.ts")];
    const inline = buildInlineComments(files, [
      comment({ id: "1", fileId: "src/a.ts", side: "added", intent: "comment", startLine: 10, endLine: 12, body: "range" }),
    ]);

    expect(inline).toEqual([
      { path: "src/a.ts", line: 12, side: "RIGHT", body: "range", start_line: 10, start_side: "RIGHT" },
    ]);
  });
});

describe("buildReviewPayload", () => {
  it("maps verdicts to GitHub events and includes commit_id only with inline comments", () => {
    expect(buildReviewPayload({ repo: "o/r", prNumber: "1", commitId: "sha", verdict: "approve", body: "lgtm" }))
      .toEqual({ event: "APPROVE", body: "lgtm" });

    expect(buildReviewPayload({
      repo: "o/r",
      prNumber: "1",
      commitId: "sha",
      verdict: "comment",
      comments: [{ path: "a.ts", line: 3, side: "RIGHT", body: "x" }],
    })).toEqual({
      event: "COMMENT",
      commit_id: "sha",
      comments: [{ path: "a.ts", line: 3, side: "RIGHT", body: "x" }],
    });
  });
});

describe("submitPullRequestReview", () => {
  it("blocks self-approval without hitting the reviews endpoint", async () => {
    const calls: string[][] = [];
    const pi = {
      exec: async (_cmd: string, args: string[]) => {
        calls.push(args);
        if (args.includes("user")) return { stdout: "leo\n", stderr: "", code: 0, killed: false };
        return { stdout: "", stderr: "", code: 0, killed: false };
      },
    };

    const result = await submitPullRequestReview(pi as never, {
      repo: "o/r",
      prNumber: "42",
      commitId: "sha",
      verdict: "approve",
      prAuthorLogin: "Leo",
      body: "nice",
    });

    expect(result.ok).toBe(false);
    expect(result.blockedSelfApproval).toBe(true);
    expect(calls.some((args) => args.includes("reviews"))).toBe(false);
  });

  it("submits an approval when the reviewer is not the author", async () => {
    let payload: unknown;
    const pi = {
      exec: async (_cmd: string, args: string[]) => {
        if (args.includes("user")) return { stdout: "reviewer\n", stderr: "", code: 0, killed: false };
        const inputIndex = args.indexOf("--input");
        if (inputIndex >= 0) payload = JSON.parse(readFileSync(args[inputIndex + 1]!, "utf8"));
        return { stdout: "{}", stderr: "", code: 0, killed: false };
      },
    };

    const result = await submitPullRequestReview(pi as never, {
      repo: "o/r",
      prNumber: "42",
      commitId: "sha",
      verdict: "approve",
      prAuthorLogin: "leo",
      body: "looks good",
    });

    expect(result.ok).toBe(true);
    expect(payload).toEqual({ event: "APPROVE", body: "looks good" });
  });

  it("rejects request_changes with no body or comments before calling gh", async () => {
    const calls: string[][] = [];
    const pi = {
      exec: async (_cmd: string, args: string[]) => {
        calls.push(args);
        return { stdout: "", stderr: "", code: 0, killed: false };
      },
    };

    const result = await submitPullRequestReview(pi as never, {
      repo: "o/r",
      prNumber: "42",
      commitId: "sha",
      verdict: "request_changes",
    });

    expect(result.ok).toBe(false);
    expect(calls.length).toBe(0);
  });
});
