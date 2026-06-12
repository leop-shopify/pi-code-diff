import { describe, expect, it, vi } from "vitest";
import { extractBranchFromRemote, formatPullRequestContext, resolveRemoteReviewTarget } from "../remote.js";

describe("remote review helpers", () => {
  it("parses GitHub, stack-host, short PR, and branch remote inputs", () => {
    expect(extractBranchFromRemote("https://github.com/example/widgets/pull/123")).toEqual({ branch: "__pr__123", repo: "example/widgets", prNumber: "123" });
    expect(extractBranchFromRemote("https://app.stack-host.dev/github/pr/example/widgets/456")).toEqual({ branch: "__pr__456", repo: "example/widgets", prNumber: "456" });
    expect(extractBranchFromRemote("example/widgets#789")).toEqual({ branch: "__pr__789", repo: "example/widgets", prNumber: "789" });
    expect(extractBranchFromRemote("feature/stack-branch")).toEqual({ branch: "feature/stack-branch" });
  });

  it("formats pull request context with deduplicated latest reviewer state", () => {
    expect(formatPullRequestContext({
      number: "123",
      repo: "example/widgets",
      title: "Add review mode",
      body: "",
      additions: 10,
      deletions: 4,
      changedFiles: 3,
      authorLogin: "leo",
      state: "OPEN",
      reviews: [
        { author: { login: "reviewer" }, state: "COMMENTED" },
        { author: { login: "reviewer" }, state: "APPROVED" },
      ],
      headRefName: "feature/review",
      headRefOid: "abc123",
      baseRefName: "main",
    })).toContain("reviewer (approved)");
  });

  it("resolves same-repo GitHub PRs to fetched base and head refs", async () => {
    const exec = vi.fn(async (command: string, args: string[]) => {
      if (command === "provider-cli" && args[0] === "pr" && args[1] === "view") {
        return {
          code: 0,
          stdout: JSON.stringify({
            title: "Add review mode",
            body: "Body",
            additions: 10,
            deletions: 4,
            changedFiles: 3,
            author: { login: "leo" },
            state: "OPEN",
            reviews: [],
            headRefName: "feature/review",
            headRefOid: "abc123",
            baseRefName: "main",
          }),
          stderr: "",
          killed: false,
        };
      }

      if (command === "git" && args[1] === "fetch") return { code: 0, stdout: "", stderr: "", killed: false };
      return { code: 1, stdout: "", stderr: `unexpected ${command} ${args.join(" ")}`, killed: false };
    });

    await expect(resolveRemoteReviewTarget({ exec } as never, "/repo", "https://github.com/example/widgets/pull/123", "/repo")).resolves.toMatchObject({
      gitRoot: "/repo",
      baseRef: "origin/main",
      headRef: "origin/feature/review",
      branch: "feature/review",
      pullRequest: { number: "123", headRefOid: "abc123" },
    });
  });

  it("resolves plain remote branches against the default branch", async () => {
    const exec = vi.fn(async (command: string, args: string[]) => {
      if (command === "git" && args[0] === "symbolic-ref") return { code: 0, stdout: "origin/main\n", stderr: "", killed: false };
      if (command === "git" && args[1] === "fetch") return { code: 0, stdout: "", stderr: "", killed: false };
      return { code: 1, stdout: "", stderr: `unexpected ${command} ${args.join(" ")}`, killed: false };
    });

    await expect(resolveRemoteReviewTarget({ exec } as never, "/repo", "feature/review", "/repo")).resolves.toMatchObject({
      gitRoot: "/repo",
      baseRef: "origin/main",
      headRef: "origin/feature/review",
      branch: "feature/review",
    });
  });
});
