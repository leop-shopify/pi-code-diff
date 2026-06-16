import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { getReviewWindowData, getReviewWindowDataForRevisionRange, loadReviewFileContents, type ReviewWindowData } from "./git.js";
import { composeReviewPrompt } from "./prompt.js";
import { formatPullRequestContext, resolveRemoteReviewTarget, type RemoteReviewTarget } from "./remote.js";
import { buildInlineComments, buildReviewBody, submitPullRequestReview, type ReviewInlineComment, type ReviewVerdict } from "./review-submit.js";
import { loadCommentShortcuts } from "./shortcuts.js";
import { runReviewApp } from "./ui/review-app.js";
import type { ReviewSubmitPayload } from "./types.js";

type InteractiveReviewMode = "working" | "staged" | "branch" | "custom";

interface InteractiveReviewParams {
  mode?: InteractiveReviewMode;
  ref?: string;
  resume?: string;
  tree?: string;
  branch?: string;
  project?: string;
  remote?: string;
  cwd?: string;
  includeGenerated?: boolean;
}

interface ReviewRunStatus {
  started: boolean;
  message?: string;
  prompt?: string;
  context?: string;
}

const MODE_VALUES = new Set(["working", "staged", "branch", "custom"]);

function parseInteractiveReviewArgs(args: string): InteractiveReviewParams {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const params: InteractiveReviewParams = {};

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const next = () => tokens[++index];

    if (MODE_VALUES.has(token)) {
      params.mode = token as InteractiveReviewMode;
      continue;
    }

    if (token === "--ref" || token === "--custom") params.ref = next();
    else if (token === "--resume") params.resume = next();
    else if (token === "--tree") params.tree = next();
    else if (token === "--branch") params.branch = next();
    else if (token === "--project") params.project = next();
    else if (token === "--remote") params.remote = next();
    else if (token === "--cwd") params.cwd = next();
    else if (token === "--include-generated") params.includeGenerated = true;
  }

  if (params.ref != null) params.mode = "custom";
  return params;
}

function unsupported(message: string, ctx: ExtensionContext): ReviewRunStatus {
  if (ctx.hasUI) ctx.ui.notify(message, "warning");
  return { started: false, message };
}

const REMOTE_PROGRESS_FRAMES = ["-", "\\", "|", "/"];

class RemoteProgressWidget implements Component {
  private frame = 0;
  private timer: ReturnType<typeof setInterval>;

  constructor(private tui: TUI, private theme: Theme, private message: string) {
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % REMOTE_PROGRESS_FRAMES.length;
      this.tui.requestRender?.();
    }, 120);
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const border = this.theme.fg("borderMuted", "─".repeat(safeWidth));
    const text = `${REMOTE_PROGRESS_FRAMES[this.frame]} ${this.message}`;
    return [border, truncateToWidth(this.theme.fg("muted", text), safeWidth, "…", false)];
  }

  invalidate(): void {}

  dispose(): void {
    clearInterval(this.timer);
  }
}

function setRemoteProgress(ctx: ExtensionContext, message: string | undefined): void {
  ctx.ui.setWidget("pi-code-diff-remote", message == null ? undefined : (tui, theme) => new RemoteProgressWidget(tui, theme, message));
}

