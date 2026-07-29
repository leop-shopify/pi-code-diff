import { describe, expect, it } from "vitest";
import { getReviewAction, getReviewFooterHint, getReviewHelpSections, matchesReviewAction } from "../ui/actions.js";

describe("review action registry", () => {
  it("derives help and footer content from registered actions", () => {
    const help = getReviewHelpSections();
    const footer = getReviewFooterHint();

    expect(help.find((section) => section.title === "Navigation")?.lines).toContain("T tree/flat files");
    expect(help.find((section) => section.title === "Navigation")?.lines).toContain("L show/hide other locales");
    expect(help.find((section) => section.title === "Comments")?.lines).toContain("d/r delete selected comment");
    expect(help.find((section) => section.title === "Comments")?.lines).toContain("A active-file/all-comments view");
    expect(footer).toContain("/ search focused pane");
    expect(footer).toContain("s submit");
  });

  it("matches dispatch inputs from the same action definitions", () => {
    expect(matchesReviewAction("tree", "T")).toBe(true);
    expect(matchesReviewAction("locales", "L")).toBe(true);
    expect(matchesReviewAction("globalComments", "A")).toBe(true);
    expect(matchesReviewAction("commentDelete", "d")).toBe(true);
    expect(matchesReviewAction("commentDelete", "r")).toBe(true);
    expect(matchesReviewAction("copy", "P")).toBe(true);
    expect(matchesReviewAction("copy", "p")).toBe(false);
    expect(getReviewAction("contextNavigation").keys).toBe("C");
  });
});
