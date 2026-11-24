import {
  EmbeddedTerminalRenderable,
  type BoxRenderable,
  type ScrollBoxRenderable,
} from "@opentui/core";
import { extend, useRenderer } from "@opentui/solid";
import {
  COMPOSER_CONTEXT_TERMINAL_TEXT_MAX_CHARS,
  type KnownComposerContextRecord,
} from "@t3tools/contracts";
import {
  appendTerminalOutput,
  EMPTY_TERMINAL_OUTPUT,
  terminalOutputPlainText,
} from "@t3tools/shared/terminalOutput";
import { toKindScopedComposerContextId } from "@t3tools/shared/composerContextReferences";
import { findThreadSearchOccurrences } from "@t3tools/shared/threadSearch";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { createEffect, createMemo, createSignal, onCleanup, on, Show } from "solid-js";
import { ConversationFindText } from "../conversation/find-text.tsx";
import { copyTerminalText } from "../presentation/terminal.ts";
import type { FeatureProps } from "../ui/controller.ts";
import { useActiveKeyboard } from "../ui/keyboard.ts";
import { createTextMatchRevealer } from "../ui/reveal-match.ts";
import { scrollbarOptions } from "../ui/scroll.ts";
import { theme } from "../theme/index.ts";
import { attachEmbeddedTerminal } from "./embedded-session.ts";

declare module "@opentui/solid" {
  interface OpenTUIComponents {
    thread_terminal: typeof EmbeddedTerminalRenderable;
  }
}
extend({ thread_terminal: EmbeddedTerminalRenderable });

