import { describe, expect, it } from "vitest";
import { buildStructuredDiff } from "../diff.js";
import { buildDisplayRows, buildEditorLaunchCommand, getEditorLineForTarget } from "../ui/review-app.js";

describe("buildDisplayRows", () => {
  it("keeps deleted and added rows independently commentable when line numbers overlap", () => {
    const diff = buildStructuredDiff(
      ["alpha", "removed", "kept"].join("\n") + "\n",
      ["alpha", "kept"].join("\n") + "\n",
      3,
    );

    const rowsAtLineTwo = buildDisplayRows(diff).filter((row) => row.displayLineNumber === 2);

    expect(rowsAtLineTwo).toHaveLength(2);
    expect(rowsAtLineTwo.map((row) => ({ kind: row.kind, commentLineNumber: row.commentLineNumber, commentSide: row.commentSide }))).toEqual([
      { kind: "removed", commentLineNumber: 2, commentSide: "deleted" },
      { kind: "context", commentLineNumber: 2, commentSide: "added" },
    ]);
  });
});

describe("getEditorLineForTarget", () => {
  it("maps deleted lines to the nearest surviving working-tree line", () => {
    const diff = buildStructuredDiff(
      ["alpha", "removed", "kept"].join("\n") + "\n",
      ["alpha", "kept"].join("\n") + "\n",
      3,
    );

    expect(getEditorLineForTarget(diff, { side: "deleted", line: 2 })).toBe(2);
  });
});

describe("buildEditorLaunchCommand", () => {
  it("opens the requested file and line with shell-safe quoting", () => {
    expect(buildEditorLaunchCommand("nvim", "/tmp/a b's.ts", 12)).toBe("nvim +12 -- '/tmp/a b'\\''s.ts'");
  });

  it("falls back to vi and clamps invalid line numbers", () => {
    expect(buildEditorLaunchCommand(" ", "/tmp/file.ts", 0)).toBe("vi +1 -- '/tmp/file.ts'");
  });
});
