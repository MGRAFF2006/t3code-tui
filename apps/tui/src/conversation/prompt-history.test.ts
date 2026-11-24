import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  formatComposerContextReference,
  threadContextRecord,
} from "@t3tools/shared/composerContextReferences";
import { createPromptHistoryNavigation } from "./prompt-history.ts";
import type { Draft } from "./draft.ts";

const empty: Draft = { text: "", mentions: [], context: [], attachments: [], freshContext: false };
const messages = [
  { id: "first", role: "user", text: "First prompt" },
  { id: "reply", role: "assistant", text: "Reply" },
  { id: "last", role: "user", text: "Last prompt" },
];

describe("native sent-prompt navigation", () => {
  it("leaves drafts, selected text and their attachments intact, and stops history after an edit even when undone", () => {
    const history = createPromptHistoryNavigation();
    const step = (draft: Draft, direction: "backward" | "forward" = "backward") =>
      history.step({ direction, messages, draft, atVisualEdge: true, hasSelection: false });
    const attached: Draft = {
      ...empty,
      attachments: [
        {
          id: "file",
          path: "/file.txt",
          name: "file.txt",
          type: "file",
          mimeType: "text/plain",
          sizeBytes: 1,
          modifiedAtMs: 0,
        },
      ],
    };
    expect(step(attached)).toBeNull();
    expect(attached.attachments).toHaveLength(1);
    expect(step({ ...empty, freshContext: true })).toBeNull();
    expect(step({ ...empty, text: "New draft" })).toBeNull();
    expect(
      history.step({
        direction: "backward",
        messages,
        draft: empty,
        atVisualEdge: true,
        hasSelection: true,
      }),
    ).toBeNull();
    const recalled = step(empty)!;
    expect(recalled.text).toBe("Last prompt");
    expect(
      history.step({
        direction: "backward",
        messages,
        draft: recalled,
        atVisualEdge: false,
        hasSelection: false,
      }),
    ).toBeNull();
    history.onEdit("Changed prompt");
    history.onEdit(recalled.text);
    expect(step(recalled)).toBeNull();
    expect(step(recalled, "forward")).toBeNull();
    const latest = step(empty)!;
    const earlier = step(latest)!;
    expect(earlier.text).toBe("First prompt");
    expect(step(step(earlier, "forward")!, "forward")).toBe(empty);
  });

  it("restores supported mention records without restoring source attachments and refuses to discard added context", () => {
    const thread = threadContextRecord(
      { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("source") },
      "Source thread",
    );
    const source = [
      {
        id: "mention",
        role: "user",
        text: `Read ${formatComposerContextReference(thread)}`,
        context: { version: 1 as const, records: [thread] },
      },
    ];
    const history = createPromptHistoryNavigation();
    const recalled = history.step({
      direction: "backward",
      messages: source,
      draft: empty,
      atVisualEdge: true,
      hasSelection: false,
    })!;
    expect(recalled.context).toEqual([thread]);
    expect(recalled.attachments).toEqual([]);
    const changed: Draft = {
      ...recalled,
      context: [thread, { ...thread, contextId: "thread:extra" as typeof thread.contextId }],
    };
    expect(
      history.step({
        direction: "forward",
        messages: source,
        draft: changed,
        atVisualEdge: true,
        hasSelection: false,
      }),
    ).toBeNull();
    expect(changed.context).toHaveLength(2);
  });
});
