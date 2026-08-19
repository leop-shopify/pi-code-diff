import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadCommentShortcuts: vi.fn(),
  getReviewWindowData: vi.fn(),
  getReviewWindowDataForRevisionRange: vi.fn(),
  loadReviewFileContents: vi.fn(),
  composeReviewPrompt: vi.fn(),
  composeDiscussionPrompt: vi.fn(),
  runReviewApp: vi.fn(),
  resolveRemoteReviewTarget: vi.fn(),
  createReviewSessionId: vi.fn(() => "automatic-session"),
  loadReviewSession: vi.fn(),
  saveReviewSession: vi.fn(),
  deleteReviewSession: vi.fn(),
  listReviewSessions: vi.fn((): any[] => []),
  buildReviewFileSignatures: vi.fn((): Record<string, string> => ({})),
  rebaseReviewSession: vi.fn(),
  reviewGrammar: vi.fn(),
  submitPullRequestReview: vi.fn(),
  saveReviewReceipt: vi.fn(),
  createRemoteReviewRepliesSource: vi.fn(),
  repliesSource: { title: "Replies", loadingText: "Loading", load: vi.fn() },
}));

vi.mock("../shortcuts.js", () => ({
  loadCommentShortcuts: mocks.loadCommentShortcuts,
  getShortcutConfigPath: () => join(preferencesDir, "code-diff.json"),
}));

const preferencesDir = mkdtempSync(join(tmpdir(), "pi-code-diff-index-"));
const preferencesPath = join(preferencesDir, "code-diff-preferences.json");
const settingsPath = join(preferencesDir, "provider-settings.json");
const originalPreferencesPath = process.env.PI_CODE_DIFF_PREFERENCES_PATH;
const originalSettingsPath = process.env.PI_CODE_DIFF_SETTINGS_PATH;
process.env.PI_CODE_DIFF_PREFERENCES_PATH = preferencesPath;
process.env.PI_CODE_DIFF_SETTINGS_PATH = settingsPath;

afterAll(() => {
  if (originalPreferencesPath == null) delete process.env.PI_CODE_DIFF_PREFERENCES_PATH;
  else process.env.PI_CODE_DIFF_PREFERENCES_PATH = originalPreferencesPath;
  if (originalSettingsPath == null) delete process.env.PI_CODE_DIFF_SETTINGS_PATH;
  else process.env.PI_CODE_DIFF_SETTINGS_PATH = originalSettingsPath;
  rmSync(preferencesDir, { recursive: true, force: true });
});

vi.mock("../git.js", () => ({
  getReviewWindowData: mocks.getReviewWindowData,
  getReviewWindowDataForRevisionRange: mocks.getReviewWindowDataForRevisionRange,
  loadReviewFileContents: mocks.loadReviewFileContents,
}));

vi.mock("../prompt.js", () => ({
  composeReviewPrompt: mocks.composeReviewPrompt,
  composeDiscussionPrompt: mocks.composeDiscussionPrompt,
}));

vi.mock("../remote.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../remote.js")>()),
  resolveRemoteReviewTarget: mocks.resolveRemoteReviewTarget,
}));

