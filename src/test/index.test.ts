import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadCommentShortcuts: vi.fn(),
  getReviewWindowData: vi.fn(),
  loadReviewFileContents: vi.fn(),
  composeReviewPrompt: vi.fn(),
  runReviewApp: vi.fn(),
}));

vi.mock("../shortcuts.js", () => ({
  loadCommentShortcuts: mocks.loadCommentShortcuts,
}));

vi.mock("../git.js", () => ({
  getReviewWindowData: mocks.getReviewWindowData,
  loadReviewFileContents: mocks.loadReviewFileContents,
}));

vi.mock("../prompt.js", () => ({
  composeReviewPrompt: mocks.composeReviewPrompt,
}));

vi.mock("../ui/review-app.js", () => ({
  runReviewApp: mocks.runReviewApp,
}));

const { composeReviewSubmissionPrompt, default: codeDiffExtension } = await import("../index.js");

describe("code diff extension", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadCommentShortcuts.mockReturnValue({
      shortcuts: [],
      globalShortcut: "alt+s",
      warnings: ["bad shortcut config"],
      path: "/tmp/code-diff.json",
    });
  });

  it("builds an agent-mediated review submission prompt", () => {
    const prompt = composeReviewSubmissionPrompt({
      gitRoot: "/repo",
      baseRef: "origin/main",
      headRef: "origin/pr/1/head",
      remote: "example/widgets#1",
      branch: "feature/review",
      repo: "example/widgets",
      pullRequest: {
        number: "1",
        repo: "example/widgets",
        title: "Add review mode",
        body: "",
        additions: 1,
        deletions: 0,
        changedFiles: 1,
        authorLogin: "alice",
        state: "OPEN",
        reviews: [],
        headRefName: "feature/review",
        headRefOid: "abc123",
        baseRefName: "main",
      },
    }, "comment", undefined, [
      { path: "src/app.ts", line: 12, side: "RIGHT", body: "Shouwlwn be as MagicModules" },
    ]);

    expect(prompt).toContain("Do not read files, search the repository, run commands, run tests, inspect diffs, open plans, create todos, or enter plan mode.");
    expect(prompt).toContain("Fix only grammar, spelling, capitalization, and punctuation");
    expect(prompt).toContain("Original: <original text>");
    expect(prompt).toContain("Fixed   : <fixed text>");
    expect(prompt).toContain("Choices: Approve, Edit, Skip");
    expect(prompt).toContain("Resolve changed text items one at a time");
    expect(prompt).toContain("Do not ask for all decisions in one combined prompt.");
    expect(prompt).toContain("each queued question must still be one item only");
    expect(prompt).toContain("The user's Approve choice is the confirmation to submit that item.");
    expect(prompt).toContain("Do not ask for a second/final submission confirmation.");
    expect(prompt).toContain('"body": "Shouwlwn be as MagicModules"');
    expect(prompt).toContain('"repo": "example/widgets"');
  });

  it("registers code, code-diff, and diff commands", () => {
    const pi = {
      registerCommand: vi.fn(),
      registerTool: vi.fn(),
      registerShortcut: vi.fn(),
      on: vi.fn(),
    };

    codeDiffExtension(pi as never);

    expect(pi.registerCommand).toHaveBeenCalledWith("code", expect.any(Object));
    expect(pi.registerCommand).toHaveBeenCalledWith("code-diff", expect.any(Object));
    expect(pi.registerCommand).toHaveBeenCalledWith("diff", expect.any(Object));
    expect(pi.registerCommand).not.toHaveBeenCalledWith("interactive-review", expect.any(Object));
    expect(pi.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "interactive_review" }));
  });

  it("surfaces initial shortcut config warnings on startup and reload", async () => {
    const handlers = new Map<string, (event: { reason: string }, ctx: { hasUI: boolean; ui: { notify: ReturnType<typeof vi.fn> } }) => Promise<void>>();
    const pi = {
      registerCommand: vi.fn(),
      registerTool: vi.fn(),
      registerShortcut: vi.fn(),
      on: vi.fn((event: string, handler) => handlers.set(event, handler)),
    };
    const ctx = { hasUI: true, ui: { notify: vi.fn() } };

    codeDiffExtension(pi as never);

    await handlers.get("session_start")?.({ reason: "startup" }, ctx);
    await handlers.get("session_start")?.({ reason: "reload" }, ctx);

    expect(ctx.ui.notify).toHaveBeenCalledTimes(2);
    expect(ctx.ui.notify).toHaveBeenNthCalledWith(1, "code-diff config: bad shortcut config", "warning");
    expect(ctx.ui.notify).toHaveBeenNthCalledWith(2, "code-diff config: bad shortcut config", "warning");
  });
});
