import {
  isListedThreadLineage,
  type EnvironmentId,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import {
  planPinnedReorder,
  sortActiveThreadsByOrderKey,
  sortPinnedThreadsByOrderKey,
} from "@t3tools/client-runtime/state/thread-sort";
import * as DateTime from "effect/DateTime";

export type ThreadMove = "up" | "down" | "first" | "last";

export function planThreadReorder(input: {
  threads: ReadonlyArray<OrchestrationV2ThreadShell>;
  targetId: ThreadId;
  environmentId: EnvironmentId;
  now: string;
  move: ThreadMove;
}) {
  const target = input.threads.find((thread) => thread.id === input.targetId);
  if (!target) return [];
  const pinned = target.pinnedAt != null;
  const entries = input.threads
    .filter(
      (thread) =>
        thread.deletedAt === null &&
        thread.archivedAt === null &&
        isListedThreadLineage(thread.lineage) &&
        (thread.pinnedAt != null) === pinned &&
        (pinned || thread.settledOverride !== "settled") &&
        !effectiveSnoozed(presentThreadShell(input.environmentId, thread), { now: input.now }),
    )
    .map((thread) => ({
      id: thread.id,
      createdAt: DateTime.formatIso(thread.createdAt),
      unsettledAt: thread.unsettledAt ? DateTime.formatIso(thread.unsettledAt) : null,
      pinOrderKey: thread.pinOrderKey,
      activeOrderKey: thread.activeOrderKey,
    }));
  const ordered = pinned
    ? sortPinnedThreadsByOrderKey(entries)
    : sortActiveThreadsByOrderKey(entries);
  const ids = ordered.map((entry) => entry.id);
  const index = ids.indexOf(input.targetId);
  if (index < 0) return [];
  const destination =
    input.move === "first"
      ? 0
      : input.move === "last"
        ? ids.length - 1
        : Math.max(0, Math.min(ids.length - 1, index + (input.move === "up" ? -1 : 1)));
  if (destination === index) return [];
  ids.splice(index, 1);
  ids.splice(destination, 0, input.targetId);
  return planPinnedReorder({
    orderedIds: ids,
    movedId: input.targetId,
    keysById: new Map(
      input.threads.map((thread) => [
        thread.id,
        pinned ? thread.pinOrderKey : thread.activeOrderKey,
      ]),
    ),
  });
}
