import { mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadCommentShortcuts: vi.fn(),
  getReviewWindowData: vi.fn(),
  getReviewWindowDataForRevisionRange: vi.fn(),
  loadReviewFileContents: vi.fn(),
  composeReviewPrompt: vi.fn(),
  runReviewApp: vi.fn(),
  createReviewSessionId: vi.fn(() => "automatic-session"),
  loadReviewSession: vi.fn(),
  saveReviewSession: vi.fn(),
  deleteReviewSession: vi.fn(),
  reviewGrammar: vi.fn(),
  submitPullRequestReview: vi.fn(),
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

vi.mock("../review-session.js", () => ({
  createReviewSessionId: mocks.createReviewSessionId,
  loadReviewSession: mocks.loadReviewSession,
  saveReviewSession: mocks.saveReviewSession,
  deleteReviewSession: mocks.deleteReviewSession,
}));

vi.mock("../ui/review-app.js", () => ({
  runReviewApp: mocks.runReviewApp,
}));

vi.mock("../review-grammar.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../review-grammar.js")>()),
  reviewGrammar: mocks.reviewGrammar,
}));

vi.mock("../review-submit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../review-submit.js")>()),
  submitPullRequestReview: mocks.submitPullRequestReview,
}));

const { composeRemoteReviewPrompt, composeReviewSubmissionPrompt, mergeReviewBodies, submitUiConfirmedReview, default: codeDiffExtension } = await import("../index.js");

function remoteTarget() {
  return {
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
      state: "OPEN" as const,
      reviews: [],
      headRefName: "feature/review",
      headRefOid: "abc123",
      baseRefName: "main",
    },
  };
}

