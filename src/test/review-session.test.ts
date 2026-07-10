import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createReviewSessionId, deleteReviewSession, getReviewSessionPathForDiagnostics, loadReviewSession, saveReviewSession } from "../review-session.js";
import type { ReviewState } from "../types.js";

const originalSessionsDir = process.env.PI_CODE_DIFF_SESSIONS_DIR;
let sessionsDir: string;

function state(): ReviewState {
  return {
    activeScope: "git-diff",
    activeFileId: "src/app.ts",
    searchQuery: "app",
    focus: "diff",
    wrapLines: true,
    hideUnchanged: false,
    selectedCommentIndex: 0,
    selectedLineTargetByScopeFile: { "git-diff::src/app.ts": { side: "added", line: 4 } },
    draft: {
      allComment: "Review note",
      allIntent: "discuss",
      comments: [{
        id: "line:git-diff:src/app.ts:added:4",
        fileId: "src/app.ts",
        scope: "git-diff",
        side: "added",
        intent: "comment",
        startLine: 4,
        endLine: 4,
        body: "Keep this covered.",
      }],
    },
  };
}

beforeEach(async () => {
  sessionsDir = await mkdtemp(join(tmpdir(), "pi-code-diff-sessions-"));
  process.env.PI_CODE_DIFF_SESSIONS_DIR = sessionsDir;
});

afterEach(async () => {
  if (originalSessionsDir == null) delete process.env.PI_CODE_DIFF_SESSIONS_DIR;
  else process.env.PI_CODE_DIFF_SESSIONS_DIR = originalSessionsDir;
  await rm(sessionsDir, { recursive: true, force: true });
});

describe("review sessions", () => {
  it("persists and restores a versioned review snapshot by identity", () => {
    const identity = "/repo|base|head";
    const id = saveReviewSession(identity, {
      state: state(),
      diffViewMode: "side-by-side",
      navigatorTreeMode: true,
      contextLineNavigation: false,
      commentsGlobal: true,
      showAllLocales: true,
      reviewedFileIds: ["src/app.ts"],
      navigatorScroll: 2,
      diffScroll: 8,
      commentsScroll: 1,
    });

    expect(id).toBe(createReviewSessionId(identity));
    expect(loadReviewSession(identity)).toMatchObject({
      version: 1,
      id,
      identity,
      diffViewMode: "side-by-side",
      showAllLocales: true,
      reviewedFileIds: ["src/app.ts"],
      state: { activeFileId: "src/app.ts", draft: { allComment: "Review note" } },
    });
  });

  it("rejects corrupted or future-version session data", async () => {
    const identity = "/repo|base|head";
    const path = getReviewSessionPathForDiagnostics(createReviewSessionId(identity));
    await writeFile(path, JSON.stringify({ version: 99, identity }), "utf8");

    expect(loadReviewSession(identity)).toBeNull();
  });

  it("deletes a persisted review session", () => {
    const identity = "/repo|base|head";
    saveReviewSession(identity, {
      state: state(),
      diffViewMode: "unified",
      navigatorTreeMode: true,
      contextLineNavigation: false,
      commentsGlobal: false,
      reviewedFileIds: [],
      navigatorScroll: 0,
      diffScroll: 0,
      commentsScroll: 0,
    });

    deleteReviewSession(identity);
    expect(loadReviewSession(identity)).toBeNull();
  });
});
