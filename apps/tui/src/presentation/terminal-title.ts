import type { CliRenderer } from "@opentui/core";
import { createEffect, createMemo, onCleanup, type Accessor } from "solid-js";
import type { threadStatus } from "./thread-status.ts";

interface TerminalTitleState {
  readonly connection: string;
  readonly environment?: string | undefined;
  readonly project?: string | undefined;
  readonly thread?: string | undefined;
  readonly view?: string | undefined;
  readonly status: ReturnType<typeof threadStatus>;
  readonly runningTerminals?: number | undefined;
}

const labels: Record<TerminalTitleState["status"], string> = {
  ready: "Ready",
  working: "Working",
  approval: "Approval needed",
  input: "Input needed",
  request: "Guest request",
  waiting: "Waiting",
  limited: "Usage limit",
  failed: "Failed",
  done: "Done",
  woken: "Woken",
};

function titleText(value: string) {
  return Array.from(value)
    .filter((character) => {
      const code = character.codePointAt(0)!;
      return (
        code >= 32 &&
        !(code >= 127 && code <= 159) &&
        !(code >= 0x202a && code <= 0x202e) &&
        !(code >= 0x2066 && code <= 0x2069)
      );
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

export function formatTerminalTitle(state: TerminalTitleState) {
  const status =
    state.connection === "connected"
      ? labels[state.status]
      : Array.from(titleText(state.connection)).slice(0, 40).join("");
  const activity =
    state.connection === "connected" && (state.runningTerminals ?? 0) > 0
      ? " · Terminal running"
      : "";
  const context = [state.thread ?? state.view, state.project, state.environment]
    .map((value) => titleText(value ?? ""))
    .filter(Boolean)
    .join(" · ");
  const prefix = `[${status || "Disconnected"}${activity}] `;
  const suffix = " · T3 Code";
  const available = Math.max(0, 240 - prefix.length - suffix.length);
  return context
    ? `${prefix}${Array.from(context).slice(0, available).join("")}${suffix}`
    : `${prefix}T3 Code`;
}

export function createTerminalTitle(
  renderer: Pick<CliRenderer, "setTerminalTitle" | "currentControlState" | "isDestroyed">,
  state: Accessor<TerminalTitleState>,
) {
  const title = createMemo(() => formatTerminalTitle(state()));
  let previous: string | undefined;
  let active = true;
  const update = () => {
    const next = title();
    if (
      !active ||
      renderer.isDestroyed ||
      renderer.currentControlState === "explicit_suspended" ||
      previous === next
    )
      return;
    renderer.setTerminalTitle(next);
    previous = next;
  };
  createEffect(update);
  onCleanup(() => {
    active = false;
  });
  // A shell may set its own title while the renderer is suspended.
  return () => {
    previous = undefined;
    update();
  };
}

export function preserveTerminalTitle(output: Pick<NodeJS.WriteStream, "isTTY" | "write">) {
  if (!output.isTTY) return () => {};
  output.write("\x1b[22;0t");
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    output.write("\x1b[23;0t");
  };
}
