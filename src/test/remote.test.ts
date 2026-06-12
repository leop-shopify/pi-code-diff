import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { extractBranchFromRemote, formatPullRequestContext, resolveRemoteReviewTarget } from "../remote.js";

describe("remote review helpers", () => {
  it("parses GitHub, Graphite, short PR, and branch remote inputs", () => {
    expect(extractBranchFromRemote("https://github.com/example/widgets/pull/123")).toEqual({ branch: "__pr__123", repo: "example/widgets", prNumber: "123" });
    expect(extractBranchFromRemote("https://app.graphite.dev/github/pr/example/widgets/456")).toEqual({ branch: "__pr__456", repo: "example/widgets", prNumber: "456" });
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
      if (command === "gh" && args[0] === "pr" && args[1] === "view") {
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

  it("resolves GitHub PRs through a matching current checkout", async () => {
    const exec = vi.fn(async (command: string, args: string[], options?: { cwd?: string }) => {
      if (command === "git" && args[0] === "rev-parse") return { code: 0, stdout: "/repo\n", stderr: "", killed: false };
      if (command === "git" && args[0] === "remote") return { code: 0, stdout: "git@github.com:example/widgets.git\n", stderr: "", killed: false };
      if (command === "gh" && args[0] === "pr" && args[1] === "view") {
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
        if (command === "gh" && args[0] === "pr" && args[1] === "view") {
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
        if (command === "gh" && args[0] === "pr" && args[1] === "view") {
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
