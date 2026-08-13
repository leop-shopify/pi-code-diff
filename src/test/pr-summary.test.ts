import { describe, expect, it, vi } from "vitest";
import { createRemotePullRequestSummarySource } from "../pr-summary.js";
import type { RemoteReviewTarget } from "../remote.js";

function target(pullRequest: Partial<NonNullable<RemoteReviewTarget["pullRequest"]>> = {}): RemoteReviewTarget {
  return {
    gitRoot: "/repo",
    baseRef: "origin/main",
    headRef: "origin/feature",
    remote: "https://github.com/example/widgets/pull/12",
    branch: "feature",
    repo: "example/widgets",
    pullRequest: {
      number: "12",
      repo: "example/widgets",
      title: "Remove old checkout path",
      body: "### Intent\nRemove the old path.\n\n### Tested\nUnit tests pass.",
      additions: 3,
      deletions: 9,
      changedFiles: 2,
      authorLogin: "alice",
      state: "OPEN",
      reviews: [],
      headRefName: "feature",
      headRefOid: "abc123",
      baseRefName: "main",
      ...pullRequest,
    },
  };
}

describe("remote PR summary source", () => {
  it("loads PR context through a background agent prompt", async () => {
    const exec = vi.fn(async (command: string, args: string[]) => {
      if (command === "provider-cli" && args[0] === "pr") {
        return {
          code: 0,
          stdout: JSON.stringify({
            url: "https://github.com/example/widgets/pull/12",
            isDraft: false,
            mergeStateStatus: "CLEAN",
            reviewDecision: "APPROVED",
            comments: [{ author: { login: "bob" }, body: "Looks good after the latest update.", createdAt: "2026-06-25T10:00:00Z" }],
            reviews: [{ author: { login: "bob" }, state: "APPROVED", body: "", submittedAt: "2026-06-25T10:01:00Z" }],
            statusCheckRollup: [],
          }),
          stderr: "",
          killed: false,
        };
      }
      if (command === "provider-cli" && args[0] === "api") {
        return {
          code: 0,
          stdout: JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    nodes: [{
                      isResolved: false,
                      isOutdated: false,
                      path: "src/app.ts",
                      line: 42,
                      comments: {
                        nodes: [{ author: { login: "carol" }, body: "Can we keep the legacy checkout path compatible?", createdAt: "2026-06-25T10:02:00Z", url: "https://github.com/example/widgets/pull/12#discussion_r1", path: "src/app.ts", line: 42 }],
                      },
                    }],
                  },
                },
              },
            },
          }),
          stderr: "",
          killed: false,
        };
      }
      if (command === "pi") {
        expect(args).toContain("--no-tools");
        expect(args).toContain("--no-extensions");
        expect(args).toContain("-p");
        expect(args.join("\n")).toContain("Status must be exactly one of pending, blocked, approved");
        expect(args.join("\n")).toContain("Diff: 2 files touched | +3/-9");
        expect(args.join("\n")).toContain("Open review comments:");
        expect(args.join("\n")).toContain("Can we keep the legacy checkout path compatible?");
        return {
          code: 0,
          stdout: "Title: Remove old checkout path\\x0aURL: https://github.com/example/widgets/pull/12\\x0aAuthor: alice\\x0aStatus: pending — open review comments\\x0aProblem: Remove the old path.\nChanges: Deletes old checkout code.\nValidation: Unit tests pass.\nOpen comments: carol asked whether the legacy checkout path needs compatibility.\n",
          stderr: "",
          killed: false,
        };
      }
      return { code: 1, stdout: "", stderr: `unexpected ${command}`, killed: false };
    });

    const source = createRemotePullRequestSummarySource({ exec } as never, { model: { provider: "openai", id: "gpt-5" } } as never, target())!;

    const summary = await source.load();

    expect(summary).toContain("Title:\nRemove old checkout path");
    expect(summary).toContain("URL:\nhttps://github.com/example/widgets/pull/12");
    expect(summary).toContain("Author:\nalice");
    expect(summary).toContain("Diff:\n2 files touched | +3/-9");
    expect(summary).toContain("Status:\npending - open review comments");
    expect(summary).toContain("\n\nProblem:\nRemove the old path.");
    expect(summary).toContain("Open comments:\ncarol asked whether the legacy checkout path needs compatibility.");
    expect(summary).not.toContain("\\x0a");
    expect(exec).toHaveBeenCalledWith("provider-cli", expect.arrayContaining(["--repo", "example/widgets"]), expect.objectContaining({ cwd: "/repo" }));
    expect(exec).toHaveBeenCalledWith("provider-cli", expect.arrayContaining(["api", "graphql"]), expect.objectContaining({ cwd: "/repo" }));
    expect(exec).toHaveBeenCalledWith("pi", expect.arrayContaining(["--model", "openai/gpt-5"]), expect.objectContaining({ cwd: "/repo" }));
  });

  it("loads review-host PR context through provider without invoking provider-cli", async () => {
    const providerTarget = {
      ...target({ repo: "example/widgets", baseRefOid: "base-sha" }),
      provider: "provider" as const,
      repo: "example/widgets",
      remote: "https://review-host.example.io/repos/example/widgets/pulls/12/files",
    };
    const exec = vi.fn(async (command: string, args: string[]) => {
      if (command === "provider-cli" && args[1] === "repos/example/widgets/pulls/12") {
        return {
          code: 0,
          stdout: JSON.stringify({
            html_url: "https://review-host.example.io/repos/example/widgets/pulls/12",
            draft: false,
            mergeable_state: "blocked",
            created_at: "2026-06-25T09:00:00Z",
            updated_at: "2026-06-25T10:00:00Z",
            x_provider: { mergeability: { has_changes_requested_review: false, has_approved_review: false } },
          }),
          stderr: "",
          killed: false,
        };
      }
      if (command === "provider-cli" && args[1] === "repos/example/widgets/issues/12/comments") {
        return { code: 0, stdout: JSON.stringify([{ user: { login: "bob@example.com" }, body: "Top-level context", created_at: "2026-06-25T10:00:00Z" }]), stderr: "", killed: false };
      }
      if (command === "provider-cli" && args[1] === "repos/example/widgets/pulls/12/reviews") {
        return { code: 0, stdout: "[]", stderr: "", killed: false };
      }
      if (command === "provider-cli" && args[1] === "repos/example/widgets/pulls/12/comments") {
        return {
          code: 0,
          stdout: JSON.stringify([{ user: { login: "carol@example.com" }, body: "Can this preserve compatibility?", created_at: "2026-06-25T10:02:00Z", path: "src/app.ts", line: 42, x_provider: { is_resolved: false } }]),
          stderr: "",
          killed: false,
        };
      }
      if (command === "pi") {
        expect(args.join("\n")).toContain("Can this preserve compatibility?");
        return {
          code: 0,
          stdout: "Title: Remove old checkout path\nURL: https://review-host.example.io/repos/example/widgets/pulls/12\nAuthor: alice\nDiff: 2 files touched | +3/-9\nStatus: pending - open review comments\nProblem: Remove the old path.\nChanges: Deletes old checkout code.\nValidation: No failing checks found.\nOpen comments: carol asked about compatibility.",
          stderr: "",
          killed: false,
        };
      }
      return { code: 1, stdout: "", stderr: `unexpected ${command} ${args.join(" ")}`, killed: false };
    });

    const source = createRemotePullRequestSummarySource({ exec } as never, {} as never, providerTarget)!;
    const summary = await source.load();

    expect(summary).toContain("URL:\nhttps://review-host.example.io/repos/example/widgets/pulls/12");
    expect(summary).toContain("Open comments:\ncarol asked about compatibility.");
    expect(exec.mock.calls.some(([command]) => command === "provider-cli")).toBe(false);
  });

  it("shows the example River requester as the visible author", async () => {
    const exec = vi.fn(async (command: string, args: string[]) => {
      if (command === "provider-cli" && args[0] === "pr") {
        return {
          code: 0,
          stdout: JSON.stringify({
            url: "https://github.com/example/widgets/pull/12",
            isDraft: false,
            mergeStateStatus: "CLEAN",
            reviewDecision: "APPROVED",
            comments: [],
            reviews: [],
            statusCheckRollup: [],
          }),
          stderr: "",
          killed: false,
        };
      }
      if (command === "provider-cli" && args[0] === "api") {
        return { code: 0, stdout: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } }), stderr: "", killed: false };
      }
      if (command === "pi") {
        expect(args.join("\n")).toContain("Author: example/river requested by Andre Amaral andre.amaral@example.com");
        return {
          code: 0,
          stdout: "Title: Remove old checkout path\nURL: https://github.com/example/widgets/pull/12\nAuthor: example/river\nDiff: 2 files touched | +3/-9\nStatus: approved - review decision approved\nProblem: Remove the old path.\nChanges: Deletes old checkout code.\nValidation: Unit tests pass.\nOpen comments: None found.",
          stderr: "",
          killed: false,
        };
      }
      return { code: 1, stdout: "", stderr: `unexpected ${command}`, killed: false };
    });
    const riverTarget = target({
      authorLogin: "example/river",
      body: "# Context\nRemove the old path.\n\nRequested by Andre Amaral <andre.amaral@example.com>\nSlack thread: https://example.com/thread",
    });

    const source = createRemotePullRequestSummarySource({ exec } as never, {} as never, riverTarget)!;
    const summary = await source.load();

    expect(summary).toContain("Author:\nexample/river requested by Andre Amaral andre.amaral@example.com");
    expect(summary).not.toContain("Author:\nexample/river\n");
  });

  it("falls back deterministically and keeps the bot login without requester metadata", async () => {
    const exec = vi.fn(async (command: string, args: string[]) => {
      if (command === "provider-cli" && args[0] === "pr") {
        return {
          code: 0,
          stdout: JSON.stringify({
            url: "https://github.com/example/widgets/pull/12",
            isDraft: false,
            mergeStateStatus: "UNSTABLE",
            reviewDecision: "APPROVED",
            comments: [{ author: { login: "stack-host" }, body: "This pull request is not mergeable because a downstack PR is open.", createdAt: "2026-06-25T10:00:00Z" }],
            reviews: [],
            statusCheckRollup: [],
          }),
          stderr: "",
          killed: false,
        };
      }
      if (command === "provider-cli" && args[0] === "api") {
        return { code: 0, stdout: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } }), stderr: "", killed: false };
      }
      return { code: 1, stdout: "", stderr: "agent unavailable", killed: false };
    });

    const source = createRemotePullRequestSummarySource({ exec } as never, {} as never, target())!;
    const summary = await source.load();

    expect(summary).toContain("Author:\nalice");
    expect(summary).toContain("Diff:\n2 files touched | +3/-9");
    expect(summary).toContain("Status:\nblocked");
    expect(summary).toContain("not mergeable");

    const riverSource = createRemotePullRequestSummarySource({ exec } as never, {} as never, target({
      authorLogin: "example/river",
      body: "# Context\nNo requester metadata is available.",
    }))!;
    const riverSummary = await riverSource.load();

    expect(riverSummary).toContain("Author:\nexample/river");
    expect(riverSummary).not.toContain("requested by");
  });
});