export function EmbeddedTerminal(props: FeatureProps & { terminalId: string; cwd: string }) {
  const renderer = useRenderer();
  const environmentId = props.state()?.environmentId;
  const threadId = props.state()?.selectedThreadId;
  const terminalId = props.terminalId;
  const cwd = props.cwd;
  const [node, setNode] = createSignal<EmbeddedTerminalRenderable>();
  const [status, setStatus] = createSignal("Connecting…");
  const [error, setError] = createSignal("");
  const [revision, setRevision] = createSignal(0);
  const [output, setOutput] = createSignal(EMPTY_TERMINAL_OUTPUT);
  const [finding, setFinding] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [occurrence, setOccurrence] = createSignal(0);
  const [selection, setSelection] = createSignal<{
    text: string;
    lineStart: number;
    lineEnd: number;
    source: string;
    offset: number;
    total: number;
    history: string;
    columns: number;
    rows: number;
  }>();
  const [localGrid, setLocalGrid] = createSignal({ cols: 80, rows: 24 });
  const [sharedGrid, setSharedGrid] = createSignal<{ cols: number; rows: number }>();
  const effectiveGrid = createMemo(() => ({
    cols: Math.min(localGrid().cols, sharedGrid()?.cols ?? localGrid().cols),
    rows: Math.min(localGrid().rows, sharedGrid()?.rows ?? localGrid().rows),
  }));
  let viewport: BoxRenderable | undefined;
  function measureViewport() {
    if (!viewport || viewport.isDestroyed) return;
    const cols = Math.min(1000, Math.max(1, viewport.width));
    const rows = Math.min(500, Math.max(1, viewport.height));
    if (localGrid().cols === cols && localGrid().rows === rows) return;
    setLocalGrid({ cols, rows });
    session?.resize(cols, rows);
  }
  const connection = createMemo(() => props.state()?.connection);
  const sourceEnvironment = createMemo(() => props.state()?.environmentId);
  const sourceThread = createMemo(() => props.state()?.selectedThreadId);
  const text = createMemo(() => terminalOutputPlainText(output().text));
  const matches = createMemo(() => findThreadSearchOccurrences(text(), query()));
  const activeMatch = () => Math.min(occurrence(), Math.max(0, matches().length - 1));
  let searchScroll: ScrollBoxRenderable | undefined;
  const reveal = createTextMatchRevealer(renderer, () => searchScroll, finding);
  let session: ReturnType<typeof attachEmbeddedTerminal> | undefined;
  const pendingOutput: Array<{
    data: string;
    resize: boolean;
    snapshot: boolean;
    grid?: { cols: number; rows: number } | undefined;
  }> = [];
  let pendingLiveChars = 0;
  let flushingOutput = false;
  let outputOverflow = false;
  function flushTerminalOutput() {
    const emulator = node();
    if (!emulator || emulator.isDestroyed || flushingOutput || !current()) return;
    flushingOutput = true;
    try {
      while (pendingOutput.length) {
        const next = pendingOutput[0]!;
        if (next.resize) setSharedGrid(next.grid);
        const grid = effectiveGrid();
        if (emulator.width !== grid.cols || emulator.height !== grid.rows) return;
        pendingOutput.shift();
        if (!next.snapshot) pendingLiveChars -= next.data.length;
        if (next.data) emulator.write(next.data);
      }
    } finally {
      flushingOutput = false;
    }
  }
  function queueTerminalOutput(
    data: string,
    resize = false,
    grid?: { cols: number; rows: number },
    snapshot = false,
  ) {
    if (outputOverflow) return;
    if (!snapshot) pendingLiveChars += data.length;
    if (pendingLiveChars > 256 * 1024 || pendingOutput.length >= 4096) {
      outputOverflow = true;
      pendingOutput.length = 0;
      pendingLiveChars = 0;
      session?.dispose();
      setError(
        "Terminal output exceeded the view buffer. Reconnect to reload up to 256 KiB of retained history.",
      );
      return;
    }
    pendingOutput.push({ data, resize, grid, snapshot });
    flushTerminalOutput();
  }
  let disposed = false;
  const current = () =>
    !disposed &&
    props.state()?.environmentId === environmentId &&
    props.state()?.selectedThreadId === threadId;
  onCleanup(() => {
    disposed = true;
  });
  // Each mounted emulator attaches only to its captured environment/thread and current connection.
  createEffect(
    on(
      () =>
        [
          revision(),
          node(),
          connection(),
          sourceEnvironment(),
          sourceThread(),
          props.ui.terminalSuspended?.(),
        ] as const,
      ([, emulator, connection, , , suspended]) => {
        if (!emulator || !threadId || !current() || suspended) return;
        setError("");
        setStatus(connection === "connected" ? "Connecting…" : "Disconnected");
        if (connection !== "connected") return;
        try {
          outputOverflow = false;
          pendingOutput.length = 0;
          pendingLiveChars = 0;
          const attached = attachEmbeddedTerminal({
            client: props.client,
            threadId,
            terminalId,
            cwd,
            cols: localGrid().cols,
            rows: localGrid().rows,
            onEvent(event) {
              if (!current() || emulator.isDestroyed || outputOverflow) return;
              switch (event.type) {
                case "snapshot":
                case "restarted":
                  pendingOutput.length = 0;
                  pendingLiveChars = 0;
                  setSelection(undefined);
                  queueTerminalOutput(
                    "\x1bc" + event.snapshot.history,
                    true,
                    event.snapshot.cols && event.snapshot.rows
                      ? { cols: event.snapshot.cols, rows: event.snapshot.rows }
                      : undefined,
                    true,
                  );
                  setOutput(
                    appendTerminalOutput(EMPTY_TERMINAL_OUTPUT, event.snapshot.history, 256 * 1024),
                  );
                  setStatus(event.snapshot.status);
                  setError(event.snapshot.error ?? "");
                  break;
                case "output":
                  queueTerminalOutput(event.data);
                  setOutput((previous) => appendTerminalOutput(previous, event.data, 256 * 1024));
                  break;
                case "cleared":
                  queueTerminalOutput("\x1bc");
                  setOutput(EMPTY_TERMINAL_OUTPUT);
                  break;
                case "exited":
                case "closed":
                  setStatus("Exited · use terminal actions to reopen");
                  break;
                case "error":
                  setError(event.message);
                  break;
                case "activity":
                  if (event.cols && event.rows)
                    queueTerminalOutput("", true, { cols: event.cols, rows: event.rows });
                  break;
              }
            },
            onError(cause) {
              if (current()) setError(cause.message);
            },
          });
          session = attached;
          if (outputOverflow) attached.dispose();
          onCleanup(() => {
            attached.dispose();
            pendingOutput.length = 0;
            pendingLiveChars = 0;
            if (session === attached) session = undefined;
          });
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      },
    ),
  );
  // Native focus belongs to the emulator only while no menu or scrollback search owns input.
  createEffect(() => {
    const emulator = node();
    if (!emulator || emulator.isDestroyed) return;
    if (
      props.focused &&
      !props.ui.modal() &&
      !props.ui.terminalSuspended?.() &&
      !finding() &&
      status() === "running" &&
      !error()
    )
      emulator.focus();
    else emulator.blur();
  });
  function find() {
    setFinding(true);
    props.ui.form({
      title: "Find in terminal scrollback",
      description:
        "Search retained output (up to 256 KiB). Full-screen terminal apps may rewrite earlier text.",
      fields: [{ name: "query", label: "Find", value: query(), required: true }],
      onSubmit: async ({ query: value = "" }) => {
        if (!current()) throw new Error("The terminal changed. Open Find again.");
        setQuery(value);
        setOccurrence(0);
      },
    });
  }
  const currentSelection = () =>
    node()?.getSelectedText() ||
    (finding() ? renderer.getSelection()?.getSelectedText() : "") ||
    "";
  function readSelection() {
    const emulator = node();
    const selected = renderer.getSelection();
    if (
      finding() ||
      pendingOutput.length > 0 ||
      !emulator ||
      !selected?.selectedRenderables.includes(emulator) ||
      !emulator.getSelectedText()
    )
      return;
    const source = emulator.screen();
    const scroll = emulator.getScroll();
    const row = (y: number) =>
      Math.max(0, Math.min(emulator.height - 1, Math.trunc(y - emulator.y)));
    const first = Math.min(row(selected.anchor.y), row(selected.focus.y));
    const last = Math.max(row(selected.anchor.y), row(selected.focus.y));
    const firstVisible = Math.max(0, scroll.total - scroll.visible - scroll.offset);
    return {
      text: emulator.getSelectedText(),
      lineStart: firstVisible + first + 1,
      lineEnd: firstVisible + last + 1,
      source: source.text,
      offset: scroll.offset,
      total: scroll.total,
      history: output().text,
      columns: source.columns,
      rows: source.rows,
    };
  }
  function capture() {
    if (!current()) return;
    if (finding())
      return props.ui.notify("Select output in the live terminal to capture its source rows.");
    const selected = selection();
    if (!selected?.text.trim()) return props.ui.notify("Select terminal output first.");
    const value = selected.text;
    if (value.length > COMPOSER_CONTEXT_TERMINAL_TEXT_MAX_CHARS)
      return props.ui.notify("Select less than 64,000 characters for message context.", true);
    const emulator = node();
    const source = emulator?.screen();
    if (
      !source ||
      pendingOutput.length > 0 ||
      source.text !== selected.source ||
      source.columns !== selected.columns ||
      source.rows !== selected.rows ||
      emulator?.getScroll().offset !== selected.offset ||
      emulator?.getScroll().total !== selected.total ||
      output().text !== selected.history
    )
      return props.ui.notify("The selected output changed. Select it again.", true);
    const record: KnownComposerContextRecord = {
      version: 1,
      kind: "terminal",
      contextId: toKindScopedComposerContextId("terminal", SecureRandom.uuidV4Unsafe()),
      label: `Terminal: ${terminalId}`.slice(0, 200),
      terminalId,
      terminalLabel: terminalId.slice(0, 255),
      lineStart: selected.lineStart,
      lineEnd: selected.lineEnd,
      text: value,
    };
    props.ui.addComposerContext?.(record);
  }
  function actions() {
    const selectedText = currentSelection();
    setSelection(readSelection());
    props.ui.choose("Terminal output", [
      { title: "Find in scrollback", run: find },
      {
        title: "Copy selected output",
        run: () => props.ui.notify(copyTerminalText(renderer, selectedText).message),
      },
      { title: "Add selected output to message", run: capture },
      {
        title: "Output links…",
        run: () => {
          const links = [...new Set(text().match(/https?:\/\/[^\s<>\u0000-\u001f]+/g) ?? [])].slice(
            0,
            200,
          );
          if (!links.length) return props.ui.notify("No web links in retained terminal output.");
          props.ui.choose(
            "Terminal output links",
            links.map((url) => ({
              title: url,
              description: "Open in this device's browser",
              run: () => {
                if (current()) props.ui.openBrowser?.(url);
              },
            })),
          );
        },
      },
      {
        title: "Reconnect terminal view",
        description: "Reattaches without restarting a stopped shell.",
        run: () => {
          if (current()) setRevision((value) => value + 1);
        },
      },
    ]);
  }
  useActiveKeyboard(
    () => props.focused && !props.ui.modal(),
    (event) => {
      if (event.ctrl && event.name === "f") find();
      else if (event.name === "f2") actions();
      else if (finding() && event.ctrl && event.name === "g")
        setOccurrence(
          (value) =>
            (value + (event.shift ? -1 : 1) + matches().length) % Math.max(1, matches().length),
        );
      else if (finding() && event.name === "escape") setFinding(false);
      else return;
      event.preventDefault();
      event.stopPropagation();
    },
  );
  return (
    <box flexGrow={1} minHeight={0} minWidth={0} onMouseDown={props.onFocus}>
      <box flexDirection="row" gap={1} minHeight={1} flexShrink={0}>
        <text fg={theme.textMuted} flexGrow={1} minWidth={0} height={1} truncate>
          {status()}
        </text>
        <text selectable={false} fg={theme.primary} onMouseDown={actions}>
          Output F2
        </text>
        <Show when={finding()}>
          <text selectable={false} fg={theme.primary} onMouseDown={() => setFinding(false)}>
            Live · Esc
          </text>
        </Show>
      </box>
      <Show when={error()}>
        <text fg={theme.error} wrapMode="word">
          {error()}
        </text>
      </Show>
      <box flexGrow={1} minHeight={1} minWidth={1}>
        <box
          ref={(value) => {
            viewport = value;
          }}
          flexGrow={1}
          minHeight={1}
          minWidth={1}
          onSizeChange={measureViewport}
        >
          <thread_terminal
            ref={setNode}
            width={effectiveGrid().cols}
            height={effectiveGrid().rows}
            flexShrink={0}
            maxScrollback={5000}
            selectable
            onData={(bytes, source) => session?.write(bytes, source === "response")}
            onTerminalResize={flushTerminalOutput}
          />
        </box>
        <Show when={finding()}>
          {/* Keep the live emulator laid out so peer resizes and output can drain behind Find. */}
          <box
            position="absolute"
            left={0}
            top={0}
            width="100%"
            height="100%"
            zIndex={1}
            backgroundColor={theme.background}
          >
            <text fg={theme.textMuted} height={1} truncate>
              {query()} · {matches().length ? activeMatch() + 1 : 0}/{matches().length} · ^G next ·{" "}
              {output().truncated ? "Older output truncated" : "Retained output"}
            </text>
            <scrollbox
              ref={(value) => {
                searchScroll = value;
              }}
              scrollbarOptions={scrollbarOptions()}
              flexGrow={1}
              minHeight={0}
            >
              <ConversationFindText
                segments={[text()]}
                query={query()}
                activeOccurrence={activeMatch()}
                onActiveMatch={reveal}
              />
            </scrollbox>
          </box>
        </Show>
      </box>
    </box>
  );
}
