import { describe, expect, it } from "vite-plus/test";
import {
  RunId,
  MessageId,
  RuntimeRequestId,
  ProviderTurnId,
  ProviderThreadId,
  ProviderInstanceId,
  RunAttemptId,
  NodeId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2ConversationMessage,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import {
  v2Now,
  v2ThreadId,
  v2Projection,
} from "../../../packages/client-runtime/src/state/orchestrationV2TestFixtures.ts";
import {
  groupTranscriptItems,
  transcriptWorkElapsed,
  summarizeTranscriptWork,
  visibleTranscriptItems,
  visibleTranscriptFallbackMessages,
} from "./transcript.logic.ts";

function call(id: string) {
  return {
    sourceThreadId: v2ThreadId,
    sourceItemId: TurnItemId.make(id),
    position: 0,
    visibility: "local",
    item: {
      id: TurnItemId.make(id),
      threadId: v2ThreadId,
      runId: RunId.make("run"),
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "completed",
      title: "Read file",
      startedAt: null,
      completedAt: v2Now,
      updatedAt: v2Now,
      type: "dynamic_tool",
      toolName: "read_file",
      input: {},
      output: null,
    },
  } satisfies OrchestrationV2ProjectedTurnItem;
}

describe("terminal work groups", () => {
  it("groups adjacent calls while keeping messages and actionable requests outside", () => {
    const first = call("first");
    const second = call("second");
    const separator = {
      ...call("separator"),
      item: {
        ...call("separator").item,
        type: "system_notice" as const,
        message: "Approval needed",
      },
    };
    const rows = groupTranscriptItems([first, second, separator, call("third")]);
    expect(rows.map((row) => row.entries.map((entry) => entry.sourceItemId))).toEqual([
      ["first", "second"],
      ["separator"],
      ["third"],
    ]);
    expect(groupTranscriptItems([first, second, call("streamed")])[0]?.key).toBe(rows[0]?.key);
  });

  it.each(["sourceThreadId", "visibility", "runId", "parentItemId"] as const)(
    "does not merge calls across %s boundaries",
    (field) => {
      const first = call("first");
      const second = call("second");
      const changed =
        field === "sourceThreadId"
          ? { ...second, sourceThreadId: ThreadId.make("other-thread") }
          : field === "visibility"
            ? { ...second, visibility: "inherited" as const }
            : {
                ...second,
                item: {
                  ...second.item,
                  ...(field === "runId"
                    ? { runId: RunId.make("other-run") }
                    : { parentItemId: TurnItemId.make("parent") }),
                },
              };
      expect(groupTranscriptItems([first, changed])).toHaveLength(2);
    },
  );

  it("keeps running and failed work visible in summaries and counts deferred work once", () => {
    const first = call("first");
    const failed = {
      ...call("failed"),
      item: { ...call("failed").item, status: "failed" as const },
    };
    const running = {
      ...call("running"),
      item: { ...call("running").item, status: "running" as const },
    };
    expect(summarizeTranscriptWork([first, failed, running])).toMatchObject({
      active: 1,
      hasFailure: true,
    });
    const deferred = {
      ...first,
      item: { ...first.item, deferredWork: { cursor: "work", itemCount: 50, lastOrdinal: 49 } },
    };
    expect(summarizeTranscriptWork([deferred, failed]).label).toBe("Work · 50 items");
  });
});

it("measures the wall span of overlapping work and leaves deferred or unknown timing unavailable", () => {
  const start = DateTime.makeUnsafe("2026-11-24T10:00:00Z");
  const middle = DateTime.add(start, { seconds: 10 });
  const end = DateTime.add(start, { seconds: 30 });
  const first = {
    ...call("first"),
    item: {
      ...call("first").item,
      startedAt: start,
      completedAt: DateTime.add(start, { seconds: 20 }),
    },
  };
  const second = {
    ...call("second"),
    item: { ...call("second").item, startedAt: middle, completedAt: end },
  };
  expect(transcriptWorkElapsed([first, second])).toEqual({
    startedAt: DateTime.toEpochMillis(start),
    completedAt: DateTime.toEpochMillis(end),
  });
  expect(
    transcriptWorkElapsed([
      first,
      { ...second, item: { ...second.item, status: "running", completedAt: null } },
    ]),
  ).toEqual({ startedAt: DateTime.toEpochMillis(start), completedAt: null });
  expect(transcriptWorkElapsed([first, call("unknown")])).toBeNull();
  expect(
    transcriptWorkElapsed([
      {
        ...first,
        item: {
          ...first.item,
          deferredWork: { cursor: "earlier", itemCount: 20, lastOrdinal: 19 },
        },
      },
    ]),
  ).toBeNull();
});

describe("terminal tool visibility", () => {
  function message(id: string, type: "user_message" | "assistant_message") {
    const base = call(id);
    return {
      ...base,
      item:
        type === "user_message"
          ? {
              ...base.item,
              type,
              messageId: MessageId.make(id),
              text: id,
              inputIntent: "turn_start" as const,
              createdBy: "user" as const,
              creationSource: "web" as const,
              attachments: [],
            }
          : { ...base.item, type, messageId: MessageId.make(id), text: id, streaming: false },
    } satisfies OrchestrationV2ProjectedTurnItem;
  }

  function projection(entries: ReadonlyArray<OrchestrationV2ProjectedTurnItem>) {
    return { ...v2Projection, visibleTurnItems: entries };
  }

  const ids = (entries: ReadonlyArray<OrchestrationV2ProjectedTurnItem>) =>
    entries.map((entry) => entry.sourceItemId);

  it("hides successful tools without hiding failed, running, interrupted or deferred work", () => {
    const passed = call("passed");
    const failed = {
      ...call("failed"),
      item: { ...call("failed").item, status: "failed" as const },
    };
    const running = {
      ...call("running"),
      item: { ...call("running").item, status: "running" as const },
    };
    const interrupted = {
      ...call("interrupted"),
      item: { ...call("interrupted").item, status: "interrupted" as const },
    };
    const nonzero = {
      ...call("nonzero"),
      item: {
        ...call("nonzero").item,
        type: "command_execution" as const,
        input: "test",
        exitCode: 1,
        output: "",
      },
    };
    const deferred = {
      ...call("deferred"),
      item: {
        ...call("deferred").item,
        deferredWork: { cursor: "more", itemCount: 8, lastOrdinal: 7 },
      },
    };
    const providerError = {
      ...call("provider-error"),
      item: {
        ...call("provider-error").item,
        toolName: "mcp__t3_code__preview_open",
        output: { isError: true, content: [{ type: "text", text: "Browser unavailable" }] },
      },
    };
    const entries = [
      message("user", "user_message"),
      passed,
      failed,
      running,
      interrupted,
      nonzero,
      deferred,
      providerError,
    ];
    expect(visibleTranscriptItems(projection(entries), "showAll")).toBe(entries);
    expect(ids(visibleTranscriptItems(projection(entries), "hideSuccessful"))).toEqual([
      "user",
      "failed",
      "running",
      "interrupted",
      "nonzero",
      "deferred",
      "provider-error",
    ]);
    expect(ids(visibleTranscriptItems(projection(entries), "hideAll"))).toEqual(["user"]);
    const recovered = {
      ...providerError,
      item: {
        ...providerError.item,
        output: { isError: false, content: [{ type: "text", text: "Opened browser" }] },
      },
    };
    expect(ids(visibleTranscriptItems(projection([recovered]), "hideSuccessful"))).toEqual([]);
  });

  it("keeps requests, errors, plans and response boundaries accessible in quiet modes", () => {
    const base = call("request");
    const request = {
      ...base,
      item: {
        ...base.item,
        type: "approval_request" as const,
        requestId: RuntimeRequestId.make("approval"),
        requestKind: "command" as const,
        prompt: "Approve",
      },
    };
    const error = {
      ...call("error"),
      item: {
        ...call("error").item,
        type: "error" as const,
        failure: {
          class: "provider_error" as const,
          message: "Offline",
          code: null,
          retryable: true,
        },
      },
    };
    const notice = {
      ...call("notice"),
      item: { ...call("notice").item, type: "system_notice" as const, message: "Resumed" },
    };
    const entries = [
      message("user", "user_message"),
      call("tool"),
      request,
      error,
      notice,
      message("final", "assistant_message"),
    ];
    for (const mode of ["hideAll", "zen"] as const) {
      expect(ids(visibleTranscriptItems(projection(entries), mode))).toEqual([
        "user",
        "request",
        "error",
        "notice",
        "final",
      ]);
    }
  });

  it("shows final answers per response, preserves explicit finals, and reveals intermediate messages while finding", () => {
    const final = message("final", "assistant_message");
    const explicit = {
      ...message("explicit", "assistant_message"),
      item: {
        ...message("explicit", "assistant_message").item,
        type: "assistant_message" as const,
        messageId: MessageId.make("explicit"),
        text: "explicit",
        streaming: true,
        phase: "final_answer" as const,
      },
    };
    const older = {
      ...message("older", "assistant_message"),
      item: { ...final.item, id: TurnItemId.make("older"), runId: RunId.make("older-run") },
    };
    const entries = [
      older,
      message("user", "user_message"),
      message("step", "assistant_message"),
      call("tool"),
      explicit,
      final,
    ];
    expect(ids(visibleTranscriptItems(projection(entries), "zen"))).toEqual([
      "older",
      "user",
      "explicit",
      "final",
    ]);
    expect(ids(visibleTranscriptItems(projection(entries), "zen", { findActive: true }))).toEqual([
      "older",
      "user",
      "step",
      "explicit",
      "final",
    ]);
    expect(
      ids(visibleTranscriptItems(projection(entries), "zen", { revealedEntryId: "step" })),
    ).toEqual(["older", "user", "step", "explicit", "final"]);
    const streaming = {
      ...final,
      item: { ...final.item, streaming: true, status: "running" as const },
    };
    expect(
      ids(
        visibleTranscriptItems(
          projection([message("step", "assistant_message"), streaming]),
          "zen",
        ),
      ),
    ).toEqual(["final"]);
  });

  it("retains an answer from a superseded attempt only when it was the attempt's last output", () => {
    const providerTurnId = ProviderTurnId.make("old-turn");
    const attemptId = RunAttemptId.make("old-attempt");
    const reply = {
      ...message("reply", "assistant_message"),
      item: { ...message("reply", "assistant_message").item, providerTurnId, ordinal: 1 },
    };
    const reasoning = {
      ...call("later-reasoning"),
      item: {
        ...call("later-reasoning").item,
        type: "reasoning" as const,
        text: "Still working",
        streaming: false,
        providerTurnId,
        ordinal: 2,
      },
    };
    const next = message("next", "assistant_message");
    const state = {
      ...projection([reply, next]),
      attempts: [
        {
          id: attemptId,
          runId: RunId.make("run"),
          attemptOrdinal: 1,
          rootNodeId: NodeId.make("root"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          providerThreadId: ProviderThreadId.make("provider-thread"),
          providerTurnId,
          reason: "initial" as const,
          status: "superseded" as const,
          startedAt: v2Now,
          completedAt: DateTime.makeUnsafe("2026-06-20T00:00:01Z"),
        },
      ],
      providerTurns: [
        {
          id: providerTurnId,
          providerThreadId: ProviderThreadId.make("provider-thread"),
          nodeId: NodeId.make("root"),
          runAttemptId: attemptId,
          nativeTurnRef: null,
          ordinal: 1,
          status: "completed" as const,
          startedAt: v2Now,
          completedAt: v2Now,
        },
      ],
    };
    expect(ids(visibleTranscriptItems(state, "zen"))).toEqual(["reply", "next"]);
    expect(
      ids(visibleTranscriptItems({ ...state, visibleTurnItems: [reply, reasoning, next] }, "zen")),
    ).toEqual(["next"]);
  });

  it("retains a direct answer to steering before a following assistant reply", () => {
    const user = message("user", "user_message");
    const steer = {
      ...user,
      sourceItemId: TurnItemId.make("steer"),
      item: {
        ...user.item,
        type: "user_message" as const,
        messageId: MessageId.make("steer"),
        text: "Steer",
        inputIntent: "steer" as const,
        createdBy: "user" as const,
        creationSource: "web" as const,
        attachments: [],
      },
    };
    const answer = message("answer", "assistant_message");
    const entries = [user, steer, answer, message("final", "assistant_message")];
    expect(ids(visibleTranscriptItems(projection(entries), "zen"))).toEqual([
      "user",
      "steer",
      "answer",
      "final",
    ]);
    expect(
      ids(
        visibleTranscriptItems(
          projection([user, steer, answer, call("tool"), message("final", "assistant_message")]),
          "zen",
        ),
      ),
    ).toEqual(["user", "steer", "final"]);
  });

  it("filters message-only projections in Zen without hiding system messages or find results", () => {
    const message = (
      id: string,
      role: OrchestrationV2ConversationMessage["role"],
      runId: OrchestrationV2ConversationMessage["runId"] = null,
    ): OrchestrationV2ConversationMessage => ({
      id: MessageId.make(id),
      threadId: v2ThreadId,
      nodeId: null,
      runId,
      role,
      createdBy: role === "assistant" ? "agent" : role,
      creationSource: "web",
      text: id,
      streaming: false,
      attachments: [],
      createdAt: v2Now,
      updatedAt: v2Now,
    });
    const messages = [
      message("user", "user"),
      message("step", "assistant"),
      message("system", "system"),
      message("first-final", "assistant"),
      message("follow-up", "user"),
      message("next-step", "assistant", RunId.make("next")),
      message("next-final", "assistant", RunId.make("next")),
    ];
    const ids = (value: ReadonlyArray<OrchestrationV2ConversationMessage>) =>
      value.map((row) => row.id);
    expect(ids(visibleTranscriptFallbackMessages({ messages }, "zen"))).toEqual([
      "user",
      "system",
      "first-final",
      "follow-up",
      "next-final",
    ]);
    expect(visibleTranscriptFallbackMessages({ messages }, "hideAll")).toBe(messages);
    expect(visibleTranscriptFallbackMessages({ messages }, "zen", { findActive: true })).toBe(
      messages,
    );
    expect(
      ids(visibleTranscriptFallbackMessages({ messages }, "zen", { revealedEntryId: "step" })),
    ).toEqual(["user", "step", "system", "first-final", "follow-up", "next-final"]);
  });
});
