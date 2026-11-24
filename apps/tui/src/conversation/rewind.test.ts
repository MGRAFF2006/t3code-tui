import { expect, it } from "vite-plus/test";
import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  CommandId,
  MessageId,
  NodeId,
  ProviderThreadId,
  ProviderDriverKind,
  RunId,
  TurnItemId,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadStreamItem,
} from "@t3tools/contracts";
import {
  v2Now,
  v2Projection,
} from "../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures.ts";
import { conversationRewindTargets, restoredRewindDraft } from "./rewind.logic.ts";
import { waitForConversationRewind } from "./rewind.ts";

function setup() {
  const thread = {
    ...v2Projection.thread,
    activeProviderThreadId: ProviderThreadId.make("provider-thread"),
  };
  const run = (ordinal: number) => ({
    id: RunId.make(`run-${ordinal}`),
    threadId: thread.id,
    ordinal,
    providerInstanceId: thread.providerInstanceId,
    modelSelection: thread.modelSelection,
    providerThreadId: thread.activeProviderThreadId,
    userMessageId: MessageId.make(`message-${ordinal}`),
    rootNodeId: null,
    activeAttemptId: null,
    status: "completed" as const,
    requestedAt: v2Now,
    startedAt: v2Now,
    completedAt: v2Now,
    checkpointId: null,
    contextHandoffId: null,
  });
  const checkpoint = (ordinal: number) => ({
    id: CheckpointId.make(`checkpoint-${ordinal}`),
    threadId: thread.id,
    scopeId: CheckpointScopeId.make("scope"),
    runId: ordinal === 0 ? null : RunId.make(`run-${ordinal}`),
    nodeId: NodeId.make("node"),
    parentCheckpointId: null,
    ordinalWithinScope: ordinal,
    appRunOrdinal: ordinal === 0 ? null : ordinal,
    ref: CheckpointRef.make(`ref-${ordinal}`),
    status: "ready" as const,
    files: [],
    capturedAt: v2Now,
  });
  const projection: OrchestrationV2ThreadProjection = {
    ...v2Projection,
    thread,
    runs: [run(1), { ...run(2), status: "rolled_back" }, run(3)],
    checkpointScopes: [
      {
        id: CheckpointScopeId.make("scope"),
        threadId: thread.id,
        runId: null,
        nodeId: NodeId.make("node"),
        parentScopeId: null,
        providerThreadId: thread.activeProviderThreadId,
        kind: "provider_thread",
        ordinalWithinParent: 0,
        advancesAppRunCount: true,
        cwd: "/workspace",
        createdAt: v2Now,
      },
    ],
    checkpoints: [checkpoint(0), checkpoint(1), checkpoint(2)],
    providerThreads: [
      {
        id: thread.activeProviderThreadId!,
        appThreadId: thread.id,
        ownerNodeId: null,
        driver: ProviderDriverKind.make("codex"),
        nativeConversationHeadRef: null,
        firstRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        providerInstanceId: thread.providerInstanceId,
        providerSessionId: null,
        nativeThreadRef: null,
        status: "idle",
        createdAt: v2Now,
        updatedAt: v2Now,
        lastRunOrdinal: 3,
      },
    ],
    visibleTurnItems: [1, 3].map((ordinal) => ({
      sourceThreadId: thread.id,
      sourceItemId: TurnItemId.make(`item-${ordinal}`),
      position: ordinal,
      visibility: "local",
      item: {
        id: TurnItemId.make(`item-${ordinal}`),
        threadId: thread.id,
        runId: RunId.make(`run-${ordinal}`),
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal,
        status: "completed",
        title: null,
        startedAt: v2Now,
        completedAt: v2Now,
        updatedAt: v2Now,
        type: "user_message",
        createdBy: "user",
        creationSource: "web",
        messageId: MessageId.make(`message-${ordinal}`),
        text: `Prompt ${ordinal}`,
        inputIntent: "turn_start",
        attachments: [],
      },
    })),
  };
  return projection;
}

