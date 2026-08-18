import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearRemoteReviewTargetCache, extractBranchFromRemote, formatPullRequestContext, resolveRemoteReviewTarget } from "../remote.js";

describe("remote review helpers", () => {
  beforeEach(() => {
    clearRemoteReviewTargetCache();
  });

  it("parses GitHub, stack-host, review-host, short PR, and branch remote inputs", () => {
    expect(extractBranchFromRemote("https://github.com/example/widgets/pull/123")).toEqual({ branch: "__pr__123", repo: "example/widgets", prNumber: "123", provider: "github" });
    expect(extractBranchFromRemote("https://app.stack-host.dev/github/pr/example/widgets/456")).toEqual({ branch: "__pr__456", repo: "example/widgets", prNumber: "456", provider: "github" });
    expect(extractBranchFromRemote("https://review-host.example.io/repos/example/widgets/pulls/2002491")).toEqual({ branch: "__pr__2002491", repo: "example/widgets", prNumber: "2002491", provider: "provider" });
    expect(extractBranchFromRemote("https://review-host.example.io/repos/example/widgets/pulls/2002491/files")).toEqual({ branch: "__pr__2002491", repo: "example/widgets", prNumber: "2002491", provider: "provider" });
    expect(extractBranchFromRemote("example/widgets#789")).toEqual({ branch: "__pr__789", repo: "example/widgets", prNumber: "789", provider: "github" });
    expect(extractBranchFromRemote("feature/stack-branch")).toEqual({ branch: "feature/stack-branch" });
  });

  it("rejects attacker-shaped and malformed review-host URLs", () => {
    expect(extractBranchFromRemote("https://evil.example/https://review-host.example.io/repos/example/widgets/pulls/1")).toBeNull();
    expect(extractBranchFromRemote("https://review-host.example.io.evil.example/repos/example/widgets/pulls/1")).toBeNull();
    expect(extractBranchFromRemote("https://user@review-host.example.io/repos/example/widgets/pulls/1")).toBeNull();
    expect(extractBranchFromRemote("http://review-host.example.io/repos/example/widgets/pulls/1")).toBeNull();
    expect(extractBranchFromRemote("https://review-host.example.io/repos/example/widgets/pulls/1?redirect=https://evil.example")).toBeNull();
    expect(extractBranchFromRemote("https://review-host.example.io/repos/example/widgets/pulls/1/commits")).toBeNull();
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

  it("skips broad stack parent candidate scans by default", async () => {
    const fetchCalls: string[][] = [];
    const previousScan = process.env.PI_CODE_DIFF_SCAN_STACK_PARENTS;
    delete process.env.PI_CODE_DIFF_SCAN_STACK_PARENTS;
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
        return { code: 1, stdout: "", stderr: "should not scan candidates", killed: false };
      }
      if (command === "git" && args.join(" ") === "merge-base origin/main origin/child/review") return { code: 0, stdout: "main-base\n", stderr: "", killed: false };
      if (command === "git" && args[1] === "fetch") {
        fetchCalls.push(args);
        return { code: 0, stdout: "", stderr: "", killed: false };
      }
      return { code: 1, stdout: "", stderr: `unexpected ${command} ${args.join(" ")}`, killed: false };
    });

    const target = await resolveRemoteReviewTarget({ exec } as never, "/repo", "https://github.com/example/widgets/pull/123", "/repo");

    expect(target).toMatchObject({
      baseRef: "main-base",
      headRef: "origin/child/review",
      pullRequest: { number: "123", stackParent: undefined },
    });
    expect(exec).not.toHaveBeenCalledWith("provider-cli", expect.arrayContaining(["list"]), expect.anything());
    expect(fetchCalls).toHaveLength(1);
    if (previousScan == null) delete process.env.PI_CODE_DIFF_SCAN_STACK_PARENTS;
    else process.env.PI_CODE_DIFF_SCAN_STACK_PARENTS = previousScan;
  });

  it("resolves stacked GitHub PRs to the closest ancestor PR when candidate scanning is enabled", async () => {
    const fetchCalls: string[][] = [];
    const previousScan = process.env.PI_CODE_DIFF_SCAN_STACK_PARENTS;
    process.env.PI_CODE_DIFF_SCAN_STACK_PARENTS = "1";
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
    if (previousScan == null) delete process.env.PI_CODE_DIFF_SCAN_STACK_PARENTS;
    else process.env.PI_CODE_DIFF_SCAN_STACK_PARENTS = previousScan;
  });

  it("resolves review-host PR metadata and pins the fetched base and head SHAs", async () => {
    const fetchCalls: string[][] = [];
    const exec = vi.fn(async (command: string, args: string[]) => {
      if (command === "provider-cli" && args[0] === "api" && args[1] === "repos/example/widgets/pulls/2002491") {
        return {
          code: 0,
          stdout: JSON.stringify({
            number: 2002491,
            title: "Refresh schema",
            body: "Body",
            additions: 428,
            deletions: 1,
            changed_files: 6,
            user: { login: "author@example.com" },
            state: "open",
            draft: false,
            head: { ref: "feature/schema", sha: "head-sha" },
            base: { ref: "main", sha: "base-sha" },
          }),
          stderr: "",
          killed: false,
        };
      }
      if (command === "provider-cli" && args[0] === "api" && args[1] === "repos/example/widgets/pulls/2002491/reviews") {
        return { code: 0, stdout: JSON.stringify([{ user: { login: "reviewer@example.com" }, state: "APPROVED" }]), stderr: "", killed: false };
      }
      if (command === "git" && args[1] === "fetch") {
        fetchCalls.push(args);
        return { code: 0, stdout: "", stderr: "", killed: false };
      }
      if (command === "git" && args.join(" ") === "rev-parse refs/remotes/origin/provider/2002491/base") return { code: 0, stdout: "base-sha\n", stderr: "", killed: false };
      if (command === "git" && args.join(" ") === "rev-parse refs/remotes/origin/provider/2002491/head") return { code: 0, stdout: "head-sha\n", stderr: "", killed: false };
      if (command === "git" && args[0] === "merge-base") return { code: 0, stdout: "merge-base-sha\n", stderr: "", killed: false };
      return { code: 1, stdout: "", stderr: `unexpected ${command} ${args.join(" ")}`, killed: false };
    });

    await expect(resolveRemoteReviewTarget(
      { exec } as never,
      "/repo",
      "https://review-host.example.io/repos/example/widgets/pulls/2002491/files",
      "/repo",
    )).resolves.toMatchObject({
      provider: "provider",
      gitRoot: "/repo",
      baseRef: "merge-base-sha",
      headRef: "origin/provider/2002491/head",
      branch: "feature/schema",
      repo: "example/widgets",
      pullRequest: {
        number: "2002491",
        headRefOid: "head-sha",
        baseRefOid: "base-sha",
        reviews: [{ author: { login: "reviewer@example.com" }, state: "APPROVED" }],
      },
    });
    expect(fetchCalls[0]).toContain("+refs/heads/main:refs/remotes/origin/provider/2002491/base");
    expect(fetchCalls[0]).toContain("+refs/heads/feature/schema:refs/remotes/origin/provider/2002491/head");
  });

  it("fails closed when a fetched review-host target no longer matches its metadata", async () => {
    const exec = vi.fn(async (command: string, args: string[]) => {
      if (command === "provider-cli" && args[0] === "api" && args[1].endsWith("/reviews")) {
        return { code: 0, stdout: "[]", stderr: "", killed: false };
      }
      if (command === "provider-cli") {
        return {
          code: 0,
          stdout: JSON.stringify({
            number: 8,
            title: "Drifting PR",
            body: "",
            additions: 1,
            deletions: 0,
            changed_files: 1,
            user: { login: "author@example.com" },
            state: "open",
            head: { ref: "feature/drift", sha: "expected-head" },
            base: { ref: "main", sha: "expected-base" },
          }),
          stderr: "",
          killed: false,
        };
      }
      if (command === "git" && args[1] === "fetch") return { code: 0, stdout: "", stderr: "", killed: false };
      if (command === "git" && args[0] === "rev-parse") return { code: 0, stdout: "different-head\n", stderr: "", killed: false };
      return { code: 1, stdout: "", stderr: "unexpected", killed: false };
    });

    await expect(resolveRemoteReviewTarget(
      { exec } as never,
      "/repo",
      "https://review-host.example.io/repos/example/widgets/pulls/8",
      "/repo",
    )).rejects.toThrow(/changed while preparing the review/i);
  });

  it("fails closed on malformed provider metadata", async () => {
    const exec = vi.fn(async (command: string) => command === "provider-cli"
      ? { code: 0, stdout: "{not json", stderr: "", killed: false }
      : { code: 1, stdout: "", stderr: "unexpected", killed: false });

    await expect(resolveRemoteReviewTarget(
      { exec } as never,
      "/repo",
      "https://review-host.example.io/repos/example/widgets/pulls/8",
      "/repo",
    )).rejects.toThrow(/malformed provider response/i);
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
    await mkdir(join(monorepoRoot, "packages/widgets"), { recursive: true });
    await writeFile(configPath, JSON.stringify({
      repositories: {
        "example/widgets": {
          cwd: monorepoRoot,
          subdir: "packages/widgets",
          pathspecs: ["packages/widgets", "shared/ui"],
          importAliases: { "@workspace/shared": "shared/ui" },
        },
      },
    }));
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
        if (command === "git" && args[0] === "remote") return { code: 0, stdout: "https://github.com/example/widgets.git\n", stderr: "", killed: false };
        if (command === "git" && args[1] === "fetch") return { code: 0, stdout: "", stderr: "", killed: false };
        return { code: 1, stdout: "", stderr: `unexpected ${command} ${args.join(" ")}`, killed: false };
      });

      await expect(resolveRemoteReviewTarget({ exec } as never, "/repo", "https://github.com/example/widgets/pull/123")).resolves.toMatchObject({
        gitRoot: monorepoRoot,
        baseRef: "origin/main",
        headRef: "origin/feature/review",
        branch: "feature/review",
        repo: "example/widgets",
        workspacePath: "packages/widgets",
        pathspecs: ["packages/widgets", "shared/ui"],
        importAliases: { "@workspace/shared": "shared/ui" },
      });
      expect(exec).toHaveBeenCalledWith("git", expect.arrayContaining(["origin"]), expect.objectContaining({ cwd: monorepoRoot }));
    } finally {
      if (previousConfigPath == null) delete process.env.PI_CODE_DIFF_CONFIG_PATH;
      else process.env.PI_CODE_DIFF_CONFIG_PATH = previousConfigPath;
      await rm(configRoot, { recursive: true, force: true });
    }
  });

  it("rejects a configured checkout whose remote does not match the requested repository", async () => {
    const previousConfigPath = process.env.PI_CODE_DIFF_CONFIG_PATH;
    const configRoot = await mkdtemp(join(tmpdir(), "pi-code-diff-config-mismatch-"));
    const checkoutRoot = join(configRoot, "checkout");
    const configPath = join(configRoot, "code-diff.json");
    await mkdir(checkoutRoot, { recursive: true });
    await writeFile(configPath, JSON.stringify({ repositories: { "example/widgets": { cwd: checkoutRoot } } }));
    process.env.PI_CODE_DIFF_CONFIG_PATH = configPath;

    try {
      const exec = vi.fn(async (command: string, args: string[]) => {
        if (command === "git" && args[0] === "remote") return { code: 0, stdout: "https://github.com/example/another-repo.git\n", stderr: "", killed: false };
        return { code: 1, stdout: "", stderr: `unexpected ${command} ${args.join(" ")}`, killed: false };
      });

      await expect(resolveRemoteReviewTarget({ exec } as never, "/repo", "https://github.com/example/widgets/pull/123")).rejects.toThrow(
        `Configured checkout ${checkoutRoot} does not match example/widgets.`,
      );
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

  it("bypasses cached targets for DISCUSS continuation and replaces the normal cache on success", async () => {
    const exec = vi.fn(async (command: string, args: string[]) => {
      if (command === "git" && args[0] === "symbolic-ref") return { code: 0, stdout: "origin/main\n", stderr: "", killed: false };
      if (command === "git" && args[1] === "fetch") return { code: 0, stdout: "", stderr: "", killed: false };
      return { code: 1, stdout: "", stderr: `unexpected ${command} ${args.join(" ")}`, killed: false };
    });

    await resolveRemoteReviewTarget({ exec } as never, "/repo", "feature/review", "/repo");
    const callsAfterInitial = exec.mock.calls.length;
    await resolveRemoteReviewTarget({ exec } as never, "/repo", "feature/review", "/repo", undefined, { cacheMode: "bypass" });
    const callsAfterRefresh = exec.mock.calls.length;
    await resolveRemoteReviewTarget({ exec } as never, "/repo", "feature/review", "/repo");

    expect(callsAfterRefresh).toBeGreaterThan(callsAfterInitial);
    expect(exec.mock.calls.length).toBe(callsAfterRefresh);
  });

  it("retains the old cache when a forced DISCUSS refresh fails", async () => {
    let failRefresh = false;
    const exec = vi.fn(async (command: string, args: string[]) => {
      if (command === "git" && args[0] === "symbolic-ref") return { code: 0, stdout: "origin/main\n", stderr: "", killed: false };
      if (command === "git" && args[1] === "fetch") return failRefresh
        ? { code: 1, stdout: "", stderr: "refresh failed", killed: false }
        : { code: 0, stdout: "", stderr: "", killed: false };
      return { code: 1, stdout: "", stderr: `unexpected ${command} ${args.join(" ")}`, killed: false };
    });

    const original = await resolveRemoteReviewTarget({ exec } as never, "/repo", "feature/review", "/repo");
    failRefresh = true;
    await expect(resolveRemoteReviewTarget({ exec } as never, "/repo", "feature/review", "/repo", undefined, { cacheMode: "bypass" })).rejects.toThrow("refresh failed");
    const callsAfterFailure = exec.mock.calls.length;
    await expect(resolveRemoteReviewTarget({ exec } as never, "/repo", "feature/review", "/repo")).resolves.toBe(original);
    expect(exec.mock.calls.length).toBe(callsAfterFailure);
  });

  it("reuses the cached remote review target within the TTL and refreshes after expiry", async () => {
    vi.useFakeTimers();
    try {
      const exec = vi.fn(async (command: string, args: string[]) => {
        if (command === "git" && args[0] === "symbolic-ref") return { code: 0, stdout: "origin/main\n", stderr: "", killed: false };
        if (command === "git" && args[1] === "fetch") return { code: 0, stdout: "", stderr: "", killed: false };
        return { code: 1, stdout: "", stderr: `unexpected ${command} ${args.join(" ")}`, killed: false };
      });

      await resolveRemoteReviewTarget({ exec } as never, "/repo", "feature/review", "/repo");
      const callsAfterFirst = exec.mock.calls.length;

      const progress: string[] = [];
      await resolveRemoteReviewTarget({ exec } as never, "/repo", "feature/review", "/repo", (message) => progress.push(message));
      expect(exec.mock.calls.length).toBe(callsAfterFirst);
      expect(progress).toContain("Using cached remote review for feature/review\u2026");

      vi.advanceTimersByTime(10 * 60 * 1000 + 1);
      await resolveRemoteReviewTarget({ exec } as never, "/repo", "feature/review", "/repo");
      expect(exec.mock.calls.length).toBeGreaterThan(callsAfterFirst);
    } finally {
      vi.useRealTimers();
    }
  });
});
