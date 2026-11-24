import { createMemo, createResource, createSignal, For, Show } from "solid-js";
import {
  CommandId,
  ORCHESTRATION_V2_WS_METHODS,
  ThreadId,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { resolveLatestMergeBackRun } from "@t3tools/client-runtime/state/thread-workflows";
import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/shell";
import { request } from "../rpc/request.ts";
import type { FeatureProps } from "../ui/controller.ts";
import { draftStore } from "../conversation/draft-storage.ts";
import { theme } from "../theme/index.ts";

export function sideChatParent(thread: Pick<OrchestrationV2ThreadShell, "id" | "lineage">) {
  return thread.lineage.sideChat && thread.lineage.parentThreadId
    ? thread.lineage.parentThreadId
    : thread.id;
}

const closedTabs = new Set<string>();

export function createSideChats(props: FeatureProps & { navigationVersion?: () => number }) {
  const scope = createMemo(() => {
    const state = props.state();
    const thread = state?.thread?.thread;
    return state?.environmentId && thread
      ? JSON.stringify([state.environmentId, sideChatParent(thread)])
      : null;
  });
  const [hidden, setHiddenState] = createSignal<ReadonlySet<string>>(new Set(closedTabs));
  const setHidden = (value: ReadonlySet<string>) => {
    closedTabs.clear();
    for (const key of [...value].slice(-500)) closedTabs.add(key);
    setHiddenState(new Set(closedTabs));
  };
  const topology = createMemo(() => {
    const currentScope = scope();
    if (!currentScope) return null;
    const parent = sideChatParent(props.state()!.thread!.thread);
    const ids = props
      .state()
      ?.shell?.threads.filter(
        (thread) => thread.lineage.sideChat && thread.lineage.parentThreadId === parent,
      )
      .map((thread) => [thread.id, thread.archivedAt, thread.deletedAt]);
    return JSON.stringify([
      currentScope,
      ids,
      props.state()?.thread?.thread.lineage.sideChat ? props.state()?.selectedThreadId : null,
    ]);
  });
  const [family, { refetch }] = createResource(topology, async () => {
    const state = props.state()!;
    const environment = state.environmentId!;
    const parent = sideChatParent(state.thread!.thread);
    try {
      const result = await request(props.client, ORCHESTRATION_V2_WS_METHODS.getThreadFamily, {
        threadId: parent,
      });
      return { environment, parent, threads: result.threads, error: null };
    } catch (error) {
      return {
        environment,
        parent,
        threads: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
  const current = () => {
    const value = family();
    return value && JSON.stringify([value.environment, value.parent]) === scope() ? value : null;
  };
  const children = () =>
    current()?.threads.filter(
      (thread) =>
        thread.deletedAt === null &&
        thread.archivedAt === null &&
        thread.lineage.sideChat &&
        thread.lineage.parentThreadId === current()!.parent,
    ) ?? [];
  const key = (id: string) => `${scope()}/${id}`;
  const visible = () =>
    children().filter(
      (thread) => !hidden().has(key(thread.id)) || thread.id === props.state()?.selectedThreadId,
    );
  function navigation(threadId: string) {
    const captured = current();
    const version = props.navigationVersion?.();
    return () => {
      const latest = current();
      if (
        version !== props.navigationVersion?.() ||
        !captured ||
        !latest ||
        latest.environment !== captured.environment ||
        latest.parent !== captured.parent ||
        props.state()?.connection !== "connected" ||
        !latest.threads.some(
          (thread) =>
            thread.id === threadId &&
            thread.deletedAt === null &&
            thread.archivedAt === null &&
            (thread.id === latest.parent ||
              (thread.lineage.sideChat && thread.lineage.parentThreadId === latest.parent)),
        )
      ) {
        props.ui.notify("The conversation or environment changed. Reopen side chats.", true);
        return;
      }
      props.ui.openThread(threadId);
    };
  }
  function actions() {
    const captured = current();
    const version = props.navigationVersion?.();
    if (!captured) {
      props.ui.notify("Side chats are loading. Try Refresh.", true);
      return;
    }
    const guard = () => {
      if (
        version !== props.navigationVersion?.() ||
        scope() !== JSON.stringify([captured.environment, captured.parent]) ||
        props.state()?.connection !== "connected"
      )
        throw new Error("The conversation or environment changed. Reopen side chats.");
    };
    const send = async (command: OrchestrationV2Command) => {
      guard();
      let allowed = false;
      const stop = props.client.observePermission(
        ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
        command,
        (value) => {
          allowed = value;
        },
      );
      const permitted = allowed;
      stop();
      if (!permitted) throw new Error("This connection cannot change side chats.");
      await request(props.client, ORCHESTRATION_V2_WS_METHODS.dispatchCommand, command);
      if (command.type !== "thread.delete") guard();
      if (props.state()?.environmentId === captured.environment) await refetch();
      if (command.type !== "thread.delete") guard();
    };
    const reopen = (thread: OrchestrationV2ThreadShell) => {
      guard();
      const next = new Set(hidden());
      next.delete(key(thread.id));
      setHidden(next);
      props.ui.openThread(thread.id);
    };
    const close = async (thread: OrchestrationV2ThreadShell) => {
      guard();
      const selected = props.state()?.selectedThreadId === thread.id;
      if (selected && !(await props.ui.beforeNavigate())) return;
      guard();
      const next = new Set(hidden());
      next.add(key(thread.id));
      setHidden(next);
      if (selected && props.state()?.selectedThreadId === thread.id)
        props.ui.openThread(captured.parent);
    };
    const remove = (thread: OrchestrationV2ThreadShell) =>
      props.ui.confirm(
        "Delete side chat",
        `Permanently delete “${thread.title}” and its conversation history. Closing the tab preserves it instead.`,
        async () => {
          guard();
          if (props.state()?.selectedThreadId === thread.id && !(await props.ui.beforeNavigate()))
            return;
          guard();
          await send({
            type: "thread.delete",
            commandId: CommandId.make(SecureRandom.uuidV4Unsafe()),
            threadId: thread.id,
          });
          const store = draftStore(props.client.localStateDirectory, (message) =>
            props.ui.notify(message, true),
          );
          await store.ready;
          store.save(`${captured.environment}/${thread.id}`, {
            text: "",
            mentions: [],
            context: [],
            attachments: [],
            freshContext: false,
          });
          await store.flush();
          if (
            props.state()?.environmentId === captured.environment &&
            version === props.navigationVersion?.() &&
            props.state()?.selectedThreadId === thread.id
          )
            props.ui.openThread(captured.parent);
        },
        "Delete permanently",
      );
    const menu = (thread: OrchestrationV2ThreadShell) =>
      props.ui.choose(thread.title, [
        { title: "Open side chat", run: () => reopen(thread) },
        {
          title: "Close side-chat tab",
          description: "Keep its conversation and draft; reopen it from Side chats.",
          run: () => void props.ui.run(() => close(thread)),
        },
        {
          title: "Bring back to main…",
          run: () =>
            void props.ui.run(async () => {
              guard();
              const parent =
                props.state()?.shell?.threads.find((entry) => entry.id === captured.parent) ??
                captured.threads.find((entry) => entry.id === captured.parent);
              if (
                !parent ||
                threadRuntimeIsActive(presentThreadShell(captured.environment, parent).runtime)
              )
                throw new Error("Available when the main thread is idle.");
              const projection = await request(
                props.client,
                ORCHESTRATION_V2_WS_METHODS.getThreadProjection,
                { threadId: thread.id },
              );
              guard();
              const run = resolveLatestMergeBackRun(projection);
              if (!run) throw new Error("Bring back is available after a finished reply.");
              props.ui.confirm(
                "Bring side chat back",
                `Add “${thread.title}” to the main thread's next message.`,
                async () => {
                  guard();
                  await send({
                    type: "thread.merge_back",
                    commandId: CommandId.make(SecureRandom.uuidV4Unsafe()),
                    sourceThreadId: thread.id,
                    targetThreadId: captured.parent,
                    sourcePoint: { type: "run", runId: run.id },
                    createdBy: "user",
                    creationSource: "web",
                  });
                  props.ui.notify("Side chat added to the main thread's next message.");
                },
                "Bring back",
              );
            }),
        },
        { title: "Delete side chat…", run: () => remove(thread) },
      ]);
    props.ui.choose("Side chats", [
      {
        title: "Main conversation",
        run: () => {
          guard();
          props.ui.openThread(captured.parent);
        },
      },
      {
        title: "New side chat…",
        run: () =>
          props.ui.form({
            title: "New side chat",
            fields: [{ name: "title", label: "Title", value: "Side chat", required: true }],
            onSubmit: async ({ title = "" }) => {
              guard();
              const id = ThreadId.make(SecureRandom.uuidV4Unsafe());
              await send({
                type: "thread.fork",
                commandId: CommandId.make(SecureRandom.uuidV4Unsafe()),
                sourceThreadId: captured.parent,
                targetThreadId: id,
                sourcePoint: { type: "latest_stable" },
                title: title.trim(),
                sideChat: true,
                createdBy: "user",
                creationSource: "web",
              });
              props.ui.openThread(id);
            },
          }),
      },
      ...children().map((thread) => ({
        title: `${hidden().has(key(thread.id)) ? "Reopen: " : ""}${thread.title}`,
        description:
          thread.id === props.state()?.selectedThreadId ? "Current side chat" : "Side chat",
        run: () => {
          guard();
          menu(thread);
        },
      })),
      {
        title: "Refresh side chats",
        run: () =>
          void props.ui.run(async () => {
            guard();
            await refetch();
            guard();
          }),
      },
    ]);
  }
  return {
    family,
    current,
    children,
    visible,
    actions,
    refresh: refetch,
    error: () => current()?.error,
    navigation,
  };
}

export function SideChatTabs(
  props: FeatureProps & { controller?: ReturnType<typeof createSideChats> },
) {
  const chats = props.controller ?? createSideChats(props);
  return (
    <box flexShrink={0}>
      <box height={1} flexDirection="row" gap={2}>
        <text selectable={false} fg={theme.primary} onMouseDown={chats.actions}>
          Side chats ▾
        </text>
        <Show when={chats.current()}>
          {(current) => (
            <text
              selectable={false}
              fg={
                props.state()?.selectedThreadId === current().parent ? theme.text : theme.textMuted
              }
              onMouseDown={chats.navigation(current().parent)}
            >
              Main
            </text>
          )}
        </Show>
        <For each={chats.visible()}>
          {(thread) => (
            <text
              selectable={false}
              truncate
              fg={props.state()?.selectedThreadId === thread.id ? theme.primary : theme.textMuted}
              onMouseDown={chats.navigation(thread.id)}
            >
              {thread.title}
            </text>
          )}
        </For>
      </box>
      <Show when={chats.error()}>
        <text
          selectable={false}
          height={1}
          truncate
          fg={theme.error}
          onMouseDown={() =>
            void props.ui.run(async () => {
              await chats.refresh();
            })
          }
        >
          Side chats unavailable · Retry
        </text>
      </Show>
    </box>
  );
}
