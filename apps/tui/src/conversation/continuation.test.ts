import { expect, it } from "vite-plus/test";
import {
  MessageId,
  NodeId,
  RunId,
  RuntimeRequestId,
  TurnItemId,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import {
  v2Now,
  v2Projection,
} from "../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures.ts";
import { continueConversation, conversationContinuation } from "./continuation.ts";

function interrupted(): OrchestrationV2ThreadProjection {
  return {
    ...v2Projection,
    runs: [
      {
        id: RunId.make("interrupted"),
        threadId: v2Projection.thread.id,
        ordinal: 1,
        providerInstanceId: v2Projection.thread.providerInstanceId,
        modelSelection: v2Projection.thread.modelSelection,
        providerThreadId: null,
        userMessageId: MessageId.make("prompt"),
        rootNodeId: null,
        activeAttemptId: null,
        status: "interrupted",
        requestedAt: v2Now,
        startedAt: v2Now,
        completedAt: v2Now,
        checkpointId: null,
        contextHandoffId: null,
      },
    ],
  };
}

it("continues the captured interrupted run before releasing its held queue and preserves provider selection", async () => {
  const source = interrupted();
  const projection = {
    ...source,
    runs: [
      ...source.runs,
      {
        ...source.runs[0]!,
        id: RunId.make("queued"),
        ordinal: 2,
        status: "queued" as const,
        queueHeld: true,
      },
    ],
  };
  const commands: OrchestrationV2Command[] = [];
  await continueConversation(projection, async (command) => {
    commands.push(command);
  });
  expect(commands).toMatchObject([
    {
      type: "message.dispatch",
      threadId: source.thread.id,
      text: "",
      attachments: [],
      manualContinuationOfRunId: "interrupted",
      modelSelection: source.thread.modelSelection,
      dispatchMode: { type: "start_immediately" },
    },
    { type: "queue.resume", threadId: source.thread.id },
  ]);
  const rejected: OrchestrationV2Command[] = [];
  await expect(
    continueConversation(projection, async (command) => {
      rejected.push(command);
      throw new Error("Provider unavailable");
    }),
  ).rejects.toThrow("Provider unavailable");
  expect(rejected.map((command) => command.type)).toEqual(["message.dispatch"]);
});

it("offers the shared usage-limit continuation while refusing ordinary failures, live work and pending requests", () => {
  const source = interrupted();
  const failed = {
    ...source,
    runs: source.runs.map((run) => ({ ...run, status: "failed" as const })),
  };
  expect(conversationContinuation(source).available).toBe(true);
  expect(conversationContinuation(failed).available).toBe(false);
  const limited = {
    ...failed,
    turnItems: [
      {
        id: TurnItemId.make("limit"),
        threadId: source.thread.id,
        runId: source.runs[0]!.id,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        type: "error" as const,
        status: "failed" as const,
        title: "Limit",
        startedAt: v2Now,
        completedAt: v2Now,
        updatedAt: v2Now,
        failure: {
          class: "usage_limit" as const,
          message: "Usage limit reached",
          code: null,
          retryable: null,
        },
      },
    ],
  };
  expect(conversationContinuation(limited)).toMatchObject({
    available: true,
    runId: "interrupted",
  });
  expect(
    conversationContinuation({
      ...source,
      runs: source.runs.map((run) => ({ ...run, status: "running" as const })),
    }).available,
  ).toBe(false);
  expect(
    conversationContinuation({
      ...source,
      runtimeRequests: [
        {
          id: RuntimeRequestId.make("approval"),
          nodeId: NodeId.make("approval-node"),
          providerTurnId: null,
          nativeRequestRef: null,
          kind: "command",
          status: "pending",
          responseCapability: { type: "not_resumable", reason: "Ended" },
          createdAt: v2Now,
          resolvedAt: null,
        },
      ],
    }).available,
  ).toBe(false);
});

it("releases a held queue without inventing an agent continuation for a completed run", async () => {
  const source = interrupted();
  const projection = {
    ...source,
    runs: [
      {
        ...source.runs[0]!,
        status: "queued" as const,
        queueHeld: true,
      },
    ],
  };
  const commands: OrchestrationV2Command[] = [];
  await continueConversation(projection, async (command) => {
    commands.push(command);
  });
  expect(commands.map((command) => command.type)).toEqual(["queue.resume"]);
});
