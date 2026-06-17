import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("formats stacked pull request context", () => {
    const baseOnly = formatPullRequestContext({
      number: "123",
      repo: "example/widgets",
      title: "Child change",
      body: "",
      additions: 10,
      deletions: 4,
      changedFiles: 3,
      authorLogin: "leo",
      state: "OPEN",
      reviews: [],
      headRefName: "child/review",
      headRefOid: "abc123",
      baseRefName: "parent/review",
    });
    expect(baseOnly).toContain("Base branch: parent/review");

    const withParent = formatPullRequestContext({
      number: "123",
      repo: "example/widgets",
      title: "Child change",
      body: "",
      additions: 10,
      deletions: 4,
      changedFiles: 3,
      authorLogin: "leo",
      state: "OPEN",
      reviews: [],
      headRefName: "child/review",
      headRefOid: "abc123",
      baseRefName: "parent/review",
      stackParent: {
        number: "6",
        title: "Parent change",
        headRefName: "parent/review",
        state: "MERGED",
        url: "https://github.com/example/widgets/pull/6",
      },
    });
    expect(withParent).toContain("Stack parent: PR #6 Parent change (parent/review, merged)");
  });

  it("resolves stacked GitHub PRs to the closest ancestor PR even when GitHub base is main", async () => {
    const fetchCalls: string[][] = [];
    const exec = vi.fn(async (command: string, args: string[]) => {
      if (command === "provider-cli" && args[0] === "pr" && args[1] === "view") {
        return {
          code: 0,
          stdout: JSON.stringify({
            title: "Child change",
            body: "Body",
            additions: 10,
            deletions: 4,
            changedFiles: 3,
            author: { login: "leo" },
            state: "OPEN",
            reviews: [],
            headRefName: "child/review",
            headRefOid: "abc123",
            baseRefName: "main",
          }),
          stderr: "",
          killed: false,
        };
      }
      if (command === "provider-cli" && args[0] === "pr" && args[1] === "list") {
        return {
          code: 0,
          stdout: JSON.stringify([
            { number: 6, title: "Parent change", headRefName: "parent/review", state: "MERGED", url: "https://github.com/example/widgets/pull/6" },
            { number: 5, title: "Unrelated change", headRefName: "unrelated/review", state: "OPEN", url: "https://github.com/example/widgets/pull/5" },
          ]),
          stderr: "",
          killed: false,
        };
      }

      if (command === "git" && args.join(" ") === "merge-base origin/main origin/child/review") return { code: 0, stdout: "main-base\n", stderr: "", killed: false };
      if (command === "git" && args.join(" ") === "merge-base origin/parent/review origin/child/review") return { code: 0, stdout: "parent-base\n", stderr: "", killed: false };
      if (command === "git" && args.join(" ") === "merge-base --is-ancestor origin/parent/review origin/child/review") return { code: 0, stdout: "", stderr: "", killed: false };
      if (command === "git" && args.join(" ") === "merge-base --is-ancestor origin/unrelated/review origin/child/review") return { code: 1, stdout: "", stderr: "not ancestor", killed: false };
      if (command === "git" && args.join(" ") === "rev-list --count main-base..origin/child/review") return { code: 0, stdout: "7\n", stderr: "", killed: false };
      if (command === "git" && args.join(" ") === "rev-list --count origin/parent/review..origin/child/review") return { code: 0, stdout: "1\n", stderr: "", killed: false };
      if (command === "git" && args[1] === "fetch") {
        fetchCalls.push(args);
        return { code: 0, stdout: "", stderr: "", killed: false };
      }
      return { code: 1, stdout: "", stderr: `unexpected ${command} ${args.join(" ")}`, killed: false };
    });

    const target = await resolveRemoteReviewTarget({ exec } as never, "/repo", "https://github.com/example/widgets/pull/123", "/repo");

    expect(target).toMatchObject({
      gitRoot: "/repo",
      baseRef: "parent-base",
      headRef: "origin/child/review",
      branch: "child/review",
      pullRequest: {
        number: "123",
        baseRefName: "main",
        stackParent: { number: "6", title: "Parent change", headRefName: "parent/review", state: "MERGED" },
      },
    });
    expect(fetchCalls[0]).toContain("+refs/heads/main:refs/remotes/origin/main");
    expect(fetchCalls[0]).toContain("+refs/heads/child/review:refs/remotes/origin/child/review");
    expect(fetchCalls[1]).toContain("+refs/heads/parent/review:refs/remotes/origin/parent/review");
    expect(formatPullRequestContext(target.pullRequest!)).toContain("Stack parent: PR #6 Parent change (parent/review, merged)");
  });

  it("resolves same-repo GitHub PRs to fetched base and head refs", async () => {
    const fetchCalls: string[][] = [];
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

      if (command === "git" && args[0] === "merge-base") return { code: 0, stdout: "merge-base-sha\n", stderr: "", killed: false };
      if (command === "git" && args[1] === "fetch") {
        fetchCalls.push(args);
        return { code: 0, stdout: "", stderr: "", killed: false };
      }
      return { code: 1, stdout: "", stderr: `unexpected ${command} ${args.join(" ")}`, killed: false };
    });

    await expect(resolveRemoteReviewTarget({ exec } as never, "/repo", "https://github.com/example/widgets/pull/123", "/repo")).resolves.toMatchObject({
      gitRoot: "/repo",
      baseRef: "merge-base-sha",
      headRef: "origin/feature/review",
      branch: "feature/review",
      pullRequest: { number: "123", headRefOid: "abc123" },
    });
    expect(fetchCalls[0]).toContain("+refs/heads/main:refs/remotes/origin/main");
    expect(fetchCalls[0]).toContain("+refs/heads/feature/review:refs/remotes/origin/feature/review");
  });

  it("falls back to GitHub pull refs when a local origin cannot fetch the PR branch", async () => {
    const fetchCalls: string[][] = [];
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

      if (command === "git" && args[0] === "merge-base") return { code: 0, stdout: "merge-base-sha\n", stderr: "", killed: false };
      if (command === "git" && args[1] === "fetch") {
        fetchCalls.push(args);
        if (fetchCalls.length === 1) return { code: 1, stdout: "", stderr: "branch missing", killed: false };
        return { code: 0, stdout: "", stderr: "", killed: false };
      }
      return { code: 1, stdout: "", stderr: `unexpected ${command} ${args.join(" ")}`, killed: false };
    });

    await expect(resolveRemoteReviewTarget({ exec } as never, "/repo", "https://github.com/example/widgets/pull/123", "/repo")).resolves.toMatchObject({
      gitRoot: "/repo",
      baseRef: "merge-base-sha",
      headRef: "origin/pr/123/head",
      branch: "feature/review",
    });
    expect(fetchCalls[0]?.[3]).toBe("origin");
    expect(fetchCalls[1]?.[3]).toBe("https://github.com/example/widgets.git");
    expect(fetchCalls[1]).toContain("+refs/pull/123/head:refs/remotes/origin/pr/123/head");
  });

  it("resolves GitHub PRs through a matching current checkout", async () => {
    const exec = vi.fn(async (command: string, args: string[], options?: { cwd?: string }) => {
      if (command === "git" && args[0] === "rev-parse") return { code: 0, stdout: "/repo\n", stderr: "", killed: false };
      if (command === "git" && args[0] === "remote") return { code: 0, stdout: "git@github.com:example/widgets.git\n", stderr: "", killed: false };
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

    await expect(resolveRemoteReviewTarget({ exec } as never, "/repo/subdir", "https://github.com/example/widgets/pull/123")).resolves.toMatchObject({
      gitRoot: "/repo",
      baseRef: "origin/main",
      headRef: "origin/feature/review",
      branch: "feature/review",
      repo: "example/widgets",
    });
    expect(exec).toHaveBeenCalledWith("git", expect.arrayContaining(["origin"]), expect.objectContaining({ cwd: "/repo" }));
  });

  it("resolves GitHub PRs through a configured monorepo checkout", async () => {
    const previousConfigPath = process.env.PI_CODE_DIFF_CONFIG_PATH;
    const configRoot = await mkdtemp(join(tmpdir(), "pi-code-diff-config-"));
    const monorepoRoot = join(configRoot, "monorepo");
    const configPath = join(configRoot, "code-diff.json");
    await mkdir(monorepoRoot, { recursive: true });
    await writeFile(configPath, JSON.stringify({ repositories: { "example/widgets": { cwd: monorepoRoot } } }));
    process.env.PI_CODE_DIFF_CONFIG_PATH = configPath;

    try {
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

      await expect(resolveRemoteReviewTarget({ exec } as never, "/repo", "https://github.com/example/widgets/pull/123")).resolves.toMatchObject({
        gitRoot: monorepoRoot,
        baseRef: "origin/main",
        headRef: "origin/feature/review",
        branch: "feature/review",
        repo: "example/widgets",
      });
      expect(exec).toHaveBeenCalledWith("git", expect.arrayContaining(["origin"]), expect.objectContaining({ cwd: monorepoRoot }));
    } finally {
      if (previousConfigPath == null) delete process.env.PI_CODE_DIFF_CONFIG_PATH;
      else process.env.PI_CODE_DIFF_CONFIG_PATH = previousConfigPath;
      await rm(configRoot, { recursive: true, force: true });
    }
  });

  it("resolves cross-repo GitHub PRs through a local git cache instead of requiring checkout", async () => {
    const previousCacheRoot = process.env.PI_CODE_DIFF_REMOTE_CACHE_ROOT;
    const cacheRoot = await mkdtemp(join(tmpdir(), "pi-code-diff-remote-"));
    process.env.PI_CODE_DIFF_REMOTE_CACHE_ROOT = cacheRoot;

    try {
      const exec = vi.fn(async (command: string, args: string[], options?: { cwd?: string }) => {
        if (command === "git" && args[0] === "init") return { code: 0, stdout: "Initialized", stderr: "", killed: false };
        if (command === "git" && args[0] === "rev-parse") {
          if (options?.cwd === "/repo") return { code: 1, stdout: "", stderr: "not a repo", killed: false };
          return { code: 0, stdout: `${options?.cwd ?? ""}\n`, stderr: "", killed: false };
        }
        if (command === "git" && args[0] === "remote") return { code: 1, stdout: "", stderr: "no remote", killed: false };
        if (command === "provider-cli" && args[0] === "pr" && args[1] === "view") {
          return {
            code: 0,
            stdout: JSON.stringify({
              title: "Add fixtures",
              body: "Body",
              additions: 10,
              deletions: 4,
              changedFiles: 3,
              author: { login: "contributor" },
              state: "OPEN",
              reviews: [],
              headRefName: "feature/fixtures",
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

      const progress: string[] = [];
      await expect(resolveRemoteReviewTarget({ exec } as never, "/repo", "https://github.com/example/widgets/pull/12", undefined, (message) => progress.push(message))).resolves.toMatchObject({
        baseRef: "origin/main",
        headRef: "origin/feature/fixtures",
        branch: "feature/fixtures",
        repo: "example/widgets",
        pullRequest: { number: "12", headRefOid: "abc123" },
      });
      expect(exec).toHaveBeenCalledWith("git", expect.arrayContaining(["https://github.com/example/widgets.git"]), expect.any(Object));
      expect(progress).toContain("Preparing remote review cache for example/widgets…");
      expect(progress).toContain("Fetching PR #12 metadata from example/widgets…");
    } finally {
      if (previousCacheRoot == null) delete process.env.PI_CODE_DIFF_REMOTE_CACHE_ROOT;
      else process.env.PI_CODE_DIFF_REMOTE_CACHE_ROOT = previousCacheRoot;
      await rm(cacheRoot, { recursive: true, force: true });
    }
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