it("rewinds to the visible predecessor after an earlier rewind and keeps inherited/steering prompts outside the edit workflow", () => {
  const projection = setup();
  expect(
    conversationRewindTargets(projection).map(({ run, checkpoint }) => [
      run.ordinal,
      checkpoint.appRunOrdinal,
    ]),
  ).toEqual([
    [1, null],
    [3, 1],
  ]);
  const bounded = { ...projection, visibleTurnItems: projection.visibleTurnItems.slice(1) };
  expect(conversationRewindTargets(bounded)[0]?.checkpoint.appRunOrdinal).toBe(1);
  expect(
    conversationRewindTargets({
      ...projection,
      visibleTurnItems: projection.visibleTurnItems.map((entry) => ({
        ...entry,
        visibility: "inherited" as const,
      })),
    }),
  ).toEqual([]);
  const steer = projection.visibleTurnItems[1]!;
  if (steer.item.type !== "user_message") throw new Error("Invalid fixture");
  expect(
    conversationRewindTargets({
      ...projection,
      visibleTurnItems: [{ ...steer, item: { ...steer.item, inputIntent: "steer" } }],
    }),
  ).toEqual([]);
  expect(conversationRewindTargets({ ...projection, checkpointScopes: [] })).toEqual([]);
  const current = {
    text: "Keep my draft",
    mentions: [],
    context: [],
    attachments: [],
    freshContext: true,
  };
  const restored = restoredRewindDraft(current, { text: "Earlier prompt", context: undefined }, []);
  expect(restored).toMatchObject({ text: "Keep my draft\n\nEarlier prompt", freshContext: true });
  expect(current.text).toBe("Keep my draft");
});

it("awaits both command acceptance and the persisted provider/run rollback milestone before restoring a draft", async () => {
  const projection = setup();
  const commandId = CommandId.make("rewind-request");
  let update: ((frame: OrchestrationV2ThreadStreamItem) => void) | undefined;
  let accepted: (() => void) | undefined;
  let stopped = false;
  let completed = false;
  const done = waitForConversationRewind({
    projection,
    commandId,
    turnCount: 1,
    subscribe: (onFrame) => {
      update = onFrame;
      return () => {
        stopped = true;
      };
    },
    dispatch: () =>
      new Promise<void>((resolve) => {
        accepted = resolve;
      }),
  }).then(() => {
    completed = true;
  });
  const after = {
    ...projection,
    thread: { ...projection.thread, rollbackRequestId: commandId },
    runs: projection.runs.map((run) =>
      run.ordinal > 1 ? { ...run, status: "rolled_back" as const } : run,
    ),
    providerThreads: projection.providerThreads.map((thread) => ({ ...thread, lastRunOrdinal: 1 })),
  };
  update!({ kind: "snapshot", snapshotSequence: 4, projection: after });
  expect(completed).toBe(false);
  accepted!();
  await done;
  expect(completed).toBe(true);
  expect(stopped).toBe(true);
});

it("surfaces the matching rollback failure and disposes its subscription", async () => {
  const projection = setup();
  const commandId = CommandId.make("failed-rewind");
  let update: ((frame: OrchestrationV2ThreadStreamItem) => void) | undefined;
  let stopped = false;
  const done = waitForConversationRewind({
    projection,
    commandId,
    turnCount: 1,
    subscribe: (onFrame) => {
      update = onFrame;
      return () => {
        stopped = true;
      };
    },
    dispatch: async () => {},
  });
  const rejected = expect(done).rejects.toThrow("Workspace is shared");
  update!({
    kind: "snapshot",
    snapshotSequence: 4,
    projection: {
      ...projection,
      thread: {
        ...projection.thread,
        rollbackFailure: { requestId: commandId, message: "Workspace is shared" },
      },
    },
  });
  await rejected;
  expect(stopped).toBe(true);
});