describe("code diff extension", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadReviewSession.mockReturnValue(null);
    mocks.loadCommentShortcuts.mockReturnValue({
      shortcuts: [],
      globalShortcut: "alt+s",
      warnings: ["bad shortcut config"],
      path: "/tmp/code-diff.json",
    });
    mocks.reviewGrammar.mockImplementation(async (_ctx, original) => ({ status: "safe", corrected: original, changes: [] }));
    mocks.submitPullRequestReview.mockResolvedValue({ ok: true, message: "https://github.com/example/widgets/pull/1\nReview comment was posted at 12:00.\n1 inline comment was added." });
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
    expect(prompt).toContain("The review UI already captured the user's explicit confirmation of the exact verdict and original text.");
    expect(prompt).toContain("If every correction is limited to grammar, spelling, capitalization, punctuation, or meaning-preserving syntax and clarity, call submit_pr_review immediately with the cleaned arguments and do not ask for confirmation.");
    expect(prompt).toContain("Ask only about text items whose correction may change meaning, intent, tone, technical substance, or requested scope.");
    expect(prompt).toContain("Original: <original text>");
    expect(prompt).toContain("Fixed   : <fixed text>");
    expect(prompt).toContain("Choices: Approve, Edit, Skip");
    expect(prompt).toContain("Present each such item using this exact style");
    expect(prompt).toContain("If the current ask tool can queue multiple questions, batch the uncertain text items in one ask call");
    expect(prompt).toContain("one separate question per item");
    expect(prompt).toContain("Apply grammar-only corrections automatically.");
    expect(prompt).toContain("The user's Approve choice is the confirmation to submit an uncertain item.");
    expect(prompt).toContain("Do not ask for a second/final submission confirmation.");
    expect(prompt).toContain("Call submit_pr_review once with the full arguments below");
    expect(prompt).toContain("reply with the PR link and the short action summary returned by the tool");
    expect(prompt).toContain('"body": "Shouwlwn be as MagicModules"');
    expect(prompt).toContain('"repo": "example/widgets"');
  });

  it("submits grammar-only corrections immediately after the review UI confirmation", async () => {
    const original = "can we have these 2 components in variables and isolated, so we can simplify this rendering?";
    const corrected = "Can we isolate these two components in variables so we can simplify this rendering?";
    mocks.reviewGrammar.mockResolvedValue({
      status: "safe",
      corrected: { comments: [corrected] },
      changes: [{ key: "comment:0", original, corrected, grammarOnly: true, reason: "Grammar and word order only." }],
    });
    const pi = { sendUserMessage: vi.fn() };
    const ctx = {
      model: { id: "test-model" },
      modelRegistry: {},
      isIdle: vi.fn(() => true),
      ui: {
        setStatus: vi.fn(),
        select: vi.fn(),
        editor: vi.fn(),
        notify: vi.fn(),
      },
    };
    const comments = [{ path: "src/app.ts", line: 12, side: "RIGHT" as const, body: original }];

    await submitUiConfirmedReview(pi as never, ctx as never, remoteTarget(), "comment", undefined, comments);

    expect(ctx.ui.select).not.toHaveBeenCalled();
    expect(mocks.submitPullRequestReview).toHaveBeenCalledWith(pi, expect.objectContaining({
      verdict: "comment",
      comments: [{ path: "src/app.ts", line: 12, side: "RIGHT", body: corrected }],
    }));
    expect(pi.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("already submitted this GitHub review"));
  });

  it("asks only about corrections that may change technical meaning", async () => {
    const firstOriginal = "This dont render correctly.";
    const firstCorrected = "This doesn't render correctly.";
    const secondOriginal = "Can this handle the empty state?";
    const secondCorrected = "This must handle every empty state.";
    mocks.reviewGrammar.mockResolvedValue({
      status: "review",
      corrected: { comments: [firstCorrected, secondCorrected] },
      changes: [
        { key: "comment:0", original: firstOriginal, corrected: firstCorrected, grammarOnly: true, reason: "Grammar only." },
        { key: "comment:1", original: secondOriginal, corrected: secondCorrected, grammarOnly: false, reason: "Changes a question into a requirement." },
      ],
    });
    const pi = { sendUserMessage: vi.fn() };
    const ctx = {
      model: { id: "test-model" },
      modelRegistry: {},
      isIdle: vi.fn(() => true),
      ui: {
        setStatus: vi.fn(),
        select: vi.fn(async (_title: string, _options: string[]) => "Keep original text"),
        editor: vi.fn(),
        notify: vi.fn(),
      },
    };
    const comments = [
      { path: "src/app.ts", line: 12, side: "RIGHT" as const, body: firstOriginal },
      { path: "src/app.ts", line: 20, side: "RIGHT" as const, body: secondOriginal },
    ];

    await submitUiConfirmedReview(pi as never, ctx as never, remoteTarget(), "comment", undefined, comments);

    expect(ctx.ui.select).toHaveBeenCalledTimes(1);
    expect(ctx.ui.select.mock.calls[0]?.[0]).toContain("Comment 2: src/app.ts:20 (RIGHT)");
    expect(mocks.submitPullRequestReview).toHaveBeenCalledWith(pi, expect.objectContaining({
      comments: [
        { path: "src/app.ts", line: 12, side: "RIGHT", body: firstCorrected },
        { path: "src/app.ts", line: 20, side: "RIGHT", body: secondOriginal },
      ],
    }));
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

  it("keeps the remote DISCUSS handoff prose-only and never tells the agent to reopen the diff", () => {
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
    expect(prompt).not.toMatch(/open_code_diff/);
    expect(prompt).not.toMatch(/restore|reopen/i);
  });

  it("only instructs opening open_code_diff on a direct user request", () => {
    const tools = new Map<string, any>();
    const pi = {
      registerCommand: vi.fn(),
      registerTool: vi.fn((tool) => tools.set(tool.name, tool)),
      registerShortcut: vi.fn(),
      on: vi.fn(),
    };

    codeDiffExtension(pi as never);
    const guidelines: string[] = tools.get("open_code_diff").promptGuidelines;

    expect(guidelines.some((line) => /only when the user directly asks/i.test(line))).toBe(true);
    expect(guidelines.some((line) => /do not call .*open_code_diff.*(?:on your own|automatically|because a prompt)/i.test(line))).toBe(true);
    expect(guidelines.join("\n")).not.toMatch(/restore\/reopen|restore the diff/i);
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
    const expandedCwd = join(homedir(), "custom-repo");
    mocks.getReviewWindowData.mockResolvedValue({ repoRoot: expandedCwd, files, branchBaseRevision: null, modifiedRevision: undefined, visibleScopes: ["git-diff"] });
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
    const result = await tools.get("open_code_diff").execute("tool-call", { args: "", cwd: "~/custom-repo" }, new AbortController().signal, vi.fn(), ctx);

    expect(mocks.getReviewWindowData).toHaveBeenCalledWith(pi, expandedCwd);
    expect(mocks.runReviewApp).toHaveBeenCalled();
    expect(ctx.ui.setEditorText).toHaveBeenCalledWith("generated review prompt");
    expect(result.details).toMatchObject({ started: true, args: "", cwd: expandedCwd, prompt: "generated review prompt" });
    expect(result.content[0].text).toContain("local working-tree/uncommitted changes");
    expect(result.content[0].text).toContain("generated review prompt");
  });

  it("dispatches exact and fallback submodule reviews through the correct loaders", async () => {
    const tools = new Map<string, any>();
    const rootFiles = [{
      id: "packages/app::working::::",
      path: "packages/app",
      worktreeStatus: "modified",
      hasWorkingTreeFile: true,
      inGitDiff: true,
      inLastCommit: false,
      inAllFiles: false,
      gitDiff: null,
      lastCommit: null,
      allFiles: null,
    }];
    const rootData = { repoRoot: "/repo", files: rootFiles, branchBaseRevision: null, visibleScopes: ["git-diff"] };
    const nestedData = { repoRoot: "/repo/packages/app", files: [], branchBaseRevision: "abc", modifiedRevision: "def", visibleScopes: ["all-files"] };
    mocks.getReviewWindowData.mockResolvedValue(rootData);
    mocks.getReviewWindowDataForRevisionRange.mockResolvedValue(nestedData);
    const pi = {
      registerCommand: vi.fn(),
      registerTool: vi.fn((tool) => tools.set(tool.name, tool)),
      registerShortcut: vi.fn(),
      on: vi.fn(),
    };
    const ctx = {
      hasUI: true,
      cwd: "/repo",
      ui: { notify: vi.fn(), setWidget: vi.fn(), setEditorText: vi.fn() },
    };

    codeDiffExtension(pi as never);
    mocks.runReviewApp.mockImplementationOnce(async (_ctx, options) => {
      await options.loadSubmoduleReviewData({ repoRoot: "/repo/packages/app", path: "packages/app", oldSha: "abc", newSha: "def", available: true });
      return { type: "cancel" };
    });
    await tools.get("open_code_diff").execute("tool-call", { args: "" }, new AbortController().signal, vi.fn(), ctx);
    expect(mocks.getReviewWindowDataForRevisionRange).toHaveBeenCalledWith(pi, "/repo/packages/app", "abc", "def", { wholeRepo: true });

    mocks.runReviewApp.mockImplementationOnce(async (_ctx, options) => {
      await options.loadSubmoduleReviewData({ repoRoot: "/repo/packages/app", path: "packages/app", oldSha: "abc", newSha: "abc", available: true });
      return { type: "cancel" };
    });
    await tools.get("open_code_diff").execute("tool-call", { args: "" }, new AbortController().signal, vi.fn(), ctx);
    expect(mocks.getReviewWindowData).toHaveBeenCalledWith(pi, "/repo/packages/app", { wholeRepo: true });
  });

  it("open_code_diff seeds prepopulated comments and warns about unresolved ones", async () => {
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
    mocks.getReviewWindowData.mockResolvedValue({ repoRoot: "/repo", files, branchBaseRevision: null, modifiedRevision: undefined, visibleScopes: ["git-diff"] });
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
    await tools.get("open_code_diff").execute("tool-call", {
      args: "",
      comments: [
        { path: "src/app.ts", body: "Handle the nil case.", line: 3, intent: "comment" },
        { path: "src/missing.ts", body: "Nope", line: 1 },
      ],
    }, new AbortController().signal, vi.fn(), ctx);

    expect(mocks.runReviewApp).toHaveBeenCalledWith(ctx, expect.objectContaining({
      seedComments: [
        { fileId: "src/app.ts::working::::", scope: "git-diff", side: "added", intent: "comment", startLine: 3, endLine: 3, body: "Handle the nil case." },
      ],
    }));
    expect(ctx.ui.notify).toHaveBeenCalledWith("code-diff: could not place 1 prepopulated comment (src/missing.ts).", "warning");
  });

  it("open_code_diff seeds prepopulated comments into the all-files scope for a custom range", async () => {
    const tools = new Map<string, any>();
    const files = [{
      id: "src/app.ts::all::base::head",
      path: "src/app.ts",
      worktreeStatus: "modified",
      hasWorkingTreeFile: true,
      inGitDiff: false,
      inLastCommit: false,
      inAllFiles: true,
      gitDiff: null,
      lastCommit: null,
      allFiles: { status: "modified", oldPath: "src/app.ts", newPath: "src/app.ts", displayPath: "src/app.ts", hasOriginal: true, hasModified: true },
    }];
    mocks.getReviewWindowDataForRevisionRange.mockResolvedValue({ repoRoot: "/repo", files, branchBaseRevision: "base", modifiedRevision: "head", visibleScopes: ["all-files"] });
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
    await tools.get("open_code_diff").execute("tool-call", {
      args: "base..head",
      comments: [{ path: "src/app.ts", body: "Range note.", line: 5 }],
    }, new AbortController().signal, vi.fn(), ctx);

    expect(mocks.getReviewWindowDataForRevisionRange).toHaveBeenCalledWith(pi, "/repo", "base", "head");
    expect(mocks.runReviewApp).toHaveBeenCalledWith(ctx, expect.objectContaining({
      seedComments: [
        { fileId: "src/app.ts::all::base::head", scope: "all-files", side: "added", intent: "comment", startLine: 5, endLine: 5, body: "Range note." },
      ],
    }));

    mocks.getReviewWindowDataForRevisionRange.mockClear();
    await tools.get("open_code_diff").execute("tool-call", { args: "base...head" }, new AbortController().signal, vi.fn(), ctx);
    expect(mocks.getReviewWindowDataForRevisionRange).toHaveBeenCalledWith(pi, "/repo", "base", "head", { mergeBase: true });
  });

  it("does not seed comments when the diff command is invoked", async () => {
    const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
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
    mocks.getReviewWindowData.mockResolvedValue({ repoRoot: "/repo", files, branchBaseRevision: null, modifiedRevision: undefined, visibleScopes: ["git-diff"] });
    mocks.runReviewApp.mockResolvedValue({ type: "submit", allComment: "", allIntent: "discuss", comments: [] });
    mocks.composeReviewPrompt.mockReturnValue("generated review prompt");
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
    await commands.get("diff")!.handler("", ctx);
    await vi.waitFor(() => expect(mocks.runReviewApp).toHaveBeenCalled());

    expect(mocks.runReviewApp).toHaveBeenCalledWith(ctx, expect.objectContaining({ seedComments: [] }));
  });

  it("expands --cwd for the diff command", async () => {
    const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
    const expandedCwd = join(homedir(), "Poetry/rpgmenace");
    const files = [{
      id: "app/admin/dashboard.rb::working::::",
      path: "app/admin/dashboard.rb",
      worktreeStatus: "modified",
      hasWorkingTreeFile: true,
      inGitDiff: true,
      inLastCommit: false,
      inAllFiles: false,
      gitDiff: { status: "modified", oldPath: "app/admin/dashboard.rb", newPath: "app/admin/dashboard.rb", displayPath: "app/admin/dashboard.rb", hasOriginal: true, hasModified: true },
      lastCommit: null,
      allFiles: null,
    }];
    mocks.getReviewWindowData.mockResolvedValue({ repoRoot: expandedCwd, files, branchBaseRevision: null, modifiedRevision: undefined, visibleScopes: ["git-diff"] });
    mocks.runReviewApp.mockResolvedValue({ type: "submit", allComment: "", allIntent: "discuss", comments: [] });
    mocks.composeReviewPrompt.mockReturnValue("generated review prompt");
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
    await commands.get("diff")!.handler("--cwd ~/Poetry/rpgmenace --include-generated --whole-repo --resume saved-session", ctx);
    await vi.waitFor(() => expect(mocks.getReviewWindowData).toHaveBeenCalledWith(pi, expandedCwd, { includeGenerated: true, wholeRepo: true }));
    expect(mocks.loadReviewSession).toHaveBeenCalledWith(`${expandedCwd}|working|worktree|local`, "saved-session");
    await vi.waitFor(() => expect(mocks.deleteReviewSession).toHaveBeenCalledWith(`${expandedCwd}|working|worktree|local`, "saved-session"));

    mocks.deleteReviewSession.mockClear();
    const discardCommands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
    const discardPi = {
      registerCommand: vi.fn((name: string, command) => discardCommands.set(name, command)),
      registerTool: vi.fn(),
      registerShortcut: vi.fn(),
      on: vi.fn(),
    };
    codeDiffExtension(discardPi as never);
    await discardCommands.get("diff")!.handler("--cwd ~/Poetry/rpgmenace --discard-resume", ctx);
    await vi.waitFor(() => expect(mocks.deleteReviewSession).toHaveBeenCalledWith(`${expandedCwd}|working|worktree|local`, "automatic-session"));
  });

  it("treats a bare existing local directory as the diff cwd", async () => {
    const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
    const localRepo = await mkdtemp(join(tmpdir(), "pi-code-diff-local-"));
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
    mocks.getReviewWindowData.mockResolvedValue({ repoRoot: localRepo, files, branchBaseRevision: null, modifiedRevision: undefined, visibleScopes: ["git-diff"] });
    mocks.runReviewApp.mockResolvedValue({ type: "submit", allComment: "", allIntent: "discuss", comments: [] });
    mocks.composeReviewPrompt.mockReturnValue("generated review prompt");
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
    await commands.get("diff")!.handler(localRepo, ctx);
    await vi.waitFor(() => expect(mocks.getReviewWindowData).toHaveBeenCalledWith(pi, localRepo));
    expect(mocks.getReviewWindowDataForRevisionRange).not.toHaveBeenCalled();
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
