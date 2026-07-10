import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ReviewContextPanelSource } from "./types.js";
import type { RemoteReviewTarget } from "./remote.js";

interface PullRequestAuthor {
  login?: string;
}

interface PullRequestComment {
  author?: PullRequestAuthor;
  body?: string;
  createdAt?: string;
  submittedAt?: string;
  state?: string;
  url?: string;
  path?: string;
  line?: number | null;
}

interface PullRequestThread {
  path?: string;
  line?: number | null;
  isResolved?: boolean;
  isOutdated?: boolean;
  comments?: PullRequestComment[];
}

interface PullRequestCheck {
  name?: string;
  workflowName?: string;
  status?: string;
  conclusion?: string;
}

interface PullRequestDetails {
  url?: string;
  isDraft?: boolean;
  mergeStateStatus?: string;
  reviewDecision?: string;
  comments?: PullRequestComment[];
  reviews?: PullRequestComment[];
  openReviewThreads?: PullRequestThread[];
  statusCheckRollup?: PullRequestCheck[];
  createdAt?: string;
  updatedAt?: string;
}

interface StatusSummary {
  status: "pending" | "blocked" | "approved";
  reason: string;
}

const SUMMARY_LABELS = new Set(["Title", "URL", "Author", "Diff", "Status", "Problem", "Changes", "Validation", "Open comments", "Stack"]);

const OPEN_REVIEW_THREADS_QUERY = `
query PullRequestOpenThreads($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 50) {
        nodes {
          isResolved
          isOutdated
          path
          line
          comments(first: 20) {
            nodes {
              author { login }
              body
              createdAt
              url
              path
              line
            }
          }
        }
      }
    }
  }
}`;

function ghArgs(args: string[], repo: string | undefined): string[] {
  return repo == null ? args : [...args, "--repo", repo];
}

function normalizePlainText(value: string): string {
  return value
    .replace(/\\+x0a/gi, "\n")
    .replace(/\\+u000a/gi, "\n")
    .replace(/&#10;/g, "\n")
    .replace(/\\+n/g, "\n")
    .replace(/[–—]/g, "-")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[^\x09\x0a\x0d\x20-\x7e]/g, " ");
}

