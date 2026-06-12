import type { CommentIntent, DiffReviewComment, ReviewFile, ReviewScope, ReviewSubmitPayload } from "./types.js";
import { formatIntentLabel } from "./types.js";

function getCommentFilePath(file: ReviewFile | undefined, scope: ReviewScope): string {
  if (file == null) return "(unknown file)";
  const comparison = scope === "git-diff" ? file.gitDiff : scope === "last-commit" ? file.lastCommit : file.allFiles;
  return comparison?.displayPath ?? file.path;
}

function formatLocation(comment: DiffReviewComment, file: ReviewFile | undefined): string {
  const filePath = getCommentFilePath(file, comment.scope);

  if (comment.side === "file" || comment.startLine == null) {
    return filePath;
  }

  const lineRange = comment.endLine != null && comment.endLine !== comment.startLine
    ? `${comment.startLine}-${comment.endLine}`
    : `${comment.startLine}`;

  if (comment.scope === "all-files") {
    return `${filePath}:${lineRange}`;
  }

  const suffix = comment.side === "deleted" ? "deleted" : "added";
  return `${filePath}:${lineRange} (${suffix})`;
}

function scopeOrder(scope: ReviewScope): number {
  switch (scope) {
    case "git-diff": return 0;
    case "last-commit": return 1;
    case "all-files": return 2;
  }
}

function sortComments(comments: DiffReviewComment[], fileMap: Map<string, ReviewFile>): DiffReviewComment[] {
  return [...comments]
    .filter((comment) => comment.body.trim().length > 0)
    .sort((a, b) => {
      const aFile = fileMap.get(a.fileId);
      const bFile = fileMap.get(b.fileId);
      const byScope = scopeOrder(a.scope) - scopeOrder(b.scope);
      if (byScope !== 0) return byScope;

      const byPath = getCommentFilePath(aFile, a.scope).localeCompare(getCommentFilePath(bFile, b.scope));
      if (byPath !== 0) return byPath;

      if (a.side !== b.side) return a.side === "file" ? -1 : 1;

      const aLine = a.startLine ?? -1;
      const bLine = b.startLine ?? -1;
      if (aLine !== bLine) return aLine - bLine;

      return a.id.localeCompare(b.id);
    });
}

interface PromptItem {
  location: string;
  body: string;
}

function commentPromptBody(comment: DiffReviewComment): string {
  const body = comment.body.trim();
  if (comment.intent === "modify" && comment.originalText != null && comment.originalText.length > 0) {
    const out = ["LINE CHANGED"];
    for (const line of comment.originalText.split(/\r?\n/)) out.push(`- ${line}`);
    for (const line of body.split(/\r?\n/)) out.push(`+ ${line}`);
    return out.join("\n");
  }
  return body;
}

interface IntentSectionContent {
  reviewWide: string | null;
  files: PromptItem[];
  lines: PromptItem[];
}

function getIntentSectionContent(files: ReviewFile[], payload: ReviewSubmitPayload, intent: CommentIntent): IntentSectionContent {
  const fileMap = new Map(files.map((file) => [file.id, file]));
  const comments = sortComments(payload.comments, fileMap).filter((comment) => comment.intent === intent);

  return {
    reviewWide: payload.allIntent === intent ? payload.allComment.trim() || null : null,
    files: comments
      .filter((comment) => comment.side === "file")
      .map((comment) => {
        const file = fileMap.get(comment.fileId);
        return {
          location: formatLocation(comment, file),
          body: commentPromptBody(comment),
        };
      }),
    lines: comments
      .filter((comment) => comment.side !== "file")
      .map((comment) => {
        const file = fileMap.get(comment.fileId);
        return {
          location: formatLocation(comment, file),
          body: commentPromptBody(comment),
        };
      }),
  };
}

function hasIntentSectionContent(section: IntentSectionContent): boolean {
  return section.reviewWide != null || section.files.length > 0 || section.lines.length > 0;
}

function pushReviewWideSection(lines: string[], body: string): void {
  lines.push("Review-wide:");
  for (const line of body.split(/\r?\n/)) lines.push(line);
}

