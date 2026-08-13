import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildproviderComments, buildInlineComments, buildReviewBody, buildReviewPayload, submitPullRequestReview } from "../review-submit.js";
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
  it("maps comment and modify line items, mirroring GitHub sides", () => {
    const files = [makeFile("src/a.ts", "src/a.ts")];
    const comments: DiffReviewComment[] = [
      comment({ id: "1", fileId: "src/a.ts", side: "added", intent: "comment", startLine: 10, endLine: 10, body: "added note" }),
      comment({ id: "2", fileId: "src/a.ts", side: "deleted", intent: "comment", startLine: 5, endLine: 5, body: "deleted note" }),
      comment({ id: "3", fileId: "src/a.ts", side: "added", intent: "discuss", startLine: 7, endLine: 7, body: "discuss skipped" }),
      comment({ id: "4", fileId: "src/a.ts", side: "added", intent: "modify", startLine: 8, endLine: 8, originalText: "oldName()", body: "newName()" }),
      comment({ id: "5", fileId: "src/a.ts", side: "file", intent: "comment", body: "file skipped" }),
    ];

    const inline = buildInlineComments(files, comments);

    expect(inline).toEqual([
      { path: "src/a.ts", line: 10, side: "RIGHT", body: "added note" },
      { path: "src/a.ts", line: 5, side: "LEFT", body: "deleted note" },
      { path: "src/a.ts", line: 8, side: "RIGHT", body: ["Suggested change:", "", "```diff", "- oldName()", "+ newName()", "```"].join("\n") },
    ]);
  });

  it("preserves exact modify whitespace in the generated suggestion", () => {
    const files = [makeFile("src/a.ts", "src/a.ts")];
    const [inline] = buildInlineComments(files, [
      comment({
        id: "1",
        fileId: "src/a.ts",
        side: "added",
        intent: "modify",
        startLine: 8,
        endLine: 9,
        originalText: "\told()  \r\n  child()",
        body: "\tnew()  \r\n  child()  ",
      }),
    ]);

    expect(inline?.body).toContain("- \told()  \n-   child()");
    expect(inline?.body).toContain("+ \tnew()  \n+   child()  ");
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

describe("buildproviderComments", () => {
  it("maps line and file comments to provider's atomic review shape", () => {
    const files = [makeFile("src/a.ts", "src/a.ts")];
    expect(buildproviderComments(files, [
      comment({ id: "1", fileId: "src/a.ts", side: "added", intent: "comment", startLine: 10, endLine: 12, body: "range" }),
      comment({ id: "2", fileId: "src/a.ts", side: "file", intent: "comment", body: "file note" }),
    ])).toEqual([
      { path: "src/a.ts", line: 12, side: "RIGHT", body: "range", start_line: 10, start_side: "RIGHT" },
      { path: "src/a.ts", subject_type: "file", body: "file note" },
    ]);
  });

  it("fails closed instead of dropping unsupported provider comment locations", () => {
    const files = [{ ...makeFile("src/a.ts", "src/a.ts"), pathPrefix: "packages/app" }];
    expect(() => buildproviderComments(files, [
      comment({ id: "1", fileId: "src/a.ts", side: "added", intent: "comment", startLine: 10, endLine: 10, body: "note" }),
    ])).toThrow(/cannot safely map/i);
  });
});

describe("buildReviewBody", () => {
  it("keeps GitHub review body to comment-intent review-wide and file comments", () => {
    const files = [makeFile("src/a.ts", "src/a.ts")];
    expect(buildReviewBody(files, {
      type: "submit",
      allComment: "Overall note",
      allIntent: "comment",
      comments: [
        comment({ id: "1", fileId: "src/a.ts", side: "file", intent: "comment", body: "File note" }),
        comment({ id: "2", fileId: "src/a.ts", side: "added", intent: "comment", startLine: 3, endLine: 3, body: "Inline note" }),
        comment({ id: "3", fileId: "src/a.ts", side: "file", intent: "discuss", body: "Discuss note" }),
      ],
    })).toBe("Overall note\n\nsrc/a.ts:\nFile note");
  });
});

describe("buildReviewPayload", () => {
  it("maps verdicts to provider events without changing GitHub payloads", () => {
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

    expect(buildReviewPayload({
      provider: "provider",
      repo: "example/widgets",
      prNumber: "1",
      commitId: "sha",
      baseCommitId: "base",
      verdict: "approve",
      body: "lgtm",
    })).toEqual({ event: "APPROVE", body: "lgtm", commit_id: "sha" });
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
    expect(result.message).toContain("https://github.com/o/r/pull/42");
    expect(result.message).toContain("PR was approved at");
    expect(payload).toEqual({ event: "APPROVE", body: "looks good" });
  });

  it("posts inline comments before approving when approval includes comments", async () => {
    const payloads: unknown[] = [];
    const pi = {
      exec: async (_cmd: string, args: string[]) => {
        if (args.includes("user")) return { stdout: "reviewer\n", stderr: "", code: 0, killed: false };
        const inputIndex = args.indexOf("--input");
        if (inputIndex >= 0) payloads.push(JSON.parse(readFileSync(args[inputIndex + 1]!, "utf8")));
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
      comments: [{ path: "src/app.ts", line: 12, side: "RIGHT", body: "Inline note" }],
    });

    expect(result.ok).toBe(true);
    expect(result.message).toContain("https://github.com/o/r/pull/42");
    expect(result.message).toContain("PR was approved at");
    expect(result.message).toContain("1 inline comment was added.");
    expect(result.message).toContain("Your review body comment was included in the approval.");
    expect(payloads).toEqual([
      { event: "COMMENT", commit_id: "sha", comments: [{ path: "src/app.ts", line: 12, side: "RIGHT", body: "Inline note" }] },
      { event: "APPROVE", body: "looks good" },
    ]);
  });

  it("submits a provider verdict and bundled comments atomically after target validation", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    let payload: unknown;
    const pi = {
      exec: async (command: string, args: string[]) => {
        calls.push({ command, args });
        if (command === "provider-cli" && args[1] === "/user") {
          return { stdout: JSON.stringify({ login: "reviewer@example.com" }), stderr: "", code: 0, killed: false };
        }
        if (command === "provider-cli" && args[1] === "repos/example/widgets/pulls/42") {
          return { stdout: JSON.stringify({ state: "open", head: { sha: "head" }, base: { sha: "base" } }), stderr: "", code: 0, killed: false };
        }
        const inputIndex = args.indexOf("--input");
        if (command === "provider-cli" && inputIndex >= 0) {
          payload = JSON.parse(readFileSync(args[inputIndex + 1]!, "utf8"));
          return { stdout: JSON.stringify({ id: 9, state: "APPROVED" }), stderr: "", code: 0, killed: false };
        }
        return { stdout: "", stderr: "unexpected", code: 1, killed: false };
      },
    };

    const result = await submitPullRequestReview(pi as never, {
      provider: "provider",
      repo: "example/widgets",
      prNumber: "42",
      commitId: "head",
      baseCommitId: "base",
      verdict: "approve",
      prAuthorLogin: "author@example.com",
      body: "looks good",
      comments: [
        { path: "src/app.ts", line: 12, side: "RIGHT", body: "Inline note" },
        { path: "src/file.ts", subject_type: "file", body: "File note" },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.message).toContain("https://review-host.example.io/repos/example/widgets/pulls/42");
    expect(payload).toEqual({
      event: "APPROVE",
      body: "looks good",
      commit_id: "head",
      comments: [
        { path: "src/app.ts", line: 12, side: "RIGHT", body: "Inline note" },
        { path: "src/file.ts", subject_type: "file", body: "File note" },
      ],
    });
    expect(calls.filter(({ args }) => args.includes("--input"))).toHaveLength(1);
    expect(calls.some(({ command }) => command === "provider-cli")).toBe(false);
  });

  it("fails closed on provider target drift before submission", async () => {
    const calls: string[][] = [];
    const pi = {
      exec: async (_command: string, args: string[]) => {
        calls.push(args);
        if (args[1] === "/user") return { stdout: JSON.stringify({ login: "reviewer@example.com" }), stderr: "", code: 0, killed: false };
        return { stdout: JSON.stringify({ state: "open", head: { sha: "new-head" }, base: { sha: "base" } }), stderr: "", code: 0, killed: false };
      },
    };

    const result = await submitPullRequestReview(pi as never, {
      provider: "provider",
      repo: "example/widgets",
      prNumber: "42",
      commitId: "old-head",
      baseCommitId: "base",
      verdict: "approve",
      prAuthorLogin: "author@example.com",
    });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/head changed/i);
    expect(calls.some((args) => args.includes("--input"))).toBe(false);
  });

  it("fails closed on malformed or failed provider commands", async () => {
    const malformed = await submitPullRequestReview({
      exec: async () => ({ stdout: "not-json", stderr: "", code: 0, killed: false }),
    } as never, {
      provider: "provider",
      repo: "example/widgets",
      prNumber: "42",
      commitId: "head",
      baseCommitId: "base",
      verdict: "approve",
      prAuthorLogin: "author@example.com",
    });
    expect(malformed.ok).toBe(false);
    expect(malformed.message).toMatch(/malformed provider response/i);

    const failed = await submitPullRequestReview({
      exec: async () => ({ stdout: "", stderr: "authentication required", code: 4, killed: false }),
    } as never, {
      provider: "provider",
      repo: "example/widgets",
      prNumber: "42",
      commitId: "head",
      baseCommitId: "base",
      verdict: "comment",
      body: "note",
    });
    expect(failed.ok).toBe(false);
    expect(failed.message).toContain("authentication required");
  });

  it("rejects request_changes with no body or comments before calling provider-cli", async () => {
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
