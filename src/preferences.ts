import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getShortcutConfigPath } from "./shortcuts.js";

export type PersistedDiffViewMode = "unified" | "side-by-side";

export interface ReviewPreferences {
  diffViewMode: PersistedDiffViewMode;
  navigatorTreeMode: boolean;
  contextLineNavigation: boolean;
  commentsGlobal: boolean;
}

export const DEFAULT_REVIEW_PREFERENCES: ReviewPreferences = {
  diffViewMode: "unified",
  navigatorTreeMode: true,
  contextLineNavigation: false,
  commentsGlobal: false,
};

function getPreferencesPath(): string {
  return process.env.PI_CODE_DIFF_PREFERENCES_PATH ?? join(dirname(getShortcutConfigPath()), "code-diff-preferences.json");
}

function isPersistedDiffViewMode(value: unknown): value is PersistedDiffViewMode {
  return value === "unified" || value === "side-by-side";
}

export function loadReviewPreferences(): ReviewPreferences {
  const path = getPreferencesPath();
  if (!existsSync(path)) return { ...DEFAULT_REVIEW_PREFERENCES };

  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (parsed == null || typeof parsed !== "object") return { ...DEFAULT_REVIEW_PREFERENCES };
    const record = parsed as Record<string, unknown>;
    return {
      diffViewMode: isPersistedDiffViewMode(record.diffViewMode) ? record.diffViewMode : DEFAULT_REVIEW_PREFERENCES.diffViewMode,
      navigatorTreeMode: typeof record.navigatorTreeMode === "boolean" ? record.navigatorTreeMode : DEFAULT_REVIEW_PREFERENCES.navigatorTreeMode,
      contextLineNavigation: typeof record.contextLineNavigation === "boolean" ? record.contextLineNavigation : DEFAULT_REVIEW_PREFERENCES.contextLineNavigation,
      commentsGlobal: typeof record.commentsGlobal === "boolean" ? record.commentsGlobal : DEFAULT_REVIEW_PREFERENCES.commentsGlobal,
    };
  } catch {
    return { ...DEFAULT_REVIEW_PREFERENCES };
  }
}

export function saveReviewPreference(patch: Partial<ReviewPreferences>): void {
  const path = getPreferencesPath();
  const current = loadReviewPreferences();
  const next: ReviewPreferences = { ...current, ...patch };

  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  } catch {
    // Preference persistence is best-effort; never block review UI on disk writes.
  }
}

export function getReviewPreferencesPathForDiagnostics(): string {
  return getPreferencesPath();
}

// Re-export getAgentDir so callers do not need a second import solely for diagnostics.
export { getAgentDir };

export function preferencesConfigPath(): string {
  return getShortcutConfigPath();
}
