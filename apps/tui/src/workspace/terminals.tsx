import { scrollbarOptions } from "../ui/scroll.ts";
import { WS_METHODS } from "@t3tools/contracts";
import { createEffect, createMemo, createSignal, For, Show, on, type Accessor } from "solid-js";
import { request } from "../rpc/request.ts";
import { theme } from "../theme/index.ts";
import { useActiveKeyboard } from "../ui/keyboard.ts";
import type { FeatureProps } from "../ui/controller.ts";
import { EmbeddedTerminal } from "../terminal/embedded.tsx";

export function TerminalsPanel(
  props: FeatureProps & {
    cwd: Accessor<string | undefined>;
    visible: boolean;
    requestedTerminalId?: string | undefined;
  },
) {
  const [selected, setSelected] = createSignal(0);
  const [attached, setAttached] = createSignal<string>();
  const selectTerminal = (id: string) => {
    setAttached(id);
    props.ui.selectTerminal?.(id);
  };
  const environment = createMemo(() => props.state()?.environmentId);
  const thread = createMemo(() => props.state()?.selectedThreadId);
  const metadata = createMemo(() => props.state()?.terminalMetadata);
  const connection = createMemo(() => props.state()?.connection);
  const terminals = createMemo(() =>
    connection() === "connected" && !metadata()?.error && !metadata()?.loading
      ? (metadata()?.terminals.filter((value) => value.threadId === thread()) ?? [])
      : [],
  );
  const failure = () =>
    metadata()?.error ??
    (connection() !== "connected" ? "Terminal status is unavailable while disconnected." : "");
  createEffect(
    on(
      () => [environment(), thread(), props.requestedTerminalId] as const,
      () => {
        setSelected(0);
        setAttached(props.requestedTerminalId);
      },
    ),
  );
  function destination() {
    const environmentId = environment();
    const threadId = thread();
    const cwd = props.cwd();
    if (!environmentId || !threadId || !cwd)
      throw new Error("Select a thread before opening its terminals.");
    return {
      threadId,
      cwd,
      check: () => {
        if (environment() !== environmentId || thread() !== threadId || props.cwd() !== cwd)
          throw new Error("The workspace changed. Open terminal actions again.");
      },
    };
  }
  function create() {
    const target = destination();
    props.ui.form({
      title: "New terminal",
      fields: [{ name: "name", label: "Terminal name", required: true }],
      submitLabel: "Open terminal",
      onSubmit: async ({ name = "" }) => {
        target.check();
        const terminalId = name.trim();
        await request(props.client, WS_METHODS.terminalOpen, {
          threadId: target.threadId,
          terminalId,
          cwd: target.cwd,
        });
        target.check();
        props.ui.openTerminal?.(terminalId);
      },
    });
  }
  function actions(value = terminals()[Math.max(0, Math.min(selected(), terminals().length - 1))]) {
    if (!value) return;
    const target = destination();
    const session = { threadId: target.threadId, terminalId: value.terminalId };
    props.ui.choose(value.label || value.terminalId, [
      {
        title: value.status === "running" ? "Attach terminal" : "Open terminal",
        run: () => {
          target.check();
          if (value.status === "running") selectTerminal(value.terminalId);
          else props.ui.openTerminal?.(value.terminalId);
        },
      },
      {
        title: "Clear terminal history",
        run: () =>
          props.ui.confirm(
            "Clear terminal history?",
            "Clears stored output for this terminal. Its running process stays active.",
            async () => {
              target.check();
              await request(props.client, WS_METHODS.terminalClear, session);
            },
            "Clear history",
          ),
      },
      {
        title: "Close terminal",
        description: value.hasRunningSubprocess
          ? "A command is still running in this terminal."
          : undefined,
        run: () =>
          props.ui.confirm(
            "Close terminal?",
            value.hasRunningSubprocess
              ? "This stops its shell and the command running inside it."
              : "This stops the terminal's shell; its history is kept.",
            async () => {
              target.check();
              await request(props.client, WS_METHODS.terminalClose, session);
            },
            "Close terminal",
          ),
      },
      {
        title: "Delete terminal and history",
        run: () =>
          props.ui.confirm(
            "Delete terminal and history?",
            "Stops this shell and permanently removes its saved output.",
            async () => {
              target.check();
              await request(props.client, WS_METHODS.terminalClose, {
                ...session,
                deleteHistory: true,
              });
            },
            "Delete terminal",
          ),
      },
    ]);
  }
  function manage() {
    const target = destination();
    const active = attached();
    props.ui.choose("Manage terminals", [
      ...terminals().map((value) => ({
        title: `${value.terminalId === active ? "● " : ""}${value.label || value.terminalId}`,
        description: value.status,
        run: () => {
          target.check();
          if (value.status === "running") selectTerminal(value.terminalId);
          else props.ui.openTerminal?.(value.terminalId);
        },
      })),
      {
        title: "New terminal…",
        run: () => {
          target.check();
          create();
        },
      },
      ...(active
        ? [
            {
              title: "Active terminal actions…",
              run: () => {
                target.check();
                const value = terminals().find((value) => value.terminalId === active);
                if (!value) throw new Error("The terminal changed. Open terminal actions again.");
                actions(value);
              },
            },
            {
              title: "Terminal list",
              run: () => {
                target.check();
                setAttached(undefined);
              },
            },
          ]
        : []),
      {
        title: "Placement and view…",
        run: () => {
          target.check();
          props.ui.terminalViewActions?.();
        },
      },
    ]);
  }
  useActiveKeyboard(
    () => props.visible && props.focused && !props.ui.modal(),
    (event) => {
      if (event.name === "f3") {
        void props.ui.run(async () => manage());
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (attached() || event.ctrl || event.meta) return;
      if (event.name === "up" || event.name === "down")
        setSelected((value) =>
          Math.max(0, Math.min(terminals().length - 1, value + (event.name === "up" ? -1 : 1))),
        );
      else if (event.name === "return") actions();
      else if (event.name === "n") {
        void props.ui.run(async () => create());
      } else return;
      event.preventDefault();
      event.stopPropagation();
    },
  );
  return (
    <box visible={props.visible} flexGrow={1} minHeight={0} paddingX={1}>
      <box height={2} flexDirection="row" alignItems="center">
        <text fg={theme.text} flexGrow={1}>
          Terminals · Manage F3
        </text>
        <text
          selectable={false}
          fg={theme.primary}
          onMouseDown={() => void props.ui.run(async () => create())}
        >
          New [N]
        </text>
        <text
          selectable={false}
          fg={theme.primary}
          onMouseDown={() => props.ui.terminalViewActions?.()}
        >
          View…
        </text>
      </box>
      <Show when={failure()}>
        <text fg={theme.error} wrapMode="word">
          {failure()}
        </text>
      </Show>
      <Show when={props.visible && attached() && props.cwd() && thread()} keyed>
        {(_key) => (
          <box flexDirection="row" flexWrap="wrap" gap={1} flexShrink={0} minHeight={1}>
            <For each={terminals()}>
              {(value) => (
                <text
                  selectable={false}
                  fg={
                    value.hasRunningSubprocess
                      ? theme.error
                      : attached() === value.terminalId
                        ? theme.primary
                        : theme.textMuted
                  }
                  onMouseDown={() => {
                    props.onFocus();
                    selectTerminal(value.terminalId);
                  }}
                >
                  {value.hasRunningSubprocess ? "● " : ""}
                  {value.label || value.terminalId}
                </text>
              )}
            </For>
            <text
              selectable={false}
              fg={theme.primary}
              onMouseDown={() =>
                actions(terminals().find((value) => value.terminalId === attached()))
              }
            >
              Actions…
            </text>
            <text
              selectable={false}
              fg={theme.textMuted}
              onMouseDown={() => setAttached(undefined)}
            >
              List
            </text>
          </box>
        )}
      </Show>
      <Show
        when={
          props.visible && attached() && props.cwd() && `${environment()}/${thread()}/${attached()}`
        }
        keyed
      >
        {(_key) => <EmbeddedTerminal {...props} terminalId={attached()!} cwd={props.cwd()!} />}
      </Show>
      <scrollbox
        visible={!attached()}
        scrollbarOptions={scrollbarOptions()}
        flexGrow={1}
        minHeight={0}
      >
        <For each={terminals()}>
          {(value, index) => (
            <box
              paddingY={1}
              backgroundColor={selected() === index() ? theme.backgroundElement : theme.background}
              onMouseDown={() => {
                props.onFocus();
                setSelected(index());
                actions(value);
              }}
            >
              <text selectable={false} fg={theme.text}>
                {value.label || value.terminalId}
              </text>
              <text
                selectable={false}
                fg={value.hasRunningSubprocess ? theme.error : theme.textMuted}
              >
                {value.status}
                {value.hasRunningSubprocess ? " · ● Command running" : ""}
              </text>
              <text selectable={false} fg={theme.textMuted} truncate>
                {value.cwd}
              </text>
            </box>
          )}
        </For>
        <Show when={metadata()?.loading || !metadata()}>
          <text fg={theme.textMuted}>Loading terminal status…</text>
        </Show>
        <Show when={metadata() && !metadata()?.loading && !failure() && !terminals().length}>
          <text fg={theme.textMuted} wrapMode="word">
            {thread()
              ? "No terminals in this thread. Open a terminal with N or Ctrl+T."
              : "Select a thread to manage its terminals."}
          </text>
        </Show>
      </scrollbox>
      <text height={1} fg={theme.textMuted} truncate>
        {attached()
          ? "^] chat · ^F find · F2 output · shift+drag select"
          : "↑↓ select · Enter actions · N new · Ctrl+T quick attach"}
      </text>
    </box>
  );
}