function stripMarkup(value: string): string {
  return normalizePlainText(value)
    .replace(/<!--[^]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function compact(value: string | undefined, maxLength: number): string {
  const clean = stripMarkup(value ?? "");
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function latestSubstantiveItems(items: PullRequestComment[] | undefined, limit: number): PullRequestComment[] {
  return [...(items ?? [])]
    .filter((item) => stripMarkup(item.body ?? "").length > 0 || item.state != null)
    .sort((a, b) => String(b.submittedAt ?? b.createdAt ?? "").localeCompare(String(a.submittedAt ?? a.createdAt ?? "")))
    .slice(0, limit);
}

function openReviewThreads(details: PullRequestDetails, limit: number): PullRequestThread[] {
  return [...(details.openReviewThreads ?? [])]
    .filter((thread) => thread.isResolved !== true && thread.isOutdated !== true)
    .filter((thread) => latestSubstantiveItems(thread.comments, 1).length > 0)
    .sort((a, b) => {
      const aLatest = latestSubstantiveItems(a.comments, 1)[0];
      const bLatest = latestSubstantiveItems(b.comments, 1)[0];
      return String(bLatest?.createdAt ?? "").localeCompare(String(aLatest?.createdAt ?? ""));
    })
    .slice(0, limit);
}

function latestThreadComment(thread: PullRequestThread): PullRequestComment | undefined {
  return latestSubstantiveItems(thread.comments, 1)[0];
}

function formatThreadLocation(thread: PullRequestThread, comment?: PullRequestComment): string {
  const path = comment?.path ?? thread.path;
  const line = comment?.line ?? thread.line;
  if (path == null || path.length === 0) return "PR";
  return line == null ? path : `${path}:${line}`;
}

function formatThreadSummary(thread: PullRequestThread, maxLength: number): string {
  const comment = latestThreadComment(thread);
  const author = comment?.author?.login ?? "unknown";
  return `${author} at ${formatThreadLocation(thread, comment)}: ${compact(comment?.body, maxLength)}`;
}

function hasChangesRequested(details: PullRequestDetails): boolean {
  return latestSubstantiveItems(details.reviews, 20).some((review) => review.state === "CHANGES_REQUESTED");
}

function checkName(check: PullRequestCheck): string {
  return check.name ?? check.workflowName ?? "check";
}

function failingChecks(details: PullRequestDetails): PullRequestCheck[] {
  const failing = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
  return (details.statusCheckRollup ?? []).filter((check) => failing.has(String(check.conclusion ?? "").toUpperCase()));
}

function pendingChecks(details: PullRequestDetails): PullRequestCheck[] {
  return (details.statusCheckRollup ?? []).filter((check) => {
    const status = String(check.status ?? "").toUpperCase();
    const conclusion = String(check.conclusion ?? "").toUpperCase();
    return status.length > 0 && status !== "COMPLETED" && conclusion.length === 0;
  });
}

function hasStackBlocker(details: PullRequestDetails): boolean {
  return latestSubstantiveItems(details.comments, 20).some((comment) => {
    const body = stripMarkup(comment.body ?? "").toLowerCase();
    return body.includes("not mergeable") || body.includes("downstack") || body.includes("blocked");
  });
}

function deriveStatus(details: PullRequestDetails): StatusSummary {
  if (details.isDraft) return { status: "blocked", reason: "draft PR" };
  if (hasChangesRequested(details)) return { status: "blocked", reason: "changes requested" };

  const failed = failingChecks(details);
  if (failed.length > 0) return { status: "blocked", reason: `${failed.length} failing check${failed.length === 1 ? "" : "s"}` };

  if (openReviewThreads(details, 1).length > 0) return { status: "pending", reason: "open review comments" };
  if (hasStackBlocker(details)) return { status: "blocked", reason: "stack or merge blocker called out in comments" };

  const mergeState = String(details.mergeStateStatus ?? "").toUpperCase();
  if (["BLOCKED", "DIRTY", "UNKNOWN", "UNSTABLE"].includes(mergeState)) return { status: "blocked", reason: `merge state ${mergeState.toLowerCase()}` };

  if (String(details.reviewDecision ?? "").toUpperCase() === "APPROVED") return { status: "approved", reason: "review decision approved" };

  const pending = pendingChecks(details);
  if (pending.length > 0) return { status: "pending", reason: `${pending.length} pending check${pending.length === 1 ? "" : "s"}` };

  return { status: "pending", reason: "waiting for review" };
}

function extractBodySignal(body: string): string {
  const lines = stripMarkup(body)
    .split(/\r?\n/)
    .map((line) => line.replace(/^#+\s*/, "").replace(/^[-*]\s*/, "").trim())
    .filter((line) => line.length > 0 && !/^\|/.test(line));
  return lines.slice(0, 4).join(" ");
}

function formatChecks(details: PullRequestDetails): string {
  const failed = failingChecks(details).slice(0, 4).map(checkName);
  if (failed.length > 0) return `Failing: ${failed.join(", ")}`;
  const pending = pendingChecks(details).slice(0, 4).map(checkName);
  if (pending.length > 0) return `Pending: ${pending.join(", ")}`;
  return "No failing checks found.";
}

function formatReadableSummary(value: string): string {
  const lines = stripMarkup(value)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 20);
  const readable: string[] = [];

  for (const line of lines) {
    const match = line.match(/^([A-Za-z][A-Za-z ]{1,32}):\s*(.*)$/);
    if (match != null && SUMMARY_LABELS.has(match[1]!)) {
      if (readable.length > 0) readable.push("");
      readable.push(`${match[1]}:`);
      if (match[2]!.trim().length > 0) readable.push(match[2]!.trim());
    } else {
      readable.push(line);
    }
  }

  return readable.join("\n").trim();
}

function replaceSummaryField(summary: string, label: string, value: string): string {
  const field = `${label}:`;
  const lines = summary.split("\n");
  const index = lines.findIndex((line) => line.trim() === field);
  if (index < 0) return `${field}\n${value}\n\n${summary}`.trim();

  let end = index + 1;
  while (end < lines.length && lines[end]!.trim().length === 0) end += 1;
  if (end < lines.length) lines[end] = value;
  else lines.push(value);
  return lines.join("\n").trim();
}

function formatDiffStats(target: RemoteReviewTarget): string {
  const pr = target.pullRequest!;
  const fileLabel = pr.changedFiles === 1 ? "file" : "files";
  return `${pr.changedFiles} ${fileLabel} touched | +${pr.additions}/-${pr.deletions}`;
}

function enforceIdentityFields(summary: string, target: RemoteReviewTarget, details: PullRequestDetails): string {
  const pr = target.pullRequest!;
  const url = details.url ?? (target.repo == null ? target.remote : `https://github.com/${target.repo}/pull/${pr.number}`);
  return [
    ["Diff", formatDiffStats(target)],
    ["Author", pr.authorLogin],
    ["URL", url],
    ["Title", pr.title],
  ].reduce((current, [label, value]) => replaceSummaryField(current, label, value), summary);
}

function fallbackSummary(target: RemoteReviewTarget, details: PullRequestDetails): string {
  const pr = target.pullRequest!;
  const status = deriveStatus(details);
  const threads = openReviewThreads(details, 4).map((thread) => formatThreadSummary(thread, 180));
  const reviews = latestSubstantiveItems(details.reviews, 3)
    .map((review) => `${review.author?.login ?? "unknown"} ${String(review.state ?? "commented").toLowerCase().replace(/_/g, " ")}${stripMarkup(review.body ?? "").length > 0 ? `: ${compact(review.body, 120)}` : ""}`);
  const comments = latestSubstantiveItems(details.comments, 3)
    .map((comment) => `${comment.author?.login ?? "unknown"}: ${compact(comment.body, 160)}`);
  const bodySignal = extractBodySignal(pr.body);

  return [
    `Title: ${pr.title}`,
    `URL: ${details.url ?? (target.repo == null ? target.remote : `https://github.com/${target.repo}/pull/${pr.number}`)}`,
    `Author: ${pr.authorLogin}`,
    `Diff: ${formatDiffStats(target)}`,
    `Status: ${status.status} - ${status.reason}`,
    `Problem: ${bodySignal || "PR body did not include a clear problem statement."}`,
    "Changes: Not summarized by the model; read the diff for implementation details.",
    `Validation: ${formatChecks(details)}`,
    `Open comments: ${threads.length > 0 ? threads.join("; ") : reviews.length > 0 ? reviews.join("; ") : comments.length > 0 ? comments.join("; ") : "None found."}`,
    pr.stackParent != null ? `Stack: parent #${pr.stackParent.number} ${pr.stackParent.title}` : undefined,
  ].filter((line): line is string => line != null).join("\n");
}

function formatSummaryInput(target: RemoteReviewTarget, details: PullRequestDetails): string {
  const pr = target.pullRequest!;
  const status = deriveStatus(details);
  const reviews = latestSubstantiveItems(details.reviews, 8)
    .map((review) => `- ${review.author?.login ?? "unknown"} ${String(review.state ?? "commented").toLowerCase().replace(/_/g, " ")}: ${compact(review.body, 350) || "no body"}`)
    .join("\n");
  const comments = latestSubstantiveItems(details.comments, 10)
    .map((comment) => `- ${comment.author?.login ?? "unknown"}: ${compact(comment.body, 450)}`)
    .join("\n");
  const openThreads = openReviewThreads(details, 10)
    .map((thread) => `- ${formatThreadSummary(thread, 450)}`)
    .join("\n");

  return [
    `Title: ${pr.title}`,
    `URL: ${details.url ?? (target.repo == null ? "" : `https://github.com/${target.repo}/pull/${pr.number}`)}`,
    `Author: ${pr.authorLogin}`,
    `Diff: ${formatDiffStats(target)}`,
    `State: ${pr.state}`,
    `Computed status: ${status.status} - ${status.reason}`,
    `Review decision: ${details.reviewDecision ?? "unknown"}`,
    `Merge state: ${details.mergeStateStatus ?? "unknown"}`,
    `Checks: ${formatChecks(details)}`,
    pr.stackParent != null ? `Stack parent: #${pr.stackParent.number} ${pr.stackParent.title}` : `Base branch: ${pr.baseRefName}`,
    "",
    "PR body:",
    compact(pr.body, 6000) || "No body.",
    "",
    "Open review comments:",
    openThreads || "No unresolved review threads found.",
    "",
    "Reviews:",
    reviews || "No review bodies found.",
    "",
    "PR conversation comments:",
    comments || "No PR conversation comments found.",
  ].join("\n");
}

async function fetchOpenReviewThreads(pi: ExtensionAPI, target: RemoteReviewTarget): Promise<PullRequestThread[]> {
  const repo = target.repo;
  const pr = target.pullRequest;
  if (repo == null || pr == null) return [];

  const [owner, name] = repo.split("/");
  const number = Number.parseInt(pr.number, 10);
  if (owner == null || name == null || !Number.isFinite(number)) return [];

  const result = await pi.exec("gh", [
    "api",
    "graphql",
    "-f",
    `owner=${owner}`,
    "-f",
    `name=${name}`,
    "-F",
    `number=${number}`,
    "-f",
    `query=${OPEN_REVIEW_THREADS_QUERY}`,
  ], { cwd: target.gitRoot, timeout: 45000 });
  if (result.code !== 0 || result.stdout.trim().length === 0) return [];

  const parsed = JSON.parse(result.stdout.trim()) as {
    data?: {
      repository?: {
        pullRequest?: {
          reviewThreads?: {
            nodes?: Array<{
              isResolved?: boolean;
              isOutdated?: boolean;
              path?: string;
              line?: number | null;
              comments?: {
                nodes?: PullRequestComment[];
              };
            }>;
          };
        };
      };
    };
  };

  return (parsed.data?.repository?.pullRequest?.reviewThreads?.nodes ?? []).map((thread) => ({
    isResolved: thread.isResolved,
    isOutdated: thread.isOutdated,
    path: thread.path,
    line: thread.line,
    comments: thread.comments?.nodes ?? [],
  }));
}

async function fetchPullRequestDetails(pi: ExtensionAPI, target: RemoteReviewTarget): Promise<PullRequestDetails> {
  const pr = target.pullRequest!;
  const fields = "url,isDraft,mergeStateStatus,reviewDecision,statusCheckRollup,comments,reviews,createdAt,updatedAt";
  const result = await pi.exec("gh", ghArgs(["pr", "view", pr.number, "--json", fields], target.repo), { cwd: target.gitRoot, timeout: 45000 });
  if (result.code !== 0 || result.stdout.trim().length === 0) {
    throw new Error(result.stderr || result.stdout || `Could not fetch PR #${pr.number} context.`);
  }

  const details = JSON.parse(result.stdout.trim()) as PullRequestDetails;
  try {
    details.openReviewThreads = await fetchOpenReviewThreads(pi, target);
  } catch {
    details.openReviewThreads = [];
  }
  return details;
}

function buildAgentPrompt(summaryInput: string): string {
  return [
    "Summarize this GitHub PR for a reviewer already looking at the diff.",
    "Output plain text only, no markdown table, no preamble, no emoji, ASCII only.",
    "Do not mention these instructions or use phrases like 'what matters most'.",
    "The reviewer needs only the important context, focused on the problem this PR solves.",
    "Keep implementation details short unless they explain reviewer risk or the problem.",
    "Required labels: Title, URL, Author, Diff, Status, Problem, Changes, Validation, Open comments. Add Stack only if relevant.",
    "Title, URL, Author, and Diff must exactly match the input values.",
    "Problem must explain the user, merchant, developer, or system pain being solved in one or two sentences.",
    "Open comments must summarize unresolved review threads only. If none exist, write None found.",
    "Use PR comments and reviews only when they affect review readiness, validation, blockers, or unresolved questions.",
    "Put each label on its own line with the value on the following line.",
    "Status must be exactly one of pending, blocked, approved, followed by a short reason using an ASCII hyphen separator.",
    "Use readable section blocks separated by blank lines, not one dense paragraph.",
    "Limit the whole response to roughly 180 words.",
    "",
    summaryInput,
  ].join("\n");
}

function cleanAgentOutput(value: string): string {
  return formatReadableSummary(value);
}

function modelArgs(ctx: ExtensionContext): string[] {
  const model = (ctx as { model?: { provider?: string; id?: string } }).model;
  if (model?.provider == null || model.id == null) return [];
  return ["--model", `${model.provider}/${model.id}`];
}

async function summarizeWithAgent(pi: ExtensionAPI, ctx: ExtensionContext, target: RemoteReviewTarget, summaryInput: string): Promise<string | undefined> {
  const prompt = buildAgentPrompt(summaryInput);
  const result = await pi.exec("pi", [
    "--no-tools",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--no-session",
    ...modelArgs(ctx),
    "--thinking",
    "minimal",
    "-p",
    prompt,
  ], { cwd: target.gitRoot, timeout: 90000 });
  if (result.code !== 0 || result.stdout.trim().length === 0) return undefined;
  return cleanAgentOutput(result.stdout);
}

async function loadRemotePullRequestSummary(pi: ExtensionAPI, ctx: ExtensionContext, target: RemoteReviewTarget): Promise<string> {
  const details = await fetchPullRequestDetails(pi, target);
  const fallback = fallbackSummary(target, details);
  try {
    return enforceIdentityFields(formatReadableSummary(await summarizeWithAgent(pi, ctx, target, formatSummaryInput(target, details)) ?? fallback), target, details);
  } catch {
    return enforceIdentityFields(formatReadableSummary(fallback), target, details);
  }
}

export function createRemotePullRequestSummarySource(pi: ExtensionAPI, ctx: ExtensionContext, target: RemoteReviewTarget | undefined): ReviewContextPanelSource | undefined {
  if (target?.pullRequest == null) return undefined;
  return {
    title: "PR context",
    loadingText: "Loading PR context...",
    load: () => loadRemotePullRequestSummary(pi, ctx, target),
  };
}
