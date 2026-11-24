import type {
  PullRequestActivity,
  PullRequestConversationThread,
  PullRequestThreadCommentsResult,
} from "@t3tools/contracts";

export function appendPullRequestCommentPage(
  activity: PullRequestActivity,
  threadId: string,
  cursor: string,
  page: PullRequestThreadCommentsResult,
): PullRequestActivity {
  const append = <Thread extends PullRequestConversationThread>(thread: Thread): Thread => {
    if (thread.id !== threadId || thread.nextCommentsCursor !== cursor) return thread;
    const seen = new Set(thread.comments.map((comment) => comment.id));
    return {
      ...thread,
      comments: [
        ...thread.comments,
        ...page.comments.filter((comment) => {
          if (seen.has(comment.id)) return false;
          seen.add(comment.id);
          return true;
        }),
      ],
      nextCommentsCursor: page.nextCursor ?? undefined,
    };
  };
  return {
    ...activity,
    reviewThreads: activity.reviewThreads.map(append),
    ...(activity.overviewThreads === undefined
      ? {}
      : { overviewThreads: activity.overviewThreads.map(append) }),
  };
}