export function mergeReviewBodies(...bodies: Array<string | undefined>): string | undefined {
  const parts = bodies.map((body) => body?.trim()).filter((body): body is string => body != null && body.length > 0);
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

export function composeReviewSubmissionPrompt(target: RemoteReviewTarget, verdict: ReviewVerdict, body: string | undefined, comments: ReviewInlineComment[]): string {
  const pr = target.pullRequest!;
  const args = {
    repo: target.repo,
    prNumber: pr.number,
    commitId: pr.headRefOid,
    verdict,
    prAuthorLogin: pr.authorLogin,
    cwd: target.gitRoot,
    body: body == null || body.trim().length === 0 ? undefined : body.trim(),
    comments: comments.length > 0 ? comments : undefined,
  };
  const verdictLabel = verdict === "request_changes" ? "REQUEST CHANGES" : verdict.toUpperCase();
  const prUrl = target.repo == null ? target.remote : `https://github.com/${target.repo}/pull/${pr.number}`;
  return [
    `Prepare a GitHub PR review submission for PR #${pr.number} (${target.repo ?? "this repo"}): ${pr.title}.`,
    "",
    `Verdict: ${verdictLabel}`,
    "",
    "Hard constraints:",
    "- This is not a request to review, inspect, or understand the code. The user already selected the exact review locations.",
    "- Do not read files, search the repository, run commands, run tests, inspect diffs, open plans, create todos, or enter plan mode.",
    "- Do not change path, line, side, verdict, PR number, commit id, repo, cwd, author fields, or remove existing inline comments.",
    "- Only use submit_pr_review after the user confirms the cleaned text.",
    "- Call submit_pr_review once with the full arguments below. The tool handles approval plus inline comments safely.",
    "",
    "Your job:",
    "1. Fix only grammar, spelling, capitalization, and punctuation in the review body and inline comment bodies. Do not change meaning.",
    "2. Present each changed text item using this exact style, with one separate decision per item:",
    "   Comment 1: <path>:<line-or-range> (<side>)",
    "   Original: <original text>",
    "   Fixed   : <fixed text>",
    "   Choices: Approve, Edit, Skip",
    "3. Ask for decisions using the available local confirmation/asking tooling. If the current ask tool can queue multiple questions, batch the changed text items in one ask call with one separate question per item. If batching is unavailable, ask one item at a time. Do not collapse all decisions into one combined prompt.",
    "4. For approved items, use the fixed text. For edited items, use the user's replacement text. For skipped items, remove that body/comment from the submission.",
    "5. The user's Approve choice is the confirmation to submit that item. After the last item is approved, edited, or skipped, call submit_pr_review immediately with the arguments below, replacing only body/comment text with the approved or edited text and omitting skipped items. Do not ask for a second/final submission confirmation.",
    `6. Do not approve this PR if the current GitHub user (${pr.authorLogin}) authored it; the tool refuses self-approval.`,
    `7. After submit_pr_review succeeds, reply with the PR link and the short action summary returned by the tool. PR link: ${prUrl}`,
    "",
    "submit_pr_review arguments:",
    "```json",
    JSON.stringify(args, null, 2),
    "```",
  ].join("\n");
}

export function composeRemoteReviewPrompt(target: RemoteReviewTarget, reviewPrompt: string): string {
  const lines: string[] = [];
  const restoreCall = {
    args: `remote ${target.remote}`,
    cwd: target.gitRoot,
  };

  if (target.pullRequest != null) {
    const context = formatPullRequestContext(target.pullRequest);
    lines.push("GitHub PR review feedback.");
    lines.push("");
    lines.push(context);
    if (target.repo != null) lines.push(`URL: https://github.com/${target.repo}/pull/${target.pullRequest.number}`);
    lines.push(`Head commit: ${target.pullRequest.headRefOid}`);
  } else {
    lines.push(`Remote branch review feedback for ${target.branch}.`);
  }
  lines.push("");
  lines.push("Remote review agent-only flow:");
  lines.push("- This handoff is for the agent only. Do not post comments, approve, request changes, or take any public GitHub action from this prompt.");
  lines.push("- DISCUSS items are agent-only questions. Answer them in prose; do not edit files or post to GitHub to satisfy DISCUSS items unless the user explicitly asks for a separate change.");
  lines.push("- When you are done, restore this same diff by calling open_code_diff with the original remote args and cwd:");
  lines.push("```json");
  lines.push(JSON.stringify(restoreCall, null, 2));
  lines.push("```");
  lines.push("");
  lines.push("Rules for GitHub actions:");
  lines.push("- Do not post comments, approve, or request changes until the user explicitly confirms the exact public action.");
  lines.push("- For line-specific GitHub comments, verify the path, side, line, and head commit before constructing the review request.");
  lines.push("- Deleted-side comments may need to be posted as general review body comments if exact LEFT-side mapping is uncertain.");
  lines.push("");
  lines.push(reviewPrompt);
  return lines.join("\n").trim();
}

export default function codeDiffExtension(pi: ExtensionAPI) {
  const initialShortcutConfig = loadCommentShortcuts();
  let activeReview = false;
  let reviewRunInFlight = false;

  function notifyShortcutWarnings(ctx: ExtensionContext, warnings: string[]): void {
    if (warnings.length === 0 || !ctx.hasUI) return;
    ctx.ui.notify(`code-diff config: ${warnings.join(" ")}`, "warning");
  }

  async function openReviewData(ctx: ExtensionContext, data: ReviewWindowData, remoteTarget?: RemoteReviewTarget): Promise<ReviewRunStatus> {
    if (activeReview) {
      const message = "A review session is already open.";
      ctx.ui.notify(message, "warning");
      return { started: false, message };
    }

    activeReview = true;
    try {
      const { repoRoot, files, branchBaseRevision, modifiedRevision, visibleScopes } = data;
      const shortcutConfig = loadCommentShortcuts();
      if (files.length === 0) {
        const message = "No reviewable files found for this diff.";
        ctx.ui.notify(message, "info");
        return { started: false, message };
      }

      notifyShortcutWarnings(ctx, shortcutConfig.warnings);

      if (remoteTarget?.pullRequest != null) {
        ctx.ui.notify(formatPullRequestContext(remoteTarget.pullRequest), "info");
      }

      const result = await runReviewApp(ctx, {
        files,
        repoRoot,
        loadFileContents: (file, scope) => loadReviewFileContents(pi, repoRoot, file, scope, branchBaseRevision, modifiedRevision),
        commentShortcuts: shortcutConfig.shortcuts,
        allowEmptySubmit: remoteTarget?.pullRequest != null,
        visibleScopes,
      });

      if (result.type === "cancel") {
        const message = "Review cancelled.";
        ctx.ui.notify(message, "info");
        return { started: true, message };
      }

      if (remoteTarget?.pullRequest != null) {
        return finishRemotePrReview(ctx, files, result, remoteTarget);
      }

      const reviewPrompt = composeReviewPrompt(files, result);
      const prompt = remoteTarget == null ? reviewPrompt : composeRemoteReviewPrompt(remoteTarget, reviewPrompt);
      ctx.ui.setEditorText(prompt);
      ctx.ui.notify("Inserted review feedback into the editor.", "info");
      return { started: true, prompt };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Could not open review UI: ${message}`, "error");
      return { started: false, message };
    } finally {
      activeReview = false;
    }
  }

  async function finishRemotePrReview(ctx: ExtensionContext, files: Parameters<typeof composeReviewPrompt>[0], result: ReviewSubmitPayload, target: RemoteReviewTarget): Promise<ReviewRunStatus> {
    const pr = target.pullRequest!;
    const inlineComments = buildInlineComments(files, result.comments);
    const localPrompt = composeRemoteReviewPrompt(target, composeReviewPrompt(files, result));

    const approveChoice = "Approve";
    const requestChoice = "Request changes";
    const commentChoice = "Comment";
    const agentChoice = "Send feedback to the agent (no GitHub post)";
    const choice = await ctx.ui.select(`PR #${pr.number}: ${pr.title}`, [approveChoice, requestChoice, commentChoice, agentChoice]);
    if (choice == null) {
      ctx.ui.notify("Review kept as a draft; nothing was submitted.", "info");
      return { started: true, message: "No end action selected." };
    }

    if (choice === agentChoice) {
      ctx.ui.setEditorText(localPrompt);
      ctx.ui.notify("Inserted review feedback into the editor.", "info");
      return { started: true, prompt: localPrompt };
    }

    const verdict: ReviewVerdict = choice === approveChoice ? "approve" : choice === requestChoice ? "request_changes" : "comment";
    const reviewBody = buildReviewBody(files, result);
    const optionalBody = verdict === "comment" ? undefined : await ctx.ui.editor(`${choice}: optional review body comment`, "");
    const body = mergeReviewBodies(optionalBody, reviewBody);
    const prompt = composeReviewSubmissionPrompt(target, verdict, body, inlineComments);
    pi.sendUserMessage(prompt);
    ctx.ui.notify("Sent review submission instructions to the agent.", "info");
    return { started: true, prompt, context: formatPullRequestContext(pr) };
  }

  async function openReview(ctx: ExtensionContext, cwd = ctx.cwd): Promise<ReviewRunStatus> {
    return openReviewData(ctx, await getReviewWindowData(pi, cwd));
  }

  async function runInteractiveReview(params: InteractiveReviewParams, ctx: ExtensionContext, fallbackCwd = ctx.cwd): Promise<ReviewRunStatus> {
    if (!ctx.hasUI) return { started: false, message: "Interactive review requires a TUI session." };
    if (params.resume != null) return unsupported("Resume support is being ported into pi-code-diff next.", ctx);
    if (params.tree != null || params.branch != null || params.project != null) return unsupported("Tree, branch, and project resolution are being ported into pi-code-diff next.", ctx);
    if (params.mode === "staged") return unsupported("Staged diff mode is being ported into pi-code-diff next.", ctx);

    if (params.remote != null) {
      try {
        const reportProgress = (message: string) => setRemoteProgress(ctx, message);
        const target = await resolveRemoteReviewTarget(pi, fallbackCwd, params.remote, params.cwd, reportProgress);
        reportProgress(`Preparing diff for ${target.repo ?? target.branch}…`);
        const data = await getReviewWindowDataForRevisionRange(pi, target.gitRoot, target.baseRef, target.headRef);
        setRemoteProgress(ctx, undefined);
        return openReviewData(ctx, data, target);
      } catch (error) {
        setRemoteProgress(ctx, undefined);
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Could not prepare remote review: ${message}`, "error");
        return { started: false, message };
      }
    }

    if (params.mode === "custom") {
      const range = params.ref;
      if (range == null || !range.includes("..")) return unsupported("Custom review requires a ref range like base..head.", ctx);
      const [baseRef, headRef] = range.split(/\.\.\.?/, 2);
      if (baseRef == null || headRef == null || baseRef.length === 0 || headRef.length === 0) return unsupported("Custom review requires a ref range like base..head.", ctx);
      return openReviewData(ctx, await getReviewWindowDataForRevisionRange(pi, params.cwd ?? fallbackCwd, baseRef, headRef));
    }

    return openReview(ctx, params.cwd ?? fallbackCwd);
  }

  async function runDiff(args: string, ctx: ExtensionContext, cwd = ctx.cwd): Promise<ReviewRunStatus> {
    if (!ctx.hasUI) return { started: false, message: "Interactive review requires a TUI session." };

    const trimmed = args.trim();
    if (trimmed.length === 0) return openReview(ctx, cwd);

    const tokens = trimmed.split(/\s+/);
    const firstToken = tokens[0]!;

    if (firstToken.toLowerCase() === "remote") {
      const target = trimmed.slice(firstToken.length).trim();
      if (target.length === 0) return unsupported("Usage: /diff remote <url | branch>", ctx);
      return runInteractiveReview({ remote: target }, ctx, cwd);
    }

    if (trimmed.startsWith("-") || MODE_VALUES.has(firstToken)) {
      return runInteractiveReview(parseInteractiveReviewArgs(trimmed), ctx, cwd);
    }
    if (trimmed.includes("..")) {
      return runInteractiveReview({ mode: "custom", ref: trimmed }, ctx, cwd);
    }
    return runInteractiveReview({ remote: trimmed }, ctx, cwd);
  }

  function formatOpenCodeDiffToolText(status: ReviewRunStatus, args: string, cwd: string): string {
    const displayArgs = args.trim().length === 0 ? "(empty — local working-tree/uncommitted changes)" : args.trim();
    const lines = [
      status.started ? "Code diff review finished." : "Code diff review did not start.",
      `Args: ${displayArgs}`,
      `Cwd: ${cwd}`,
    ];
    if (status.message != null) lines.push(`Message: ${status.message}`);
    if (status.context != null) lines.push("", "Context:", status.context);
    if (status.prompt != null) lines.push("", "Prompt:", status.prompt);
    return lines.join("\n");
  }

  function startDiff(args: string, ctx: ExtensionContext): ReviewRunStatus {
    if (reviewRunInFlight || activeReview) {
      const message = "A review session is already open.";
      ctx.ui.notify(message, "warning");
      return { started: false, message };
    }

    reviewRunInFlight = true;
    void runDiff(args, ctx).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Could not start review: ${message}`, "error");
    }).finally(() => {
      reviewRunInFlight = false;
    });

    return { started: true, message: "Review is starting." };
  }

  const reviewCommand = {
    description: "Review and annotate code changes. /diff (local), /diff remote <url | branch>, or /diff base..head",
    handler: async (args: string, ctx: ExtensionContext) => {
      startDiff(args, ctx);
    },
  };

  pi.registerCommand("code", reviewCommand);
  pi.registerCommand("code-diff", reviewCommand);
  pi.registerCommand("diff", reviewCommand);

  pi.registerTool({
    name: "open_code_diff",
    label: "open-code-diff",
    description: "Open the pi-code-diff interactive review UI with the same target syntax as /diff. Empty args review local working-tree/uncommitted changes.",
    promptSnippet: "Open the interactive code diff review UI. Use empty args for local working-tree/uncommitted changes; do not ask the user to commit first.",
    promptGuidelines: [
      "Call open_code_diff when the user asks to open /diff, review current changes, review a remote branch/PR, or restore/reopen a diff.",
      "Pass args exactly as you would after /diff: empty for local working-tree/uncommitted changes, remote <url | branch> for remote reviews, or base..head/base...head for custom ranges.",
      "Do not ask the user to commit before review; empty args reviews uncommitted working-tree changes, including untracked files.",
      "Pass cwd when you know the checkout/repository directory. Otherwise the current Pi cwd is used.",
      "Wait for the tool result. It returns message, prompt, and context details after the interactive UI finishes.",
      "For agent-only remote DISCUSS follow-ups, answer in prose and then call open_code_diff again with the original remote args and cwd when the prompt asks you to restore the diff.",
    ],
    parameters: Type.Object({
      args: Type.Optional(Type.String({ description: "Same target syntax as /diff, for example empty string, 'remote <url | branch>', or 'base..head'." })),
      cwd: Type.Optional(Type.String({ description: "Directory to run the review from. Defaults to Pi's current cwd." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const input = params as { args?: string; cwd?: string };
      const args = input.args ?? "";
      const cwd = input.cwd ?? ctx.cwd;

      if (reviewRunInFlight || activeReview) {
        const message = "A review session is already open.";
        if (ctx.hasUI) ctx.ui.notify(message, "warning");
        const status: ReviewRunStatus = { started: false, message };
        return {
          content: [{ type: "text" as const, text: formatOpenCodeDiffToolText(status, args, cwd) }],
          details: { ...status, args, cwd },
        };
      }

      reviewRunInFlight = true;
      try {
        const status = await runDiff(args, ctx, cwd);
        return {
          content: [{ type: "text" as const, text: formatOpenCodeDiffToolText(status, args, cwd) }],
          details: { ...status, args, cwd },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (ctx.hasUI) ctx.ui.notify(`Could not start review: ${message}`, "error");
        const status: ReviewRunStatus = { started: false, message };
        return {
          content: [{ type: "text" as const, text: formatOpenCodeDiffToolText(status, args, cwd) }],
          details: { ...status, args, cwd },
        };
      } finally {
        reviewRunInFlight = false;
      }
    },
  });

  pi.registerTool({
    name: "submit_pr_review",
    label: "submit-pr-review",
    description: "Submit a GitHub pull request review (approve, request changes, or comment) via gh api. Refuses to approve a PR authored by the current user. Approvals with inline comments post the comments first, then approve.",
    promptSnippet: "Submit a GitHub PR review verdict via gh api after the user confirms.",
    promptGuidelines: [
      "Only call submit_pr_review after the user explicitly confirms the exact verdict and text.",
      "Fix only grammar and English in the body and comment text; never change their meaning.",
      "Never approve a pull request the user authored; the tool blocks self-approval and you should not retry as approve.",
      "Keep existing inline comments in the comments array for approve, request_changes, and comment verdicts.",
      "After a successful submission, report the PR link and short summary returned by the tool.",
      "Pass repo as owner/repo, the prNumber, the commitId (PR head SHA), and prAuthorLogin so self-approval can be blocked.",
      "Pass cwd to the local checkout of the repository so gh runs in the right place.",
    ],
    parameters: Type.Object({
      repo: Type.String({ description: "Repository as owner/repo" }),
      prNumber: Type.String({ description: "Pull request number" }),
      commitId: Type.String({ description: "PR head commit SHA (headRefOid)" }),
      verdict: Type.Union([
        Type.Literal("approve"),
        Type.Literal("request_changes"),
        Type.Literal("comment"),
      ], { description: "Review verdict" }),
      body: Type.Optional(Type.String({ description: "Overall review body text" })),
      comments: Type.Optional(Type.Array(Type.Object({
        path: Type.String(),
        line: Type.Number(),
        side: Type.Union([Type.Literal("LEFT"), Type.Literal("RIGHT")]),
        body: Type.String(),
        start_line: Type.Optional(Type.Number()),
        start_side: Type.Optional(Type.Union([Type.Literal("LEFT"), Type.Literal("RIGHT")])),
      }), { description: "Inline review comments mirroring GitHub (path, line, side, body)" })),
      prAuthorLogin: Type.Optional(Type.String({ description: "PR author login, used to block self-approval" })),
      cwd: Type.Optional(Type.String({ description: "Local checkout directory to run gh in" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const input = params as {
        repo: string;
        prNumber: string;
        commitId: string;
        verdict: ReviewVerdict;
        body?: string;
        comments?: ReviewInlineComment[];
        prAuthorLogin?: string;
        cwd?: string;
      };
      const result = await submitPullRequestReview(pi, {
        repo: input.repo,
        prNumber: input.prNumber,
        commitId: input.commitId,
        verdict: input.verdict,
        body: input.body,
        comments: input.comments,
        prAuthorLogin: input.prAuthorLogin,
        gitRoot: input.cwd,
      });
      if (ctx.hasUI) ctx.ui.notify(result.message, result.ok ? "info" : "warning");
      return {
        content: [{ type: "text" as const, text: result.message }],
        details: { result },
      };
    },
  });

  pi.registerShortcut(initialShortcutConfig.globalShortcut, {
    description: "Open review UI",
    handler: async (ctx) => {
      await openReview(ctx);
    },
  });

  pi.on("session_start", async (event, ctx) => {
    if (event.reason === "startup" || event.reason === "reload") {
      notifyShortcutWarnings(ctx, initialShortcutConfig.warnings);
    }
  });

  pi.on("session_shutdown", async () => {
    activeReview = false;
  });
}
