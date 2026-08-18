import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createReviewSessionId, deleteReviewSession, getReviewSessionPathForDiagnostics, loadReviewSession, saveReviewSession, saveReviewSessionWithStatus } from "../review-session.js";
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
    const result = saveReviewSessionWithStatus(identity, {
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

    expect(result).toEqual({ id: createReviewSessionId(identity), saved: true });
    expect(loadReviewSession(identity)).toMatchObject({
      version: 2,
      id: result.id,
      identity,
      diffViewMode: "side-by-side",
      showAllLocales: true,
      reviewedFileIds: ["src/app.ts"],
      state: { activeFileId: "src/app.ts", draft: { allComment: "Review note" } },
    });
  });

  it("retains the legacy ID-returning save delegate", () => {
    const identity = "/repo|legacy|save";
    const data = {
      state: state(),
      diffViewMode: "unified" as const,
      navigatorTreeMode: false,
      contextLineNavigation: true,
      commentsGlobal: false,
      reviewedFileIds: [],
      navigatorScroll: 0,
      diffScroll: 0,
      commentsScroll: 0,
    };

    expect(saveReviewSession(identity, data)).toBe(createReviewSessionId(identity));
    expect(loadReviewSession(identity)?.id).toBe(createReviewSessionId(identity));
  });

  it("loads v1 losslessly as v2 without eagerly rewriting and marks legacy line anchors stale", async () => {
    const identity = "/repo|base|head";
    const id = createReviewSessionId(identity);
    const path = getReviewSessionPathForDiagnostics(id);
    const legacy = {
      version: 1,
      id,
      identity,
      updatedAt: "2025-01-01T00:00:00.000Z",
      state: state(),
      diffViewMode: "unified",
      navigatorTreeMode: true,
      contextLineNavigation: false,
      commentsGlobal: false,
      reviewedFileIds: [],
      navigatorScroll: 0,
      diffScroll: 0,
      commentsScroll: 0,
    };
    (legacy.state.draft.comments as any[]).push({
      id: "modify", fileId: "src/app.ts", scope: "git-diff", side: "added", intent: "modify",
      startLine: 6, endLine: 7, body: "replacement", originalText: "before\ntext",
    });
    (legacy.state.draft.comments as any[]).push({
      id: "file", fileId: "src/app.ts", scope: "git-diff", side: "file", intent: "comment",
      startLine: null, endLine: null, body: "file note", fileTarget: "file",
    });
    await writeFile(path, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");

    const loaded = loadReviewSession(identity);
    expect(loaded).toMatchObject({
      version: 2,
      state: { draft: { comments: [{
        body: "Keep this covered.",
        intent: "comment",
        fileId: "src/app.ts",
        side: "added",
        startLine: 4,
        endLine: 4,
        anchorStatus: "stale",
      }, {
        body: "replacement",
        intent: "modify",
        startLine: 6,
        endLine: 7,
        originalText: "before\ntext",
        anchorStatus: "stale",
      }, {
        body: "file note",
        side: "file",
        anchorStatus: "mapped",
      }] } },
    });
    expect(await readFile(path, "utf8")).toBe(`${JSON.stringify(legacy, null, 2)}\n`);

    const result = saveReviewSessionWithStatus(identity, loaded!);
    expect(result).toEqual({ id, saved: true });
    expect(JSON.parse(await readFile(path, "utf8")).version).toBe(2);
  });

  it("round-trips every unresolved anchor field and signals durable saves", () => {
    const identity = "/repo|base|head";
    const exact = {
      id: "stable-id",
      fileId: "src/app.ts",
      scope: "git-diff" as const,
      side: "deleted" as const,
      intent: "modify" as const,
      startLine: 7,
      endLine: 9,
      body: "\treplacement()  \r\n  child()",
      originalText: "\toriginal()  \r\n  child()",
      captureHash: { algorithm: "sha256" as const, value: "a".repeat(64) },
      anchorStatus: "stale" as const,
    };
    const data = {
      state: { ...state(), draft: { allComment: "Review note", allIntent: "modify" as const, comments: [exact] } },
      diffViewMode: "unified" as const,
      navigatorTreeMode: false,
      contextLineNavigation: true,
      commentsGlobal: true,
      reviewedFileIds: ["src/app.ts"],
      navigatorScroll: 3,
      diffScroll: 4,
      commentsScroll: 5,
    };

    expect(saveReviewSessionWithStatus(identity, data)).toEqual({ id: createReviewSessionId(identity), saved: true });
    expect(loadReviewSession(identity)?.state.draft).toEqual(data.state.draft);
  });

  it("signals persistence failure without reporting a durable save", async () => {
    const identity = "/repo|base|head";
    const invalidParent = join(sessionsDir, "not-a-directory");
    await writeFile(invalidParent, "occupied", "utf8");
    process.env.PI_CODE_DIFF_SESSIONS_DIR = invalidParent;

    const result = saveReviewSessionWithStatus(identity, {
      state: state(),
      diffViewMode: "unified",
      navigatorTreeMode: false,
      contextLineNavigation: true,
      commentsGlobal: false,
      reviewedFileIds: [],
      navigatorScroll: 0,
      diffScroll: 0,
      commentsScroll: 0,
    });

    expect(result).toEqual({ id: createReviewSessionId(identity), saved: false });
  });

  it("rejects corrupted or future-version session data", async () => {
    const identity = "/repo|base|head";
    const path = getReviewSessionPathForDiagnostics(createReviewSessionId(identity));
    await writeFile(path, JSON.stringify({ version: 99, identity }), "utf8");

    expect(loadReviewSession(identity)).toBeNull();
  });

  it("deletes a persisted review session", () => {
    const identity = "/repo|base|head";
    expect(saveReviewSessionWithStatus(identity, {
      state: state(),
      diffViewMode: "unified",
      navigatorTreeMode: true,
      contextLineNavigation: false,
      commentsGlobal: false,
      reviewedFileIds: [],
      navigatorScroll: 0,
      diffScroll: 0,
      commentsScroll: 0,
    })).toEqual({ id: createReviewSessionId(identity), saved: true });

    deleteReviewSession(identity);
    expect(loadReviewSession(identity)).toBeNull();
  });
});
