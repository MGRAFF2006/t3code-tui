import type { PullRequestInvolvement, PullRequestListEntry } from "@t3tools/contracts";
import { toSortableTimestamp } from "./state/threadSort.ts";
import type { PullRequestListSort } from "./pullRequestListPreferences.ts";

export type PullRequestGroupKey = "reviewRequested" | "authored" | "others";
export interface PullRequestGroup<Entry extends PullRequestListEntry = PullRequestListEntry> {
  readonly key: PullRequestGroupKey;
  readonly label: string;
  readonly entries: ReadonlyArray<Entry>;
}

export function rankPullRequestsByMergeReadiness<Entry extends PullRequestListEntry>(
  entries: ReadonlyArray<Entry>,
  hasMeasuredSize: (entry: Entry) => boolean = (entry) => entry.additions + entry.deletions > 0,
): ReadonlyArray<Entry> {
  const tier = (entry: Entry) => {
    if (entry.mergeability === "conflicting") return 4;
    if (entry.state !== "open") return 3;
    if (entry.isDraft) return 2;
    if (entry.checksState === "passing" && entry.reviewDecision === "approved") return 0;
    if (entry.checksState === "passing") return 1;
    return 2;
  };
  return [...entries].sort((left, right) => {
    const byTier = tier(left) - tier(right);
    if (byTier !== 0) return byTier;
    const measured = Number(hasMeasuredSize(right)) - Number(hasMeasuredSize(left));
    const sized = left.additions + left.deletions - (right.additions + right.deletions);
    return measured || sized || comparePullRequestsByRecency(left, right);
  });
}

export function comparePullRequestsByRecency(
  left: PullRequestListEntry,
  right: PullRequestListEntry,
) {
  const leftUpdated = toSortableTimestamp(left.updatedAt);
  const rightUpdated = toSortableTimestamp(right.updatedAt);
  const measured = Number(leftUpdated === null) - Number(rightUpdated === null);
  if (measured !== 0) return measured;
  if (leftUpdated === null || rightUpdated === null) return 0;
  return rightUpdated - leftUpdated;
}

function rankByTierThenRecency<Entry extends PullRequestListEntry>(
  entries: ReadonlyArray<Entry>,
  tier: (entry: Entry) => number,
): ReadonlyArray<Entry> {
  return [...entries].sort((left, right) => {
    const byTier = tier(left) - tier(right);
    return byTier !== 0 ? byTier : comparePullRequestsByRecency(left, right);
  });
}

export function rankPullRequestsBlockedOnAuthor<Entry extends PullRequestListEntry>(
  entries: ReadonlyArray<Entry>,
): ReadonlyArray<Entry> {
  return rankByTierThenRecency(entries, (entry) => {
    if (entry.state !== "open") return 6;
    if (entry.mergeability === "conflicting") return 0;
    if (entry.reviewDecision === "changes-requested") return 1;
    if (entry.checksState === "failing") return 2;
    if (entry.isDraft) return 3;
    if (entry.checksState === "passing" && entry.reviewDecision === "approved") return 5;
    return 4;
  });
}

function rankPullRequestsBlockedOnReviewer<Entry extends PullRequestListEntry>(
  entries: ReadonlyArray<Entry>,
): ReadonlyArray<Entry> {
  return rankByTierThenRecency(entries, (entry) => (entry.state === "open" ? 0 : 1));
}

export function sortPullRequestGroups<Entry extends PullRequestListEntry>(
  groups: ReadonlyArray<PullRequestGroup<Entry>>,
  sort: PullRequestListSort,
  searchText: string,
  hasMeasuredSize: (entry: Entry) => boolean = (entry) => entry.additions + entry.deletions > 0,
  involvement: PullRequestInvolvement = "all",
): ReadonlyArray<PullRequestGroup<Entry>> {
  const sortWithinGroups = (rank: (entries: ReadonlyArray<Entry>) => ReadonlyArray<Entry>) =>
    groups.map((group) => ({ ...group, entries: rank(group.entries) }));

  if (sort === "ready") {
    return searchText.trim().length === 0
      ? sortWithinGroups((entries) => rankPullRequestsByMergeReadiness(entries, hasMeasuredSize))
      : groups;
  }
  if (sort === "blocked") {
    if (searchText.trim().length > 0) return groups;
    const role = (key: PullRequestGroupKey) =>
      key === "others" ? involvement : key === "authored" ? "authored" : "reviewing";
    return groups.map((group) => {
      const groupRole = role(group.key);
      if (groupRole === "all") return group;
      const rank =
        groupRole === "authored"
          ? rankPullRequestsBlockedOnAuthor
          : rankPullRequestsBlockedOnReviewer;
      return { ...group, entries: rank(group.entries) };
    });
  }
  if (sort === "updated") return groups;

  const timestamp = (entry: Entry) =>
    toSortableTimestamp(entry.updatedAt) ?? toSortableTimestamp(entry.createdAt) ?? 0;
  return sortWithinGroups((entries) =>
    [...entries].sort((left, right) => {
      if (sort === "newest" || sort === "oldest") {
        const leftCreated = toSortableTimestamp(left.createdAt);
        const rightCreated = toSortableTimestamp(right.createdAt);
        const measured = Number(rightCreated !== null) - Number(leftCreated !== null);
        const dated = (leftCreated ?? 0) - (rightCreated ?? 0);
        return (
          measured || (sort === "newest" ? -dated : dated) || timestamp(right) - timestamp(left)
        );
      }
      const measured = Number(hasMeasuredSize(right)) - Number(hasMeasuredSize(left));
      const sized = left.additions + left.deletions - (right.additions + right.deletions);
      return (
        measured || (sort === "largest" ? -sized : sized) || timestamp(right) - timestamp(left)
      );
    }),
  );
}
