import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadCommentShortcuts: vi.fn(),
  getReviewWindowData: vi.fn(),
  getReviewWindowDataForRevisionRange: vi.fn(),
  loadReviewFileContents: vi.fn(),
  composeReviewPrompt: vi.fn(),
  runReviewApp: vi.fn(),
}));

vi.mock("../shortcuts.js", () => ({
  loadCommentShortcuts: mocks.loadCommentShortcuts,
}));

vi.mock("../git.js", () => ({
  getReviewWindowData: mocks.getReviewWindowData,
  getReviewWindowDataForRevisionRange: mocks.getReviewWindowDataForRevisionRange,
  loadReviewFileContents: mocks.loadReviewFileContents,
}));

vi.mock("../prompt.js", () => ({
  composeReviewPrompt: mocks.composeReviewPrompt,
}));

vi.mock("../ui/review-app.js", () => ({
  runReviewApp: mocks.runReviewApp,
}));

const { composeRemoteReviewPrompt, composeReviewSubmissionPrompt, mergeReviewBodies, default: codeDiffExtension } = await import("../index.js");

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
    expect(prompt).toContain("Present each changed text item using this exact style");
    expect(prompt).toContain("If the current ask tool can queue multiple questions, batch the changed text items in one ask call");
    expect(prompt).toContain("one separate question per item");
    expect(prompt).toContain("The user's Approve choice is the confirmation to submit that item.");
    expect(prompt).toContain("Do not ask for a second/final submission confirmation.");
    expect(prompt).toContain("Call submit_pr_review once with the full arguments below");
    expect(prompt).toContain("reply with the PR link and the short action summary returned by the tool");
    expect(prompt).toContain('"body": "Shouwlwn be as MagicModules"');
    expect(prompt).toContain('"repo": "example/widgets"');
  });

  it("merges optional review body comments with existing review body text", () => {
    expect(mergeReviewBodies("LGTM", "src/app.ts:\nNice catch")).toBe("LGTM\n\nsrc/app.ts:\nNice catch");
    expect(mergeReviewBodies("  ", undefined)).toBeUndefined();
  });

  it("registers code, code-diff, and diff commands plus agent tools", () => {
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
    expect(pi.registerTool).not.toHaveBeenCalledWith(expect.objectContaining({ name: "interactive_review" }));
    expect(pi.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "open_code_diff" }));
    expect(pi.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "submit_pr_review" }));
  });

  it("documents the agent-only remote DISCUSS restore flow", () => {
    const prompt = composeRemoteReviewPrompt({
      gitRoot: "/repo",
      baseRef: "origin/main",
      headRef: "origin/feature/review",
      remote: "https://github.com/example/widgets/pull/1",
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
    }, "Respond to the following review discussion items in prose only.");

    expect(prompt).toContain("This handoff is for the agent only.");
    expect(prompt).toContain("DISCUSS items are agent-only questions. Answer them in prose");
    expect(prompt).toContain("restore this same diff by calling open_code_diff");
    expect(prompt).toContain('"args": "remote https://github.com/example/widgets/pull/1"');
    expect(prompt).toContain('"cwd": "/repo"');
  });

  it("open_code_diff waits for local review completion and returns prompt details", async () => {
    const tools = new Map<string, any>();
    const files = [{
      id: "src/app.ts::working::::",
      path: "src/app.ts",
      worktreeStatus: "modified",
      hasWorkingTreeFile: true,
      inGitDiff: true,
      inLastCommit: false,
      inAllFiles: false,
      gitDiff: { status: "modified", oldPath: "src/app.ts", newPath: "src/app.ts", displayPath: "src/app.ts", hasOriginal: true, hasModified: true },
      lastCommit: null,
      allFiles: null,
    }];
    mocks.getReviewWindowData.mockResolvedValue({ repoRoot: "/custom-repo", files, branchBaseRevision: null, modifiedRevision: undefined, visibleScopes: ["git-diff"] });
    mocks.runReviewApp.mockResolvedValue({ type: "submit", allComment: "", allIntent: "discuss", comments: [] });
    mocks.composeReviewPrompt.mockReturnValue("generated review prompt");
    const pi = {
      registerCommand: vi.fn(),
      registerTool: vi.fn((tool) => tools.set(tool.name, tool)),
      registerShortcut: vi.fn(),
      on: vi.fn(),
    };
    const ctx = {
      hasUI: true,
      cwd: "/repo",
      ui: {
        notify: vi.fn(),
        setWidget: vi.fn(),
        setEditorText: vi.fn(),
      },
    };

    codeDiffExtension(pi as never);
    const result = await tools.get("open_code_diff").execute("tool-call", { args: "", cwd: "/custom-repo" }, new AbortController().signal, vi.fn(), ctx);

    expect(mocks.getReviewWindowData).toHaveBeenCalledWith(pi, "/custom-repo");
    expect(mocks.runReviewApp).toHaveBeenCalled();
    expect(ctx.ui.setEditorText).toHaveBeenCalledWith("generated review prompt");
    expect(result.details).toMatchObject({ started: true, args: "", cwd: "/custom-repo", prompt: "generated review prompt" });
    expect(result.content[0].text).toContain("local working-tree/uncommitted changes");
    expect(result.content[0].text).toContain("generated review prompt");
  });

  it("does not block the diff command while review data loads", async () => {
    const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
    let resolveData: (data: unknown) => void = () => {};
    mocks.getReviewWindowData.mockReturnValue(new Promise((resolve) => { resolveData = resolve; }));
    const pi = {
      registerCommand: vi.fn((name: string, command) => commands.set(name, command)),
      registerTool: vi.fn(),
      registerShortcut: vi.fn(),
      on: vi.fn(),
    };
    const ctx = {
      hasUI: true,
      cwd: "/repo",
      ui: {
        notify: vi.fn(),
        setWidget: vi.fn(),
        setEditorText: vi.fn(),
      },
    };

    codeDiffExtension(pi as never);
    const command = commands.get("diff")!;

    await expect(command.handler("", ctx)).resolves.toBeUndefined();
    expect(mocks.getReviewWindowData).toHaveBeenCalledWith(pi, "/repo");
    expect(mocks.runReviewApp).not.toHaveBeenCalled();

    resolveData({ repoRoot: "/repo", files: [], branchBaseRevision: "main", modifiedRevision: "HEAD" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ctx.ui.notify).toHaveBeenCalledWith("No reviewable files found for this diff.", "info");
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
