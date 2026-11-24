import {
  isOrchestrationV2WorkActive,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import type { ToolCallVisibility } from "@t3tools/contracts/settings";
import {
  summarizeToolGroup,
  workEntryHiddenByToolCallVisibility,
  type WorkLogPresentationEntry,
} from "@t3tools/client-runtime/work-log/presentation";
import { turnItemOutputText } from "@t3tools/client-runtime/work-log/item-detail";
import * as DateTime from "effect/DateTime";
import type { ActivityTiming } from "./presentation/activity-time.logic.ts";

export interface TranscriptRow {
  readonly key: string;
  readonly entries: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
}

export function transcriptItemKey(entry: OrchestrationV2ProjectedTurnItem) {
  return `${entry.sourceThreadId}/${entry.sourceItemId}`;
}

export function transcriptEntryMatches(
  entry: OrchestrationV2ProjectedTurnItem,
  id: string | undefined,
) {
  if (!id) return false;
  const item = entry.item;
  return (
    entry.sourceItemId === id ||
    item.id === id ||
    ((item.type === "user_message" || item.type === "assistant_message") && item.messageId === id)
  );
}

const successfulToolVisibility = new WeakMap<OrchestrationV2ProjectedTurnItem["item"], boolean>();

export function visibleTranscriptFallbackMessages(
  projection: Pick<OrchestrationV2ThreadProjection, "messages">,
  visibility: ToolCallVisibility,
  options: { findActive?: boolean | undefined; revealedEntryId?: string | undefined } = {},
) {
  const messages = projection.messages;
  if (visibility !== "zen" || options.findActive) return messages;
  const terminalReplies = new Map<string, string>();
  let response = 0;
  for (const message of messages) {
    if (message.role === "user") response += 1;
    if (message.role === "assistant")
      terminalReplies.set(message.runId ?? `unkeyed:${response}`, message.id);
  }
  const terminalIds = new Set(terminalReplies.values());
  return messages.filter(
    (message) =>
      message.role !== "assistant" ||
      terminalIds.has(message.id) ||
      message.id === options.revealedEntryId,
  );
}

export function visibleTranscriptItems(
  projection: OrchestrationV2ThreadProjection,
  visibility: ToolCallVisibility,
  options: { findActive?: boolean | undefined; revealedEntryId?: string | undefined } = {},
): ReadonlyArray<OrchestrationV2ProjectedTurnItem> {
  const entries = projection.visibleTurnItems;
  const mode = visibility === "zen" && options.findActive ? "hideAll" : visibility;
  if (mode === "showAll") return entries;
  if (mode !== "zen") {
    return entries.filter(({ item }) => {
      // A deferred anchor cannot prove that every hidden call succeeded.
      if (mode === "hideSuccessful" && item.deferredWork) return true;
      const work: WorkLogPresentationEntry = {
        id: item.id,
        createdAt: "",
        label: item.title ?? item.type,
        tone: "tool",
        itemType: item.type,
      };
      if (!workEntryHiddenByToolCallVisibility(work, "hideAll")) return true;
      if (mode === "hideAll") return false;
      if (item.status !== "completed") return true;
      let hidden = successfulToolVisibility.get(item);
      if (hidden === undefined) {
        hidden = workEntryHiddenByToolCallVisibility(
          {
            ...work,
            structuredPayload: item,
            detail: turnItemOutputText(item) ?? "",
            toolLifecycleStatus: "completed",
          },
          mode,
        );
        successfulToolVisibility.set(item, hidden);
      }
      return !hidden;
    });
  }

  const terminalReplies = new Map<string, OrchestrationV2ProjectedTurnItem>();
  const retainedReplies = new Set<OrchestrationV2ProjectedTurnItem>();
  const sourceState = new Map<
    string,
    {
      response: number;
      awaitingSteerReply: boolean;
      candidate: OrchestrationV2ProjectedTurnItem | null;
    }
  >();
  const superseded = new Map(
    projection.attempts
      .filter((attempt) => attempt.status === "superseded")
      .map((attempt) => [attempt.id, attempt]),
  );
  const turns = new Map(projection.providerTurns.map((turn) => [turn.id, turn]));
  const lastSupersededOutput = new Map<
    OrchestrationV2ThreadProjection["attempts"][number]["id"],
    OrchestrationV2ProjectedTurnItem
  >();
  for (const entry of entries) {
    const { item } = entry;
    let state = sourceState.get(entry.sourceThreadId);
    if (!state) {
      state = { response: 0, awaitingSteerReply: false, candidate: null };
      sourceState.set(entry.sourceThreadId, state);
    }
    if (item.type !== "reasoning") {
      if (state.candidate && item.type === "assistant_message")
        retainedReplies.add(state.candidate);
      state.candidate = null;
    }
    if (item.type === "user_message") {
      const steer = item.inputIntent === "steer" || item.inputIntent === "promoted_queued_to_steer";
      state.awaitingSteerReply = steer;
      if (!steer) state.response += 1;
    } else if (item.type === "notification") {
      state.response += 1;
    } else if (item.type === "assistant_message") {
      terminalReplies.set(
        `${entry.sourceThreadId}/${item.runId ?? `unkeyed:${state.response}`}`,
        entry,
      );
      if (item.phase === "final_answer") retainedReplies.add(entry);
      if (state.awaitingSteerReply) {
        state.candidate = entry;
        state.awaitingSteerReply = false;
      }
    }
    const attemptId =
      item.providerTurnId === null ? undefined : turns.get(item.providerTurnId)?.runAttemptId;
    if (
      attemptId &&
      superseded.has(attemptId) &&
      item.type !== "user_message" &&
      item.type !== "system_notice" &&
      item.type !== "notification"
    ) {
      const previous = lastSupersededOutput.get(attemptId);
      if (
        previous?.item.deferredWork === undefined ||
        previous.item.deferredWork.lastOrdinal <= item.ordinal
      )
        lastSupersededOutput.set(attemptId, entry);
    }
  }
  for (const [attemptId, entry] of lastSupersededOutput) {
    const { item } = entry;
    const completedAt = superseded.get(attemptId)?.completedAt;
    if (
      item.type === "assistant_message" &&
      item.phase === undefined &&
      !item.streaming &&
      item.status === "completed" &&
      item.completedAt !== null &&
      completedAt != null &&
      DateTime.isLessThan(item.completedAt, completedAt)
    )
      retainedReplies.add(entry);
  }
  const terminal = new Set(terminalReplies.values());
  return entries.filter((entry) => {
    const { item } = entry;
    if (item.type === "assistant_message")
      return (
        terminal.has(entry) ||
        retainedReplies.has(entry) ||
        transcriptEntryMatches(entry, options.revealedEntryId)
      );
    if (isWork(entry) || item.type === "todo_list" || item.type === "checkpoint") return false;
    return true;
  });
}

function isWork(entry: OrchestrationV2ProjectedTurnItem) {
  switch (entry.item.type) {
    case "command_execution":
    case "file_change":
    case "dynamic_tool":
    case "file_search":
    case "web_search":
    case "reasoning":
    case "subagent":
      return true;
    default:
      return false;
  }
}

export function groupTranscriptItems(entries: ReadonlyArray<OrchestrationV2ProjectedTurnItem>) {
  const rows: Array<{ key: string; entries: OrchestrationV2ProjectedTurnItem[] }> = [];
  for (const entry of entries) {
    const previous = rows.at(-1);
    const anchor = previous?.entries[0];
    if (
      anchor &&
      isWork(anchor) &&
      isWork(entry) &&
      anchor.sourceThreadId === entry.sourceThreadId &&
      anchor.visibility === entry.visibility &&
      anchor.item.runId === entry.item.runId &&
      anchor.item.providerThreadId === entry.item.providerThreadId &&
      anchor.item.providerTurnId === entry.item.providerTurnId &&
      anchor.item.parentItemId === entry.item.parentItemId
    )
      previous.entries.push(entry);
    else rows.push({ key: transcriptItemKey(entry), entries: [entry] });
  }
  return rows;
}

export function summarizeTranscriptWork(entries: TranscriptRow["entries"]) {
  const work: WorkLogPresentationEntry[] = entries.map(({ item }) => ({
    id: item.id,
    createdAt: "",
    label: item.title ?? (item.type === "dynamic_tool" ? (item.toolName ?? "Tool") : item.type),
    itemType: item.type,
    tone: item.type === "reasoning" ? "thinking" : "tool",
    structuredPayload: item,
    toolLifecycleStatus: isOrchestrationV2WorkActive(item.status)
      ? "inProgress"
      : item.status === "failed"
        ? "failed"
        : item.status === "completed"
          ? "completed"
          : "stopped",
  }));
  const { summary, hasFailure } = summarizeToolGroup(work);
  const active = entries.filter(({ item }) => isOrchestrationV2WorkActive(item.status)).length;
  const tools = entries.filter(({ item }) => item.type !== "reasoning").length;
  const deferred = entries.flatMap(({ item }) => (item.deferredWork ? [item.deferredWork] : []));
  const count = Math.max(entries.length, ...deferred.map((value) => value.itemCount));
  return {
    label: deferred.length
      ? `Work · ${count} items`
      : tools
        ? `${tools} tool call${tools === 1 ? "" : "s"} · ${summary}`
        : summary,
    active,
    hasFailure,
  };
}

export function transcriptWorkElapsed(entries: TranscriptRow["entries"]): ActivityTiming | null {
  if (!entries.length) return null;
  let startedAt = Infinity;
  let completedAt = 0;
  let active = false;
  let missingCompletion = false;
  for (const entry of entries) {
    const item = entry.item;
    if (!isWork(entry) || item.deferredWork || item.startedAt === null) return null;
    startedAt = Math.min(startedAt, DateTime.toEpochMillis(item.startedAt));
    active ||= isOrchestrationV2WorkActive(item.status);
    if (item.completedAt === null) missingCompletion = true;
    else completedAt = Math.max(completedAt, DateTime.toEpochMillis(item.completedAt));
  }
  return !active && missingCompletion
    ? null
    : { startedAt, completedAt: active ? null : completedAt };
}
