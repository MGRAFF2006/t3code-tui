import type { TextareaRenderable } from "@opentui/core";
import {
  buildComposerPromptHistoryEntries,
  stepComposerPromptHistory,
  type ComposerPromptHistoryPosition,
} from "@t3tools/client-runtime/composer-prompt-history";
import type { Draft } from "./draft.ts";

type Direction = "backward" | "forward";

export function isPromptHistoryCaretAtEdge(editor: TextareaRenderable, direction: Direction) {
  if (editor.hasSelection()) return false;
  const row = editor.scrollY + editor.visualCursor.visualRow;
  return direction === "backward"
    ? row === 0
    : row === editor.editorView.getTotalVirtualLineCount() - 1;
}

export function createPromptHistoryNavigation() {
  let position: ComposerPromptHistoryPosition | null = null;
  let recalledContext: Draft["context"] = [];
  let originalDraft: Draft | null = null;

  function reset() {
    position = null;
    recalledContext = [];
    originalDraft = null;
  }

  return {
    reset,
    onEdit: (text: string) => {
      if (position && position.recalled !== text) reset();
    },
    step(input: {
      direction: Direction;
      messages: Parameters<typeof buildComposerPromptHistoryEntries>[0];
      draft: Draft;
      atVisualEdge: boolean;
      hasSelection: boolean;
    }): Draft | null {
      const { draft } = input;
      if (
        draft.attachments.length > 0 ||
        draft.mentions.length > 0 ||
        draft.freshContext ||
        (position !== null &&
          (position.recalled !== draft.text ||
            JSON.stringify(draft.context) !== JSON.stringify(recalledContext)))
      ) {
        reset();
        return null;
      }
      if (!input.atVisualEdge || input.hasSelection) return null;
      if (position === null && (draft.text.length > 0 || draft.context.length > 0)) return null;
      const step = stepComposerPromptHistory({
        direction: input.direction,
        entries: buildComposerPromptHistoryEntries(input.messages),
        position,
        currentPrompt: draft.text,
      });
      if (!step) return null;
      if (position === null) originalDraft = draft;
      position = step.position;
      if (!position) {
        const restored = originalDraft;
        reset();
        return restored;
      }
      recalledContext = [...step.mentions.threadContexts, ...step.mentions.environmentContexts];
      return {
        text: step.prompt,
        mentions: [],
        context: recalledContext,
        attachments: [],
        freshContext: false,
      };
    },
  };
}
