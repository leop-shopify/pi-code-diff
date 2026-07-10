import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { PersistedDiffViewMode } from "./preferences.js";
import type { ReviewState } from "./types.js";

export const REVIEW_SESSION_VERSION = 1;

export interface ReviewSessionData {
  state: ReviewState;
  diffViewMode: PersistedDiffViewMode;
  navigatorTreeMode: boolean;
  contextLineNavigation: boolean;
  commentsGlobal: boolean;
  showAllLocales?: boolean;
  reviewedFileIds: string[];
  navigatorScroll: number;
  diffScroll: number;
  commentsScroll: number;
}

export interface PersistedReviewSession extends ReviewSessionData {
  version: typeof REVIEW_SESSION_VERSION;
  id: string;
  identity: string;
  updatedAt: string;
}

function getSessionsDir(): string {
  return process.env.PI_CODE_DIFF_SESSIONS_DIR ?? join(getAgentDir(), "cache", "pi-code-diff", "sessions");
}

export function createReviewSessionId(identity: string): string {
  return createHash("sha256").update(identity).digest("hex").slice(0, 20);
}

export function getReviewSessionPathForDiagnostics(id: string): string {
  return join(getSessionsDir(), `${id.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isReviewState(value: unknown): value is ReviewState {
  if (!isRecord(value) || !isRecord(value.draft)) return false;
  return typeof value.activeScope === "string"
    && (typeof value.activeFileId === "string" || value.activeFileId == null)
    && typeof value.searchQuery === "string"
    && typeof value.focus === "string"
    && typeof value.wrapLines === "boolean"
    && typeof value.hideUnchanged === "boolean"
    && typeof value.selectedCommentIndex === "number"
    && isRecord(value.selectedLineTargetByScopeFile)
    && typeof value.draft.allComment === "string"
    && typeof value.draft.allIntent === "string"
    && Array.isArray(value.draft.comments);
}

function migrateReviewSession(value: unknown, identity: string): PersistedReviewSession | null {
  if (!isRecord(value) || value.version !== REVIEW_SESSION_VERSION || value.identity !== identity) return null;
  if (!isReviewState(value.state)) return null;
  if (value.diffViewMode !== "unified" && value.diffViewMode !== "side-by-side") return null;
  if (typeof value.id !== "string" || typeof value.updatedAt !== "string") return null;
  if (typeof value.navigatorTreeMode !== "boolean" || typeof value.contextLineNavigation !== "boolean" || typeof value.commentsGlobal !== "boolean") return null;
  if (value.showAllLocales != null && typeof value.showAllLocales !== "boolean") return null;
  if (!Array.isArray(value.reviewedFileIds) || value.reviewedFileIds.some((item) => typeof item !== "string")) return null;
  if (typeof value.navigatorScroll !== "number" || typeof value.diffScroll !== "number" || typeof value.commentsScroll !== "number") return null;
  return value as unknown as PersistedReviewSession;
}

export function loadReviewSession(identity: string, id = createReviewSessionId(identity)): PersistedReviewSession | null {
  const path = getReviewSessionPathForDiagnostics(id);
  if (!existsSync(path)) return null;
  try {
    return migrateReviewSession(JSON.parse(readFileSync(path, "utf8")) as unknown, identity);
  } catch {
    return null;
  }
}

export function saveReviewSession(identity: string, data: ReviewSessionData, id = createReviewSessionId(identity)): string {
  const session: PersistedReviewSession = {
    version: REVIEW_SESSION_VERSION,
    id,
    identity,
    updatedAt: new Date().toISOString(),
    ...data,
  };
  try {
    mkdirSync(getSessionsDir(), { recursive: true });
    writeFileSync(getReviewSessionPathForDiagnostics(id), `${JSON.stringify(session, null, 2)}\n`, "utf8");
  } catch {
    return id;
  }
  return id;
}

export function deleteReviewSession(identity: string, id = createReviewSessionId(identity)): void {
  const path = getReviewSessionPathForDiagnostics(id);
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    return;
  }
}