vi.mock("../review-session.js", () => ({
  createReviewSessionId: mocks.createReviewSessionId,
  loadReviewSession: mocks.loadReviewSession,
  saveReviewSession: mocks.saveReviewSession,
  deleteReviewSession: mocks.deleteReviewSession,
  listReviewSessions: mocks.listReviewSessions,
  buildReviewFileSignatures: mocks.buildReviewFileSignatures,
  rebaseReviewSession: mocks.rebaseReviewSession,
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

vi.mock("../review-receipts.js", () => ({
  saveReviewReceipt: mocks.saveReviewReceipt,
}));

vi.mock("../review-replies.js", () => ({
  createRemoteReviewRepliesSource: mocks.createRemoteReviewRepliesSource,
}));

const { buildReviewEndActions, composeRemoteDiscussionPrompt, composeReviewSubmissionPrompt, mergeReviewBodies, submitUiConfirmedReview, default: codeDiffExtension } = await import("../index.js");

function testSettings() {
  const provider = (id: string, fileComments: boolean) => ({
    label: `${id} code host`,
    executable: `cli-${id}`,
    urls: {
      patterns: [{ host: `${id}.code.example`, path: "/{repo}/change/{number}" }],
      canonical: `https://${id}.code.example/{repo}/change/{number}`,
    },
    operations: { identity: { args: ["identity"] } },
    refs: {},
    fields: {},
    capabilities: { fileComments },
  });
  return {
    version: 1,
    providers: {
      github: {
        ...provider("github", false),
        urls: {
          patterns: [{ host: "github.com", path: "/{repo}/pull/{number}" }],
          canonical: "https://github.com/{repo}/pull/{number}",
        },
      },
      secondary: provider("secondary", true),
    },
    repositories: {},
  };
}

function remoteTarget() {
  return {
    provider: "github",
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

function remoteReviewFile() {
  return {
    id: "src/app.ts::all::origin/main::origin/pr/1/head",
    path: "src/app.ts",
    worktreeStatus: "modified" as const,
    hasWorkingTreeFile: true,
    inGitDiff: false,
    inLastCommit: false,
    inAllFiles: true,
    gitDiff: null,
    lastCommit: null,
    allFiles: {
      status: "modified" as const,
      oldPath: "src/app.ts",
      newPath: "src/app.ts",
      displayPath: "src/app.ts",
      hasOriginal: true,
      hasModified: true,
    },
  };
}

function reviewSessionData(
  draft: { allComment: string; allIntent: "discuss" | "comment" | "modify"; comments: any[] },
  activeFileId = remoteReviewFile().id,
  activeScope: "git-diff" | "all-files" = "all-files",
) {
  return {
    state: {
      activeScope,
      activeFileId,
      searchQuery: "",
      focus: "diff" as const,
      wrapLines: true,
      hideUnchanged: false,
      selectedCommentIndex: 0,
      selectedLineTargetByScopeFile: {},
      draft,
    },
    diffViewMode: "unified" as const,
    navigatorTreeMode: false,
    contextLineNavigation: true,
    commentsGlobal: false,
    reviewedFileIds: [],
    navigatorScroll: 0,
    diffScroll: 0,
    commentsScroll: 0,
  };
}

describe("code diff extension", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rmSync(preferencesPath, { force: true });
    writeFileSync(settingsPath, JSON.stringify(testSettings()), "utf8");
    mocks.loadReviewSession.mockReturnValue(null);
    mocks.listReviewSessions.mockReturnValue([]);
    mocks.buildReviewFileSignatures.mockReturnValue({});
    mocks.rebaseReviewSession.mockImplementation((session: any) => ({
      data: session,
      previousRevision: session.revision ?? "unknown",
      reanchored: session.state.draft.comments.length,
      needsAttention: 0,
      unanchored: 0,
    }));
    mocks.loadCommentShortcuts.mockReturnValue({
      shortcuts: [],
      globalShortcut: "alt+s",
      warnings: ["bad shortcut config"],
      path: "/tmp/code-diff.json",
    });
    mocks.composeDiscussionPrompt.mockReturnValue("");
    mocks.resolveRemoteReviewTarget.mockResolvedValue(remoteTarget());
    mocks.reviewGrammar.mockImplementation(async (_ctx, original) => ({ status: "safe", corrected: original, changes: [] }));
    mocks.submitPullRequestReview.mockResolvedValue({ ok: true, message: "https://github.com/example/widgets/pull/1\nReview comment was posted at 12:00.\n1 inline comment was added." });
    mocks.createRemoteReviewRepliesSource.mockImplementation((_pi, _ctx, target) => target?.pullRequest == null ? undefined : mocks.repliesSource);
  });

  it("builds an agent-mediated review submission prompt", () => {
    const prompt = composeReviewSubmissionPrompt({
      provider: "github",
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
    expect(mocks.saveReviewReceipt).toHaveBeenCalledWith({
      provider: "github",
      repo: "example/widgets",
      number: "1",
      url: "https://github.com/example/widgets/pull/1",
      verdict: "comment",
      headSha: "abc123",
      body: undefined,
      comments: [{ path: "src/app.ts", line: 12, side: "RIGHT", body: corrected }],
    });
    expect(pi.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("already submitted this github code host review"));
  });

  it("does not save a receipt when the provider rejects the submission", async () => {
    mocks.submitPullRequestReview.mockResolvedValue({ ok: false, blockedSelfApproval: true, message: "Refusing to approve your own pull request." });
    const pi = { sendUserMessage: vi.fn() };
    const ctx = {
      model: { id: "test-model" },
      modelRegistry: {},
      isIdle: vi.fn(() => true),
      ui: { setStatus: vi.fn(), select: vi.fn(), editor: vi.fn(), notify: vi.fn() },
    };

    const result = await submitUiConfirmedReview(pi as never, ctx as never, remoteTarget(), "approve", undefined, []);

    expect(result.submitted).not.toBe(true);
    expect(mocks.saveReviewReceipt).not.toHaveBeenCalled();
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("does not save a receipt when grammar verification falls back to the agent", async () => {
    mocks.reviewGrammar.mockResolvedValue({ status: "error", error: "model unavailable" });
    const pi = { sendUserMessage: vi.fn() };
    const ctx = {
      model: { id: "test-model" },
      modelRegistry: {},
      isIdle: vi.fn(() => true),
      ui: { setStatus: vi.fn(), select: vi.fn(), editor: vi.fn(), notify: vi.fn() },
    };

    const result = await submitUiConfirmedReview(pi as never, ctx as never, remoteTarget(), "comment", "Review body", []);

    expect(result.submitted).not.toBe(true);
    expect(mocks.submitPullRequestReview).not.toHaveBeenCalled();
    expect(mocks.saveReviewReceipt).not.toHaveBeenCalled();
    expect(pi.sendUserMessage).toHaveBeenCalledOnce();
  });

  it("does not save a receipt when the reviewer cancels an uncertain grammar change", async () => {
    mocks.reviewGrammar.mockResolvedValue({
      status: "review",
      corrected: { body: "Changed meaning", comments: [] },
      changes: [{ key: "body", original: "Original meaning", corrected: "Changed meaning", grammarOnly: false, reason: "Changes meaning." }],
    });
    const pi = { sendUserMessage: vi.fn() };
    const ctx = {
      model: { id: "test-model" },
      modelRegistry: {},
      isIdle: vi.fn(() => true),
      ui: { setStatus: vi.fn(), select: vi.fn(async () => "Cancel review submission"), editor: vi.fn(), notify: vi.fn() },
    };

    const result = await submitUiConfirmedReview(pi as never, ctx as never, remoteTarget(), "comment", "Original meaning", []);

    expect(result.message).toBe("Review submission cancelled; nothing was posted.");
    expect(mocks.submitPullRequestReview).not.toHaveBeenCalled();
    expect(mocks.saveReviewReceipt).not.toHaveBeenCalled();
  });

  it("does not save a receipt for the agent-mediated submission tool", async () => {
    const tools = new Map<string, any>();
    const pi = {
      registerCommand: vi.fn(),
      registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
      registerShortcut: vi.fn(),
      on: vi.fn(),
    };
    codeDiffExtension(pi as never);

    await tools.get("submit_pr_review").execute("tool-call", {
      repo: "example/widgets",
      prNumber: "1",
      commitId: "abc123",
      verdict: "comment",
      body: "Fallback body",
    }, new AbortController().signal, vi.fn(), { hasUI: false, ui: { notify: vi.fn() } });

    expect(mocks.submitPullRequestReview).toHaveBeenCalledOnce();
    expect(mocks.saveReviewReceipt).not.toHaveBeenCalled();
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

  it("builds a DISCUSS-only continuation contract for the agent", () => {
    const prompt = composeRemoteDiscussionPrompt(remoteTarget(), "Respond to the following review discussion items in prose only.");

    expect(prompt).toContain("Existing COMMENT and MODIFY items remain in the saved review for the PR author.");
    expect(prompt).toContain("Want me to prepopulate the findings as comments?");
    expect(prompt).toContain("Good to continue the review?");
    expect(prompt).toContain("A yes is the user's direct authorization to reopen this saved review.");
    expect(prompt).toContain('"args": "remote example/widgets#1"');
    expect(prompt).toContain('"cwd": "/repo"');
    expect(prompt).toContain("intent comment");
    expect(prompt).toContain("Do not call open_code_diff merely because this handoff mentions it.");
  });

  it("allows open_code_diff continuation only after the explicit remote discussion confirmation", () => {
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
    expect(guidelines.some((line) => /explicit yes to `Good to continue the review\?`/i.test(line))).toBe(true);
    expect(guidelines.some((line) => /handoff never authorizes reopening before the user's continuation confirmation/i.test(line))).toBe(true);
    expect(guidelines.some((line) => /Want me to prepopulate the findings as comments\?/i.test(line))).toBe(true);
    expect(guidelines.some((line) => /intent `comment`/i.test(line))).toBe(true);
  });

  it("starts a DISCUSS-only agent conversation and preserves human review items", async () => {
    const tools = new Map<string, any>();
    const file = remoteReviewFile();
    const comments = [
      {
        id: "discuss",
        fileId: file.id,
        scope: "all-files" as const,
        side: "added" as const,
        intent: "discuss" as const,
        startLine: 3,
        endLine: 3,
        body: "Why is this branch needed?",
      },
      {
        id: "comment",
        fileId: file.id,
        scope: "all-files" as const,
        side: "added" as const,
        intent: "comment" as const,
        startLine: 4,
        endLine: 4,
        body: "Human-facing comment",
      },
      {
        id: "modify",
        fileId: file.id,
        scope: "all-files" as const,
        side: "added" as const,
        intent: "modify" as const,
        startLine: 5,
        endLine: 5,
        originalText: "original()",
        body: "replacement()",
      },
    ];
    const payload = { type: "submit" as const, allComment: "Discuss this overall", allIntent: "discuss" as const, comments };
    const session = reviewSessionData({ allComment: payload.allComment, allIntent: payload.allIntent, comments: payload.comments });
    mocks.getReviewWindowDataForRevisionRange.mockResolvedValue({
      repoRoot: "/repo",
      files: [file],
      branchBaseRevision: "origin/main",
      modifiedRevision: "origin/pr/1/head",
      visibleScopes: ["all-files"],
    });
    mocks.composeDiscussionPrompt.mockReturnValue("DISCUSS ONLY\n\nWhy is this branch needed?");
    mocks.runReviewApp.mockImplementation(async (_ctx, options) => {
      options.onSessionChange(session);
      return payload;
    });
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
        select: vi.fn(async () => "Start discussion with agents"),
        editor: vi.fn(),
      },
    };

    codeDiffExtension(pi as never);
    const result = await tools.get("open_code_diff").execute(
      "tool-call",
      { args: "remote example/widgets#1" },
      new AbortController().signal,
      vi.fn(),
      ctx,
    );

    expect(ctx.ui.select).toHaveBeenCalledWith("PR #1: Add review mode", [
      "Approve",
      "Request changes",
      "Post Comments",
      "Start discussion with agents",
    ]);
    expect(mocks.composeDiscussionPrompt).toHaveBeenCalledWith([file], payload);
    expect(mocks.createReviewSessionId).toHaveBeenCalledWith("pr|github|example/widgets|1");
    const prompt = ctx.ui.setEditorText.mock.calls[0]?.[0] as string;
    expect(prompt).toContain("DISCUSS ONLY");
    expect(prompt).not.toContain("Human-facing comment");
    expect(prompt).not.toContain("replacement()");
    expect(prompt).toContain("Want me to prepopulate the findings as comments?");
    expect(prompt).toContain("Good to continue the review?");
    expect(mocks.saveReviewSession).toHaveBeenLastCalledWith(
      "pr|github|example/widgets|1",
      expect.objectContaining({
        state: expect.objectContaining({
          draft: {
            allComment: "",
            allIntent: "discuss",
            comments: [comments[1], comments[2]],
          },
        }),
      }),
      expect.objectContaining({ id: "automatic-session", revision: "abc123" }),
    );
    expect(mocks.deleteReviewSession).not.toHaveBeenCalled();
    expect(result.details.prompt).toBe(prompt);
  });

  it("posts inline and general comments together", async () => {
    type RegisteredTool = {
      name: string;
      execute: (
        toolCallId: string,
        params: Record<string, unknown>,
        signal: AbortSignal,
        onUpdate: (...args: unknown[]) => unknown,
        ctx: unknown,
      ) => Promise<unknown>;
    };
    const tools = new Map<string, RegisteredTool>();
    const file = remoteReviewFile();
    const payload = {
      type: "submit" as const,
      allComment: "Existing review-wide note",
      allIntent: "comment" as const,
      comments: [{
        id: "comment",
        fileId: file.id,
        scope: "all-files" as const,
        side: "added" as const,
        intent: "comment" as const,
        startLine: 4,
        endLine: 4,
        body: "Keep this inline comment",
      }],
    };
    mocks.getReviewWindowDataForRevisionRange.mockResolvedValue({
      repoRoot: "/repo",
      files: [file],
      branchBaseRevision: "origin/main",
      modifiedRevision: "origin/pr/1/head",
      visibleScopes: ["all-files"],
    });
    mocks.runReviewApp.mockResolvedValue(payload);
    const pi = {
      registerCommand: vi.fn(),
      registerTool: vi.fn((tool: RegisteredTool) => tools.set(tool.name, tool)),
      registerShortcut: vi.fn(),
      on: vi.fn(),
      sendUserMessage: vi.fn(),
    };
    const ctx = {
      hasUI: true,
      cwd: "/repo",
      model: { id: "test-model" },
      modelRegistry: {},
      isIdle: vi.fn(() => true),
      ui: {
        notify: vi.fn(),
        setWidget: vi.fn(),
        setEditorText: vi.fn(),
        setStatus: vi.fn(),
        select: vi.fn(async () => "Post Comments"),
        editor: vi.fn(async () => "General review comment"),
      },
    };

    codeDiffExtension(pi as never);
    const openCodeDiff = tools.get("open_code_diff");
    if (openCodeDiff == null) throw new Error("open_code_diff was not registered");
    await openCodeDiff.execute(
      "tool-call",
      { args: "remote example/widgets#1" },
      new AbortController().signal,
      vi.fn(),
      ctx,
    );

    expect(ctx.ui.select).toHaveBeenCalledWith("PR #1: Add review mode", ["Approve", "Request changes", "Post Comments"]);
    expect(ctx.ui.editor).toHaveBeenCalledWith("Post Comments: optional review body comment", "");
    expect(mocks.submitPullRequestReview).toHaveBeenCalledWith(pi, expect.objectContaining({
      verdict: "comment",
      body: "General review comment\n\nExisting review-wide note",
      comments: [{ path: "src/app.ts", line: 4, side: "RIGHT", body: "Keep this inline comment" }],
    }));
    expect(mocks.createRemoteReviewRepliesSource).toHaveBeenCalledWith(pi, ctx, expect.objectContaining({ repo: "example/widgets" }));
    expect(mocks.runReviewApp.mock.calls.at(-1)?.[1]).toEqual(expect.objectContaining({ repliesSource: mocks.repliesSource }));
    expect(mocks.saveReviewReceipt).toHaveBeenCalledWith(expect.objectContaining({
      provider: "github",
      repo: "example/widgets",
      number: "1",
      url: "https://github.com/example/widgets/pull/1",
      body: "General review comment\n\nExisting review-wide note",
      comments: [{ path: "src/app.ts", line: 4, side: "RIGHT", body: "Keep this inline comment" }],
    }));
    expect(mocks.deleteReviewSession).toHaveBeenCalled();
  });

  it("runs a configured secondary remote target through the normal confirmed review flow", async () => {
    const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
    const file = remoteReviewFile();
    const secondaryUrl = "https://secondary.code.example/example/widgets/change/42";
    mocks.resolveRemoteReviewTarget.mockResolvedValue({
      ...remoteTarget(),
      provider: "secondary",
      repo: "example/widgets",
      remote: secondaryUrl,
      pullRequest: {
        ...remoteTarget().pullRequest,
        repo: "example/widgets",
        number: "42",
        baseRefOid: "base-sha",
        headRefOid: "head-sha",
      },
    });
    mocks.getReviewWindowDataForRevisionRange.mockResolvedValue({
      repoRoot: "/repo",
      files: [file],
      branchBaseRevision: "origin/main",
      modifiedRevision: "origin/review/secondary/42/head",
      visibleScopes: ["all-files"],
    });
    mocks.runReviewApp.mockResolvedValue({
      type: "submit",
      allComment: "Overall note",
      allIntent: "comment",
      comments: [
        { id: "line", fileId: file.id, scope: "all-files", side: "added", intent: "comment", startLine: 4, endLine: 4, body: "Line note" },
        { id: "file", fileId: file.id, scope: "all-files", side: "file", intent: "comment", startLine: null, endLine: null, body: "File note" },
      ],
    });
    const pi = {
      registerCommand: vi.fn((name: string, command) => commands.set(name, command)),
      registerTool: vi.fn(),
      registerShortcut: vi.fn(),
      on: vi.fn(),
      sendUserMessage: vi.fn(),
    };
    const ctx = {
      hasUI: true,
      cwd: "/repo",
      model: { id: "test-model" },
      modelRegistry: {},
      isIdle: vi.fn(() => true),
      ui: {
        notify: vi.fn(),
        setWidget: vi.fn(),
        setEditorText: vi.fn(),
        setStatus: vi.fn(),
        select: vi.fn(async () => "Post Comments"),
        editor: vi.fn(async () => "Optional body"),
      },
    };

    codeDiffExtension(pi as never);
    await commands.get("diff")!.handler(`remote ${secondaryUrl}`, ctx);
    await vi.waitFor(() => expect(mocks.submitPullRequestReview).toHaveBeenCalled());

    expect(mocks.resolveRemoteReviewTarget).toHaveBeenCalledWith(pi, "/repo", secondaryUrl, undefined, expect.any(Function), undefined);
    expect(mocks.createReviewSessionId).toHaveBeenCalledWith("pr|secondary|example/widgets|42");
    expect(ctx.ui.select).toHaveBeenCalledWith("PR #42: Add review mode", ["Approve", "Request changes", "Post Comments"]);
    expect(mocks.submitPullRequestReview).toHaveBeenCalledWith(pi, expect.objectContaining({
      provider: "secondary",
      repo: "example/widgets",
      prNumber: "42",
      commitId: "head-sha",
      baseCommitId: "base-sha",
      verdict: "comment",
      body: "Optional body\n\nOverall note",
      comments: [
        { path: "src/app.ts", line: 4, side: "RIGHT", body: "Line note" },
        { path: "src/app.ts", subject_type: "file", body: "File note" },
      ],
    }));
    expect(mocks.createRemoteReviewRepliesSource).toHaveBeenCalledWith(pi, ctx, expect.objectContaining({ provider: "secondary", repo: "example/widgets" }));
    expect(mocks.runReviewApp.mock.calls.at(-1)?.[1]).toEqual(expect.objectContaining({ repliesSource: mocks.repliesSource }));
    expect(mocks.saveReviewReceipt).toHaveBeenCalledWith(expect.objectContaining({
      provider: "secondary",
      repo: "example/widgets",
      number: "42",
      url: secondaryUrl,
      headSha: "head-sha",
      body: "Optional body\n\nOverall note",
      comments: [
        { path: "src/app.ts", line: 4, side: "RIGHT", body: "Line note" },
        { path: "src/app.ts", line: undefined, side: undefined, body: "File note" },
      ],
    }));
  });

  it("does not offer an agent discussion when no DISCUSS items exist and keeps the draft on dismissal", async () => {
    const tools = new Map<string, any>();
    const file = remoteReviewFile();
    const payload = {
      type: "submit" as const,
      allComment: "Human review body",
      allIntent: "comment" as const,
      comments: [{
        id: "comment",
        fileId: file.id,
        scope: "all-files" as const,
        side: "added" as const,
        intent: "comment" as const,
        startLine: 4,
        endLine: 4,
        body: "Human-facing comment",
      }],
    };
    const session = reviewSessionData({ allComment: payload.allComment, allIntent: payload.allIntent, comments: payload.comments });
    mocks.getReviewWindowDataForRevisionRange.mockResolvedValue({
      repoRoot: "/repo",
      files: [file],
      branchBaseRevision: "origin/main",
      modifiedRevision: "origin/pr/1/head",
      visibleScopes: ["all-files"],
    });
    mocks.composeDiscussionPrompt.mockReturnValue("");
    mocks.runReviewApp.mockImplementation(async (_ctx, options) => {
      options.onSessionChange(session);
      return payload;
    });
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
        select: vi.fn(async () => undefined),
        editor: vi.fn(),
      },
    };

    codeDiffExtension(pi as never);
    await tools.get("open_code_diff").execute(
      "tool-call",
      { args: "remote example/widgets#1" },
      new AbortController().signal,
      vi.fn(),
      ctx,
    );

    expect(ctx.ui.select).toHaveBeenCalledWith("PR #1: Add review mode", ["Approve", "Request changes", "Post Comments"]);
    expect(ctx.ui.setEditorText).not.toHaveBeenCalled();
    expect(mocks.deleteReviewSession).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith("Review kept as a draft; nothing was submitted.", "info");
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
    mocks.runReviewApp.mockResolvedValue({ type: "submit", allComment: "Overall note", allIntent: "discuss", comments: [] });
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

  it("sends 'PR approved' to the agent when a local review is submitted empty", async () => {
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
    const pi = {
      registerCommand: vi.fn(),
      registerTool: vi.fn((tool) => tools.set(tool.name, tool)),
      registerShortcut: vi.fn(),
      on: vi.fn(),
      sendUserMessage: vi.fn(),
    };
    const ctx = {
      hasUI: true,
      cwd: "/repo",
      isIdle: () => true,
      ui: {
        notify: vi.fn(),
        setWidget: vi.fn(),
        setEditorText: vi.fn(),
      },
    };

    codeDiffExtension(pi as never);
    const result = await tools.get("open_code_diff").execute("tool-call", { args: "" }, new AbortController().signal, vi.fn(), ctx);

    const reviewOptions = mocks.runReviewApp.mock.calls.at(-1)![1];
    expect(reviewOptions.allowEmptySubmit).toBe(true);
    expect(pi.sendUserMessage).toHaveBeenCalledWith("PR approved");
    expect(mocks.composeReviewPrompt).not.toHaveBeenCalled();
    expect(ctx.ui.setEditorText).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith("Sent 'PR approved' to the agent.", "info");
    expect(result.details).toMatchObject({ started: true, prompt: "PR approved" });
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
    mocks.runReviewApp.mockResolvedValue({ type: "submit", allComment: "Overall note", allIntent: "discuss", comments: [] });
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

  it("keeps saved review items when prepopulated findings target the same location", async () => {
    const tools = new Map<string, any>();
    const file = {
      id: "src/app.ts::working::::",
      path: "src/app.ts",
      worktreeStatus: "modified" as const,
      hasWorkingTreeFile: true,
      inGitDiff: true,
      inLastCommit: false,
      inAllFiles: false,
      gitDiff: { status: "modified" as const, oldPath: "src/app.ts", newPath: "src/app.ts", displayPath: "src/app.ts", hasOriginal: true, hasModified: true },
      lastCommit: null,
      allFiles: null,
    };
    const existing = {
      id: "existing",
      fileId: file.id,
      scope: "git-diff" as const,
      side: "added" as const,
      intent: "comment" as const,
      startLine: 3,
      endLine: 3,
      body: "Keep this human comment.",
    };
    mocks.loadReviewSession.mockReturnValue({ ...reviewSessionData({ allComment: "", allIntent: "discuss", comments: [existing] }, file.id, "git-diff"), revision: "worktree", fileSignatures: {} });
    mocks.getReviewWindowData.mockResolvedValue({ repoRoot: "/repo", files: [file], branchBaseRevision: null, modifiedRevision: undefined, visibleScopes: ["git-diff"] });
    mocks.runReviewApp.mockResolvedValue({ type: "cancel" });
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
    await tools.get("open_code_diff").execute("tool-call", {
      args: "",
      comments: [
        { path: "src/app.ts", body: "Conflicting generated finding.", line: 3 },
        { path: "src/app.ts", body: "New generated finding.", line: 5 },
      ],
    }, new AbortController().signal, vi.fn(), ctx);

    expect(mocks.runReviewApp).toHaveBeenCalledWith(ctx, expect.objectContaining({
      initialSession: expect.objectContaining({ state: expect.objectContaining({ draft: expect.objectContaining({ comments: [existing] }) }) }),
      seedComments: [
        { fileId: file.id, scope: "git-diff", side: "added", intent: "comment", startLine: 5, endLine: 5, body: "New generated finding." },
      ],
    }));
    expect(ctx.ui.notify).toHaveBeenCalledWith("code-diff: kept 1 existing review item; skipped conflicting prepopulated comment.", "warning");
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
    mocks.runReviewApp.mockResolvedValue({ type: "submit", allComment: "Overall note", allIntent: "discuss", comments: [] });
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
    mocks.runReviewApp.mockResolvedValue({ type: "submit", allComment: "Overall note", allIntent: "discuss", comments: [] });
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
    mocks.runReviewApp.mockResolvedValue({ type: "submit", allComment: "Overall note", allIntent: "discuss", comments: [] });
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
    mocks.runReviewApp.mockResolvedValue({ type: "submit", allComment: "Overall note", allIntent: "discuss", comments: [] });
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

  it("forwards validated pull request metadata to the remote resolver and rejects malformed or non-remote handoffs", async () => {
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
    const pullRequest = {
      provider: "github",
      repo: "example/widgets",
      number: "1",
      url: "https://github.com/example/widgets/pull/1",
      title: "Add review mode",
      authorLogin: "alice",
      state: "OPEN",
      baseRefName: "main",
      headRefName: "feature/review",
      headRefOid: "a".repeat(40),
      additions: 1,
      deletions: 0,
      changedFiles: 1,
      queue: { position: 2, total: 4 },
    };
    mocks.resolveRemoteReviewTarget.mockResolvedValue(remoteTarget());
    mocks.getReviewWindowDataForRevisionRange.mockResolvedValue({ repoRoot: "/repo", files, branchBaseRevision: "origin/main", modifiedRevision: "origin/pr/1/head", visibleScopes: ["all-files"] });
    mocks.runReviewApp.mockResolvedValue({ type: "cancel" });
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
    const signal = new AbortController().signal;
    await tools.get("open_code_diff").execute("tool-call", {
      args: "remote https://github.com/example/widgets/pull/1",
      pullRequest,
    }, signal, vi.fn(), ctx);

    expect(mocks.resolveRemoteReviewTarget).toHaveBeenCalledWith(
      pi,
      "/repo",
      "https://github.com/example/widgets/pull/1",
      undefined,
      expect.any(Function),
      expect.objectContaining({ provider: "github", number: "1", headRefOid: "a".repeat(40), queue: { position: 2, total: 4 } }),
    );

    mocks.resolveRemoteReviewTarget.mockClear();
    const malformed = await tools.get("open_code_diff").execute("tool-call", {
      args: "remote https://github.com/example/widgets/pull/1",
      pullRequest: { ...pullRequest, headRefOid: "abc123" },
    }, signal, vi.fn(), ctx);
    expect(malformed.details).toMatchObject({ started: false, message: "Invalid pull request handoff: headRefOid must be a full commit SHA." });
    expect(mocks.resolveRemoteReviewTarget).not.toHaveBeenCalled();

    const nonRemote = await tools.get("open_code_diff").execute("tool-call", { args: "", pullRequest }, signal, vi.fn(), ctx);
    expect(nonRemote.details).toMatchObject({ started: false, message: "Supplied pull request metadata requires a remote review target, for example: remote <url>." });
    expect(mocks.resolveRemoteReviewTarget).not.toHaveBeenCalled();
  });

  function remoteReviewHarness(headRefOid: string) {
    const tools = new Map<string, any>();
    const file = remoteReviewFile();
    const target = remoteTarget();
    mocks.resolveRemoteReviewTarget.mockResolvedValue({ ...target, pullRequest: { ...target.pullRequest, headRefOid } });
    mocks.getReviewWindowDataForRevisionRange.mockResolvedValue({
      repoRoot: "/repo",
      files: [file],
      branchBaseRevision: "origin/main",
      modifiedRevision: "origin/pr/1/head",
      visibleScopes: ["all-files"],
    });
    const pi = {
      registerCommand: vi.fn(),
      registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
      registerShortcut: vi.fn(),
      on: vi.fn(),
    };
    const ctx = {
      hasUI: true,
      cwd: "/repo",
      ui: { notify: vi.fn(), setWidget: vi.fn(), setEditorText: vi.fn(), select: vi.fn(), editor: vi.fn() },
    };
    codeDiffExtension(pi as never);
    return { tools, ctx, file };
  }

  it("keeps the remote session identity stable when the head moves and re-anchors the parked draft", async () => {
    const parked = { ...reviewSessionData({ allComment: "", allIntent: "discuss", comments: [] }), revision: "abc123", fileSignatures: {}, identity: "pr|github|example/widgets|1", id: "automatic-session" };
    mocks.loadReviewSession.mockReturnValue(parked);
    mocks.buildReviewFileSignatures.mockReturnValue({ "src/app.ts": "modified:src/app.ts:1:0" });
    mocks.runReviewApp.mockResolvedValue({ type: "cancel", disposition: "park" });

    const { tools, ctx } = remoteReviewHarness("def456");
    await tools.get("open_code_diff").execute("tool-call", { args: "remote example/widgets#1" }, new AbortController().signal, vi.fn(), ctx);

    expect(mocks.createReviewSessionId).toHaveBeenCalledWith("pr|github|example/widgets|1");
    expect(mocks.rebaseReviewSession).toHaveBeenCalledWith(parked, expect.any(Array), ["all-files"], { "src/app.ts": "modified:src/app.ts:1:0" });
    expect(mocks.deleteReviewSession).not.toHaveBeenCalled();
    expect(mocks.saveReviewSession).toHaveBeenLastCalledWith(
      "pr|github|example/widgets|1",
      expect.anything(),
      expect.objectContaining({ id: "automatic-session", revision: "def456", fileSignatures: { "src/app.ts": "modified:src/app.ts:1:0" } }),
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith("Review parked. Resume with /diff remote example/widgets#1.", "info");
  });

  it("deletes the saved session only when the reviewer explicitly discards", async () => {
    mocks.runReviewApp.mockResolvedValue({ type: "cancel", disposition: "discard" });

    const { tools, ctx } = remoteReviewHarness("abc123");
    await tools.get("open_code_diff").execute("tool-call", { args: "remote example/widgets#1" }, new AbortController().signal, vi.fn(), ctx);

    expect(mocks.deleteReviewSession).toHaveBeenCalledWith("pr|github|example/widgets|1", "automatic-session");
    expect(ctx.ui.notify).toHaveBeenCalledWith("Review discarded.", "info");
  });

  it("puts the last verdict first and offers one empty-body fast path", () => {
    expect(buildReviewEndActions(null).choices).toEqual(["Approve", "Request changes", "Post Comments"]);
    expect(buildReviewEndActions("comment").choices).toEqual([
      "Post Comments",
      "Post Comments without a body",
      "Approve",
      "Request changes",
    ]);
    expect(buildReviewEndActions("approve").actions.get("Approve without a body")).toEqual({ verdict: "approve", skipBody: true });
    expect(buildReviewEndActions("approve").actions.get("Approve")).toEqual({ verdict: "approve", skipBody: false });
  });

  it("skips the body editor on the fast path and offers the queued next pull request", async () => {
    writeFileSync(preferencesPath, JSON.stringify({ lastReviewVerdict: "approve" }), "utf8");
    const tools = new Map<string, any>();
    const file = remoteReviewFile();
    mocks.resolveRemoteReviewTarget.mockImplementation(async (...args: any[]) => ({ ...remoteTarget(), handoff: args[5] }));
    mocks.getReviewWindowDataForRevisionRange.mockResolvedValue({
      repoRoot: "/repo",
      files: [file],
      branchBaseRevision: "origin/main",
      modifiedRevision: "origin/pr/1/head",
      visibleScopes: ["all-files"],
    });
    mocks.runReviewApp.mockResolvedValue({
      type: "submit",
      allComment: "Existing review-wide note",
      allIntent: "comment",
      comments: [],
    });
    let prSelectCount = 0;
    const pi = {
      registerCommand: vi.fn(),
      registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
      registerShortcut: vi.fn(),
      on: vi.fn(),
      sendUserMessage: vi.fn(),
    };
    const ctx = {
      hasUI: true,
      cwd: "/repo",
      model: { id: "test-model" },
      modelRegistry: {},
      isIdle: vi.fn(() => true),
      ui: {
        notify: vi.fn(),
        setWidget: vi.fn(),
        setEditorText: vi.fn(),
        setStatus: vi.fn(),
        select: vi.fn(async (title: string) => {
          if (title.startsWith("Next queued review")) return "Review it now";
          prSelectCount += 1;
          return prSelectCount === 1 ? "Approve without a body" : undefined;
        }),
        editor: vi.fn(),
      },
    };

    codeDiffExtension(pi as never);
    await tools.get("open_code_diff").execute("tool-call", {
      args: "remote https://github.com/example/widgets/pull/1",
      pullRequest: {
        provider: "github",
        repo: "example/widgets",
        number: "1",
        url: "https://github.com/example/widgets/pull/1",
        title: "Add review mode",
        authorLogin: "alice",
        state: "OPEN",
        baseRefName: "main",
        headRefName: "feature/review",
        headRefOid: "a".repeat(40),
        additions: 1,
        deletions: 0,
        changedFiles: 1,
        nextCandidate: { url: "https://github.com/example/widgets/pull/2", title: "Follow-up fix" },
      },
    }, new AbortController().signal, vi.fn(), ctx);

    expect(ctx.ui.select).toHaveBeenCalledWith("PR #1: Add review mode", [
      "Approve",
      "Approve without a body",
      "Request changes",
      "Post Comments",
    ]);
    expect(ctx.ui.editor).not.toHaveBeenCalled();
    expect(mocks.submitPullRequestReview).toHaveBeenCalledWith(pi, expect.objectContaining({
      verdict: "approve",
      body: "Existing review-wide note",
    }));
    expect(ctx.ui.select).toHaveBeenCalledWith("Next queued review: Follow-up fix (https://github.com/example/widgets/pull/2)", ["Review it now", "Not now"]);
    expect(mocks.resolveRemoteReviewTarget).toHaveBeenCalledWith(
      pi,
      "/repo",
      "https://github.com/example/widgets/pull/2",
      undefined,
      expect.any(Function),
      undefined,
    );
  });

  it("keeps the review result when the queued next pull request is declined", async () => {
    const tools = new Map<string, any>();
    mocks.resolveRemoteReviewTarget.mockImplementation(async (...args: any[]) => ({ ...remoteTarget(), handoff: args[5] }));
    mocks.getReviewWindowDataForRevisionRange.mockResolvedValue({
      repoRoot: "/repo",
      files: [remoteReviewFile()],
      branchBaseRevision: "origin/main",
      modifiedRevision: "origin/pr/1/head",
      visibleScopes: ["all-files"],
    });
    mocks.runReviewApp.mockResolvedValue({ type: "submit", allComment: "Looks good", allIntent: "comment", comments: [] });
    const pi = {
      registerCommand: vi.fn(),
      registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
      registerShortcut: vi.fn(),
      on: vi.fn(),
      sendUserMessage: vi.fn(),
    };
    const ctx = {
      hasUI: true,
      cwd: "/repo",
      model: { id: "test-model" },
      modelRegistry: {},
      isIdle: vi.fn(() => true),
      ui: {
        notify: vi.fn(),
        setWidget: vi.fn(),
        setEditorText: vi.fn(),
        setStatus: vi.fn(),
        select: vi.fn(async (title: string) => (title.startsWith("Next queued review") ? "Not now" : "Post Comments")),
        editor: vi.fn(async () => ""),
      },
    };

    codeDiffExtension(pi as never);
    const result: any = await tools.get("open_code_diff").execute("tool-call", {
      args: "remote https://github.com/example/widgets/pull/1",
      pullRequest: {
        provider: "github",
        repo: "example/widgets",
        number: "1",
        url: "https://github.com/example/widgets/pull/1",
        title: "Add review mode",
        authorLogin: "alice",
        state: "OPEN",
        baseRefName: "main",
        headRefName: "feature/review",
        headRefOid: "a".repeat(40),
        additions: 1,
        deletions: 0,
        changedFiles: 1,
        nextCandidate: { url: "https://github.com/example/widgets/pull/2" },
      },
    }, new AbortController().signal, vi.fn(), ctx);

    expect(mocks.submitPullRequestReview).toHaveBeenCalledTimes(1);
    expect(mocks.resolveRemoteReviewTarget).toHaveBeenCalledTimes(1);
    expect(result.details).toMatchObject({ started: true, submitted: true });
  });

  it("offers a resume picker for a bare --resume and reopens the chosen parked review", async () => {
    const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
    mocks.listReviewSessions.mockReturnValue([{
      id: "parked-session",
      identity: "pr|github|example/widgets|1",
      updatedAt: "2025-01-02T03:04:05.000Z",
      revision: "abc123",
      commentCount: 3,
      reviewedCount: 1,
      kind: "remote",
      label: "example/widgets#1 Add review mode",
      url: "https://github.com/example/widgets/pull/1",
      resumeArgs: "remote example/widgets#1",
      cwd: "/repo",
    }]);
    mocks.getReviewWindowDataForRevisionRange.mockResolvedValue({
      repoRoot: "/repo",
      files: [remoteReviewFile()],
      branchBaseRevision: "origin/main",
      modifiedRevision: "origin/pr/1/head",
      visibleScopes: ["all-files"],
    });
    mocks.runReviewApp.mockResolvedValue({ type: "cancel", disposition: "park" });
    const pi = {
      registerCommand: vi.fn((name: string, command: any) => commands.set(name, command)),
      registerTool: vi.fn(),
      registerShortcut: vi.fn(),
      on: vi.fn(),
    };
    const choice = "example/widgets#1 Add review mode · 3 comments · 1 reviewed · 2025-01-02 03:04";
    const ctx = {
      hasUI: true,
      cwd: "/repo",
      ui: { notify: vi.fn(), setWidget: vi.fn(), setEditorText: vi.fn(), select: vi.fn(async () => choice), editor: vi.fn() },
    };

    codeDiffExtension(pi as never);
    await commands.get("diff")!.handler("--resume", ctx);

    await vi.waitFor(() => expect(ctx.ui.select).toHaveBeenCalledWith("Resume a parked review", [choice]));
    await vi.waitFor(() => expect(mocks.resolveRemoteReviewTarget).toHaveBeenCalledWith(pi, "/repo", "example/widgets#1", "/repo", expect.any(Function), undefined));
    await vi.waitFor(() => expect(mocks.loadReviewSession).toHaveBeenCalledWith("pr|github|example/widgets|1", "parked-session"));
  });
});
