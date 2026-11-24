import { createEffect, createMemo, For } from "solid-js";
import type { TextRenderable } from "@opentui/core";
import { conversationFindChunks } from "./find-text.logic.ts";
import { theme } from "../theme/index.ts";

export function ConversationFindText(props: {
  segments: readonly string[];
  query: string;
  activeOccurrence?: number | undefined;
  wordWrap?: boolean | undefined;
  onActiveMatch?: ((node: TextRenderable, offset: number) => void) | undefined;
}) {
  let text: TextRenderable | undefined;
  let previous: { node: TextRenderable; offset: number; query: string } | undefined;
  const chunks = createMemo(() =>
    conversationFindChunks(props.segments, props.query, props.activeOccurrence),
  );
  // Match navigation needs the laid-out native text node, including its wrapped line positions.
  createEffect(() => {
    let offset = 0;
    let active = false;
    for (const chunk of chunks()) {
      if (chunk.active && text) {
        active = true;
        if (
          previous?.node !== text ||
          previous.offset !== offset ||
          previous.query !== props.query
        ) {
          previous = { node: text, offset, query: props.query };
          props.onActiveMatch?.(text, offset);
        }
        break;
      }
      offset += chunk.text.length;
    }
    if (!active) previous = undefined;
  });
  return (
    <text
      ref={(node) => {
        text = node;
      }}
      fg={theme.text}
      wrapMode={props.wordWrap === false ? "none" : "word"}
    >
      <For each={chunks()}>
        {(chunk) => (
          <span
            style={{
              fg: chunk.active ? "#111111" : chunk.match ? theme.primary : theme.text,
              bg: chunk.match ? (chunk.active ? theme.warning : theme.sidebarSelected) : undefined,
              bold: chunk.match,
            }}
          >
            {chunk.text}
          </span>
        )}
      </For>
    </text>
  );
}
