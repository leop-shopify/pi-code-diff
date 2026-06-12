import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { getBranchBaseRef, getChangedFileReferenceCounts, getChangedFileReferenceGraph, getWorkingTreeContent, isPathInside, isReviewFileSizeAllowed, isReviewableFilePath, limitReviewItems, MAX_REVIEW_FILE_BYTES, MAX_REVIEW_FILE_COUNT, mergeChangedPaths, parseLocalBranchRefs, parseNameStatus, parseNumStat, parseUntrackedPaths, selectClosestAncestorBranch } from "../git.js";

describe("git helpers", () => {
  it("parses modified, added, deleted, and renamed files", () => {
    const output = [
      "M\tsrc/app.ts",
      "A\tREADME.md",
      "D\told.txt",
      "R100\tsrc/old-name.ts\tsrc/new-name.ts",
    ].join("\n");

    expect(parseNameStatus(output)).toEqual([
      { status: "modified", oldPath: "src/app.ts", newPath: "src/app.ts" },
      { status: "added", oldPath: null, newPath: "README.md" },
      { status: "deleted", oldPath: "old.txt", newPath: null },
      { status: "renamed", oldPath: "src/old-name.ts", newPath: "src/new-name.ts" },
    ]);
  });

  it("merges tracked and untracked changes without duplicates", () => {
    const tracked = [{ status: "modified" as const, oldPath: "src/a.ts", newPath: "src/a.ts" }];
    const untracked = [
      { status: "added" as const, oldPath: null, newPath: "src/new.ts" },
      { status: "modified" as const, oldPath: "src/a.ts", newPath: "src/a.ts" },
    ];

    expect(mergeChangedPaths(tracked, untracked)).toEqual([
      { status: "modified", oldPath: "src/a.ts", newPath: "src/a.ts" },
      { status: "added", oldPath: null, newPath: "src/new.ts" },
    ]);
  });

  it("parses untracked paths", () => {
    expect(parseUntrackedPaths("src/new.ts\nnotes.md\n")).toEqual([
      { status: "added", oldPath: null, newPath: "src/new.ts" },
      { status: "added", oldPath: null, newPath: "notes.md" },
    ]);
  });

  it("parses numstat additions and deletions", () => {
    expect(parseNumStat("12\t3\tsrc/app.ts\n-\t-\tassets/generated.bin\n")).toEqual(new Map([
      ["src/app.ts", { additions: 12, deletions: 3 }],
      ["assets/generated.bin", { additions: 0, deletions: 0 }],
    ]));
  });

  it("counts changed files referenced by other changed files", () => {
    const changes = [
      { status: "added" as const, oldPath: null, newPath: "src/root.ts" },
      { status: "modified" as const, oldPath: "src/a.ts", newPath: "src/a.ts" },
      { status: "modified" as const, oldPath: "src/nested/b.ts", newPath: "src/nested/b.ts" },
    ];
    const contents = new Map([
      ["src/a.ts", "import { root } from './root';\n"],
      ["src/nested/b.ts", "export { root } from '../root';\n"],
    ]);

    expect(getChangedFileReferenceCounts(changes, contents).get("src/root.ts")).toBe(2);
    const graph = getChangedFileReferenceGraph(changes, contents);
    expect(graph.outgoing.get("src/a.ts")).toEqual(["src/root.ts"]);
    expect(graph.incoming.get("src/root.ts")).toEqual(["src/a.ts", "src/nested/b.ts"]);
  });

  it("filters obvious binary or minified assets", () => {
    expect(isReviewableFilePath("src/app.ts")).toBe(true);
    expect(isReviewableFilePath("assets/logo.png")).toBe(false);
    expect(isReviewableFilePath("dist/app.min.js")).toBe(false);
  });

  it("parses local branch refs", () => {
    const output = [
      "main\tabc123",
      "parent branch\tdef456",
      "malformed",
      "child\t789abc",
    ].join("\n");

    expect(parseLocalBranchRefs(output)).toEqual([
      { name: "main", commit: "abc123" },
      { name: "parent branch", commit: "def456" },
      { name: "child", commit: "789abc" },
    ]);
  });

  it("selects the nearest ancestor branch instead of always using trunk", () => {
    expect(selectClosestAncestorBranch([
      { name: "main", distanceFromHead: 4 },
      { name: "parent", distanceFromHead: 1 },
      { name: "same-head", distanceFromHead: 0 },
    ])).toBe("parent");
  });

  it("uses the nearest local ancestor branch as the branch diff base", async () => {
    const exec = vi.fn(async (_command: string, args: string[]) => {
      if (args.join(" ") === "branch --show-current") return { code: 0, stdout: "child\n", stderr: "" };
      if (args[0] === "for-each-ref") return { code: 0, stdout: "main\tabc123\nparent\tdef456\nchild\t789abc\n", stderr: "" };
      if (args.join(" ") === "merge-base --is-ancestor main HEAD") return { code: 0, stdout: "", stderr: "" };
      if (args.join(" ") === "merge-base --is-ancestor parent HEAD") return { code: 0, stdout: "", stderr: "" };
      if (args.join(" ") === "rev-list --count main..HEAD") return { code: 0, stdout: "4\n", stderr: "" };
      if (args.join(" ") === "rev-list --count parent..HEAD") return { code: 0, stdout: "1\n", stderr: "" };
      return { code: 1, stdout: "", stderr: "unexpected command" };
    });

    expect(await getBranchBaseRef({ exec } as never, "/repo")).toBe("parent");
  });

  it("checks path containment", () => {
    expect(isPathInside("/repo", "/repo/src/app.ts")).toBe(true);
    expect(isPathInside("/repo", "/repo")).toBe(true);
    expect(isPathInside("/repo", "/repo2/src/app.ts")).toBe(false);
    expect(isPathInside("/repo", "/tmp/secret.txt")).toBe(false);
  });

  it("limits review item counts and file sizes", () => {
    expect(limitReviewItems(Array.from({ length: MAX_REVIEW_FILE_COUNT + 3 }, (_, index) => index))).toHaveLength(MAX_REVIEW_FILE_COUNT);
    expect(isReviewFileSizeAllowed(MAX_REVIEW_FILE_BYTES)).toBe(true);
    expect(isReviewFileSizeAllowed(MAX_REVIEW_FILE_BYTES + 1)).toBe(false);
  });

  it("does not read working-tree symlinks outside the repo", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-code-diff-"));
    const repo = join(root, "repo");
    await mkdir(repo);
    const secret = join(root, "secret.txt");
    await writeFile(secret, "secret", "utf8");
    await symlink(secret, join(repo, "leak.txt"));

    expect(await getWorkingTreeContent(repo, "leak.txt")).toBe("");
  });

  it("reads working-tree symlinks that stay inside the repo", async () => {
    const repo = await mkdtemp(join(tmpdir(), "pi-code-diff-"));
    await writeFile(join(repo, "target.txt"), "safe", "utf8");
    await symlink(join(repo, "target.txt"), join(repo, "link.txt"));

    expect(await getWorkingTreeContent(repo, "link.txt")).toBe("safe");
  });
});
