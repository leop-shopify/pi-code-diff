import { describe, expect, it } from "vitest";
import { isReviewableFilePath } from "../git.js";

describe("isReviewableFilePath", () => {
  it("excludes .rbi files from review", () => {
    expect(isReviewableFilePath("app/models/shop.rbi")).toBe(false);
    expect(isReviewableFilePath("app/models/user.rbi")).toBe(false);
    expect(isReviewableFilePath("sig/components/orders.rbi")).toBe(false);
  });

  it("keeps related source files reviewable", () => {
    expect(isReviewableFilePath("app/models/shop.rb")).toBe(true);
    expect(isReviewableFilePath("src/app.ts")).toBe(true);
  });
});
