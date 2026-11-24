import {
  COMPOSER_CONTEXT_MAX_RECORDS,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { recallComposerMessage } from "@t3tools/client-runtime/composer-prompt-history";
import type { Draft } from "./draft.ts";

export function conversationRewindTargets(projection: OrchestrationV2ThreadProjection) {
  const checkpoints = projection.checkpoints.filter(
    (checkpoint) =>
      (checkpoint.status === "ready" || checkpoint.status === "missing") &&
      projection.checkpointScopes.some(
        (scope) =>
          scope.id === checkpoint.scopeId &&
          scope.providerThreadId === projection.thread.activeProviderThreadId,
      ),
  );
  const runs = projection.runs
    .filter((run) => run.status !== "rolled_back" && run.status !== "queued")
    .sort((left, right) => left.ordinal - right.ordinal);
  const beforeRun = new Map(
    runs.map((run, index) => {
      const predecessor = runs[index - 1];
      return [
        run.id,
        checkpoints.findLast((checkpoint) =>
          predecessor
            ? checkpoint.appRunOrdinal === predecessor.ordinal
            : checkpoint.ordinalWithinScope === 0 && checkpoint.appRunOrdinal === null,
        ),
      ] as const;
    }),
  );
  const byRunId = new Map(runs.map((run) => [run.id, run]));
  return projection.visibleTurnItems.flatMap((entry) => {
    const item = entry.item;
    if (
      entry.visibility !== "local" ||
      entry.sourceThreadId !== projection.thread.id ||
      item.type !== "user_message" ||
      !item.runId
    )
      return [];
    const run = byRunId.get(item.runId);
    if (!run) return [];
    const checkpoint = beforeRun.get(run.id);
    if (
      item.type !== "user_message" ||
      (item.inputIntent !== "turn_start" && item.inputIntent !== "queued_turn") ||
      !["completed", "failed", "interrupted", "cancelled"].includes(run.status) ||
      !checkpoint
    )
      return [];
    return [{ entry: { ...entry, item }, run, checkpoint }];
  });
}

export function restoredRewindDraft(
  draft: Draft,
  message: Parameters<typeof recallComposerMessage>[0],
  restoredAttachments: Draft["attachments"],
): Draft {
  const recalled = recallComposerMessage(message);
  const text = recalled.prompt
    ? draft.text
      ? `${draft.text}\n\n${recalled.prompt}`
      : recalled.prompt
    : draft.text;
  const records = [
    ...draft.context,
    ...recalled.mentions.threadContexts,
    ...recalled.mentions.environmentContexts,
  ];
  const context = [...new Map(records.map((record) => [record.contextId, record])).values()];
  if (context.length > COMPOSER_CONTEXT_MAX_RECORDS)
    throw new Error("Make room for this prompt's context before rewinding.");
  const attachments = [...draft.attachments, ...restoredAttachments];
  if (attachments.length > PROVIDER_SEND_TURN_MAX_ATTACHMENTS)
    throw new Error("Make room for this prompt's attachments before rewinding.");
  return { ...draft, text, context, attachments };
}