function pushFilesSection(lines: string[], items: PromptItem[]): void {
  if (items.length === 0) return;
  lines.push("Files:");
  items.forEach((item, index) => {
    lines.push(`- ${item.location}`);
    for (const line of item.body.split(/\r?\n/)) {
      lines.push(`  ${line}`);
    }
    if (index < items.length - 1) lines.push("");
  });
}

function pushLinesSection(lines: string[], items: PromptItem[]): void {
  if (items.length === 0) return;
  lines.push("Lines:");
  items.forEach((item, index) => {
    lines.push(`${index + 1}. ${item.location}`);
    for (const line of item.body.split(/\r?\n/)) {
      lines.push(`   ${line}`);
    }
    if (index < items.length - 1) {
      lines.push("");
    }
  });
}

function pushIntentSection(lines: string[], title: string, section: IntentSectionContent): void {
  if (!hasIntentSectionContent(section)) return;
  lines.push(title);
  lines.push("");

  const blocks: string[][] = [];
  if (section.reviewWide != null) {
    const block: string[] = [];
    pushReviewWideSection(block, section.reviewWide);
    blocks.push(block);
  }
  if (section.files.length > 0) {
    const block: string[] = [];
    pushFilesSection(block, section.files);
    blocks.push(block);
  }
  if (section.lines.length > 0) {
    const block: string[] = [];
    pushLinesSection(block, section.lines);
    blocks.push(block);
  }

  blocks.forEach((block, index) => {
    lines.push(...block);
    if (index < blocks.length - 1) lines.push("");
  });
}

function joinIntentLabels(labels: string[]): string {
  if (labels.length <= 1) return labels[0] ?? "";
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`;
}

function pushMixedModeHeader(lines: string[], hasModify: boolean, hasComment: boolean, hasDiscuss: boolean): void {
  lines.push("Process the following review feedback.");
  lines.push("");
  lines.push("Rules:");
  if (hasModify) {
    lines.push("- For MODIFY items: apply the exact code change shown (LINE CHANGED old -> new) as a local edit.");
  }
  if (hasComment || hasDiscuss) {
    const labels = joinIntentLabels([hasComment ? "COMMENT" : null, hasDiscuss ? "DISCUSS" : null].filter((label): label is string => label != null));
    lines.push(`- For ${labels} items: respond only in prose. Do not edit files, write code, run write/editing tools, or make repo changes to satisfy them unless explicitly asked.`);
  }
  if (hasModify && (hasComment || hasDiscuss)) {
    lines.push("- Apply the MODIFY items; answer the other items separately in prose.");
  }
  lines.push("");
}

export function composeReviewPrompt(files: ReviewFile[], payload: ReviewSubmitPayload): string {
  const lines: string[] = [];
  const modifySection = getIntentSectionContent(files, payload, "modify");
  const commentSection = getIntentSectionContent(files, payload, "comment");
  const discussSection = getIntentSectionContent(files, payload, "discuss");
  const hasModify = hasIntentSectionContent(modifySection);
  const hasComment = hasIntentSectionContent(commentSection);
  const hasDiscuss = hasIntentSectionContent(discussSection);
  const presentCount = [hasModify, hasComment, hasDiscuss].filter(Boolean).length;

  if (presentCount <= 1) {
    if (hasModify) {
      lines.push("Apply the following proposed code changes exactly as written, as local edits.");
      lines.push("");
    } else if (hasComment) {
      lines.push("The following are review comments about the change. Respond to them in prose; only edit if a comment clearly requires it.");
      lines.push("");
    } else if (hasDiscuss) {
      lines.push("Respond to the following review discussion items in prose only.");
      lines.push("Do not edit files, write code, run write/editing tools, or make repo changes.");
      lines.push("");
    }
  } else {
    pushMixedModeHeader(lines, hasModify, hasComment, hasDiscuss);
  }

  const sections: Array<[string, ReturnType<typeof getIntentSectionContent>]> = [];
  if (hasModify) sections.push([formatIntentLabel("modify"), modifySection]);
  if (hasComment) sections.push([formatIntentLabel("comment"), commentSection]);
  if (hasDiscuss) sections.push([formatIntentLabel("discuss"), discussSection]);

  sections.forEach(([title, section], index) => {
    if (index > 0) lines.push("");
    pushIntentSection(lines, title, section);
  });

  return lines.join("\n").trim();
}
