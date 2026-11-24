import { expect, it, vi } from "vite-plus/test";
import {
  ThreadId,
  type OrchestrationV2SearchThreadInput,
  type OrchestrationV2SearchThreadResult,
} from "@t3tools/contracts";
import { CLOSED_CONVERSATION_FIND, createConversationFind } from "./find.ts";
import { conversationFindChunks } from "./find-text.logic.ts";
import { searchableMessageSegments } from "@t3tools/shared/threadFindText";

function setup() {
  let current = true;
  let state = CLOSED_CONVERSATION_FIND;
  const requests: Array<{
    input: OrchestrationV2SearchThreadInput;
    update: (result: OrchestrationV2SearchThreadResult) => void;
    fail: (error: Error) => void;
    stopped: boolean;
  }> = [];
  const revealed: Array<NonNullable<OrchestrationV2SearchThreadResult["match"]>> = [];
  const find = createConversationFind({
    threadId: ThreadId.make("thread-find"),
    current: () => current,
    subscribe: (input, update, fail) => {
      const request = { input, update, fail, stopped: false };
      requests.push(request);
      return () => {
        request.stopped = true;
      };
    },
    onChange: (next) => {
      state = next;
    },
    reveal: async (match) => {
      revealed.push(match);
    },
  });
  return {
    find,
    requests,
    revealed,
    state: () => state,
    leave: () => {
      current = false;
    },
  };
}

const result = (
  entryId: string,
  occurrence = 0,
  complete = true,
): OrchestrationV2SearchThreadResult => ({
  snapshotSequence: 1,
  complete,
  totalMatches: complete ? 5 : 1,
  activeIndex: complete ? 2 : 0,
  match: { entryId, occurrence, runId: null },
});

it("refreshes changing conversation content without losing the selected occurrence or restarting an active count", async () => {
  vi.useFakeTimers();
  const fixture = setup();
  try {
    fixture.find.open("  needle  ");
    expect(fixture.requests[0]!.input).toEqual({
      threadId: "thread-find",
      query: "needle",
    });
    fixture.requests[0]!.update(result("message-a", 1, false));
    expect(fixture.state().searching).toBe(true);
    fixture.find.changed();
    fixture.find.changed();
    await vi.advanceTimersByTimeAsync(300);
    expect(fixture.requests).toHaveLength(1);
    fixture.requests[0]!.update(result("message-a", 1));
    await vi.advanceTimersByTimeAsync(300);
    expect(fixture.requests).toHaveLength(2);
    expect(fixture.requests[1]!.input).toMatchObject({
      start: { entryId: "message-a", occurrence: 1 },
    });
    expect(fixture.requests[0]!.stopped).toBe(true);
    fixture.requests[1]!.update(result("message-a", 1));
    fixture.find.step(1);
    expect(fixture.requests[2]!.input).toMatchObject({
      start: { entryId: "message-a", occurrence: 1 },
      offset: 1,
    });
    fixture.find.changed();
    fixture.find.close();
    await vi.advanceTimersByTimeAsync(300);
    expect(fixture.requests).toHaveLength(3);
    expect(fixture.requests[2]!.stopped).toBe(true);
    expect(fixture.state()).toMatchObject({ open: false, searching: false, result: null });
  } finally {
    fixture.find.dispose();
    vi.useRealTimers();
  }
});

it("retains search errors for retry and rejects old subscription frames after another query, close or destination change", () => {
  const fixture = setup();
  try {
    fixture.find.open("old");
    fixture.find.open("new", "message-b");
    fixture.requests[0]!.update(result("wrong-message"));
    expect(fixture.state().result).toBeNull();
    fixture.requests[1]!.fail(new Error("Connection unavailable"));
    expect(fixture.state()).toMatchObject({
      open: true,
      query: "new",
      searching: false,
      error: "Connection unavailable",
    });
    fixture.find.retry();
    expect(fixture.requests[2]!.input.query).toBe("new");
    fixture.requests[2]!.update(result("message-b"));
    expect(fixture.revealed).toEqual([{ entryId: "message-b", occurrence: 0, runId: null }]);
    const seen = fixture.state();
    fixture.leave();
    fixture.requests[2]!.update(result("wrong-environment"));
    fixture.requests[2]!.fail(new Error("stale"));
    expect(fixture.state()).toBe(seen);
    expect(() => fixture.find.open("new destination")).toThrow("Return to this conversation");
    fixture.find.close();
    fixture.requests[2]!.update(result("closed-search"));
    expect(fixture.state().result).toBeNull();
  } finally {
    fixture.find.dispose();
  }
});

it("highlights the exact desktop-search occurrence across Markdown segments and Unicode without matching hidden syntax", () => {
  const segments = searchableMessageSegments({
    role: "assistant",
    text: "🐈 It’s **working**. it'S working.\n\n`it’s working`",
    streaming: false,
    context: undefined,
  })!;
  const chunks = conversationFindChunks(segments, "it's working", 1);
  expect(chunks.filter((chunk) => chunk.match).map((chunk) => [chunk.text, chunk.active])).toEqual([
    ["It’s working", false],
    ["it'S working", true],
    ["it’s working", false],
  ]);
  expect(chunks.map((chunk) => chunk.text).join("")).toBe(segments.join("\n"));
  expect(conversationFindChunks(["one", "two"], "one\ntwo").some((chunk) => chunk.match)).toBe(
    false,
  );
  expect(conversationFindChunks(["aaaa"], "aa").filter((chunk) => chunk.match)).toHaveLength(2);
});
