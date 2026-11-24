import { describe, expect, it } from "vite-plus/test";
import type { PullRequestActivity, PullRequestThreadComment } from "@t3tools/contracts";
import { appendPullRequestCommentPage } from "./pr-activity.logic.ts";

const comment = (id: string, body = id): PullRequestThreadComment => ({
  id,
  body,
  author: null,
  createdAt: "2026-11-24T10:00:00.000Z",
  url: null,
});

describe("paged native review conversations", () => {
  it("appends unique replies without overwriting newer comments or another conversation's cursor", () => {
    const thread = {
      id: "review-1",
      path: "src/app.ts",
      line: 4,
      side: "right" as const,
      isResolved: true,
      isOutdated: false,
      comments: [comment("first", "Edited after the page request")],
      nextCommentsCursor: "page-2",
    };
    const activity: PullRequestActivity = {
      comments: [],
      commentCount: 0,
      commentsTruncated: false,
      commits: [],
      reviewThreads: [thread, { ...thread, id: "other-review" }],
      overviewThreads: [{ ...thread, id: "overview", path: null, line: null }],
    };
    const result = appendPullRequestCommentPage(activity, "review-1", "page-2", {
      comments: [comment("first", "Stale body"), comment("second"), comment("second")],
      nextCursor: null,
      hiddenCount: 1,
    });
    expect(result.reviewThreads[0]).toMatchObject({
      isResolved: true,
      comments: [comment("first", "Edited after the page request"), comment("second")],
      nextCommentsCursor: undefined,
    });
    expect(result.reviewThreads[1]).toBe(activity.reviewThreads[1]);
    expect(result.overviewThreads?.[0]).toBe(activity.overviewThreads?.[0]);
    expect(
      appendPullRequestCommentPage(result, "review-1", "page-2", {
        comments: [comment("late")],
        nextCursor: "obsolete-cursor",
      }).reviewThreads[0],
    ).toBe(result.reviewThreads[0]);
    const overview = appendPullRequestCommentPage(result, "overview", "page-2", {
      comments: [comment("overview-reply")],
      nextCursor: "overview-next",
    });
    expect(overview.overviewThreads?.[0]?.comments.map((entry) => entry.id)).toEqual([
      "first",
      "overview-reply",
    ]);
    expect(overview.overviewThreads?.[0]?.nextCommentsCursor).toBe("overview-next");
  });
});
