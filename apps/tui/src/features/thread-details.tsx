import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import type { ScrollBoxRenderable } from "@opentui/core";
import { WS_METHODS, type DiscoveredLocalServer } from "@t3tools/contracts";
import {
  deriveLatestContextWindowSnapshot,
  latestProviderTurnTokenUsage,
} from "@t3tools/client-runtime/state/context-window";
import { resolveProjectScripts } from "@t3tools/shared/projectScripts";
import { subscribe } from "../rpc/request.ts";
import type { Choice, FeatureProps } from "../ui/controller.ts";
import { useActiveKeyboard } from "../ui/keyboard.ts";
import { scrollbarOptions } from "../ui/scroll.ts";
import { theme } from "../theme/index.ts";
import type { WorkspaceContext } from "../workspace/types.ts";
import type { WorkspaceTab } from "../workspace/panel.tsx";
import { projectActions } from "../projects/actions.ts";
import { openInEnvironmentEditor } from "./editor.ts";
import { threadRelationships } from "./relationships.ts";
import { threadLinkChoices } from "./thread-links.ts";
import { ThreadLinksSummary } from "./thread-links-summary.tsx";

const detailItems = [
  { id: "environment", title: "Environment and worktree" },
  { id: "openIn", title: "Open in editor" },
  { id: "scripts", title: "Project scripts" },
  { id: "branch", title: "Branch and pull requests" },
  { id: "gitActions", title: "Git actions" },
  { id: "changes", title: "Changes" },
  { id: "servers", title: "Servers" },
  { id: "automations", title: "Automations" },
  { id: "lineage", title: "Lineage" },
  { id: "sideChats", title: "Side chats" },
  { id: "usage", title: "Usage limits", defaultVisible: false },
  { id: "context", title: "Context window", defaultVisible: false },
] as const;

export function configureThreadDetails(props: FeatureProps) {
  props.ui.choose("Thread detail rows", [
    ...detailItems.map((item) => {
      const visible =
        props.client.preferences().threadDetailsItems[item.id] ?? !("defaultVisible" in item);
      return {
        title: `${visible ? "Hide" : "Show"} ${item.title}`,
        run: () =>
          void props.ui.run(async () => {
            const current = props.client.preferences().threadDetailsItems;
            await props.client.updatePreferences({
              threadDetailsItems: { ...current, [item.id]: !visible },
            });
          }),
      };
    }),
    {
      title: "Reset detail row defaults",
      run: () =>
        void props.ui.run(
          () => props.client.updatePreferences({ threadDetailsItems: {} }),
          "Thread detail rows reset.",
        ),
    },
  ]);
}

export function ThreadDetailsPanel(
  props: WorkspaceContext & { openTab: (tab: WorkspaceTab) => void },
) {
  const [preferences, setPreferences] = createSignal(props.client.preferences());
  onCleanup(props.client.subscribePreferences(setPreferences));
  const [selected, setSelected] = createSignal(0);
  const [servers, setServers] = createSignal<ReadonlyArray<DiscoveredLocalServer>>([]);
  const [serverError, setServerError] = createSignal("");
  const environment = createMemo(() => props.state()?.environmentId);
  const connection = createMemo(() => props.state()?.connection);
  const target = createMemo(() => {
    const current = props.state();
    return (
      current?.shell?.threads.find((thread) => thread.id === current.selectedThreadId) ??
      current?.shell?.archivedThreads.find((thread) => thread.id === current.selectedThreadId)
    );
  });
  const visible = (id: string) =>
    preferences().threadDetailsItems[id] ?? !["usage", "context"].includes(id);
  const project = createMemo(() =>
    props.state()?.shell?.projects.find((entry) => entry.id === target()?.projectId),
  );
  const threadServers = createMemo(() =>
    servers().filter(
      (server) =>
        server.terminal?.threadId === target()?.id || server.agent?.threadId === target()?.id,
    ),
  );
  // Keep the visible thread's server rows synchronized with environment-owned port discovery.
  createEffect(() => {
    const id = environment();
    const phase = connection();
    const enabled = visible("servers");
    setServers([]);
    setServerError("");
    if (!id || !enabled || phase !== "connected") return;
    let active = true;
    const stop = subscribe(
      props.client,
      WS_METHODS.subscribeDiscoveredLocalServers,
      {},
      (value) => {
        if (active && environment() === id) setServers(value.servers);
      },
      (error) => {
        if (active) setServerError(error.message);
      },
    );
    onCleanup(() => {
      active = false;
      stop();
    });
  });
  const contextUsage = createMemo(() => {
    const projection = props.state()?.thread;
    if (!projection || projection.thread.id !== target()?.id) return null;
    const providerThread = projection.providerThreads.find(
      (thread) => thread.id === projection.thread.activeProviderThreadId,
    );
    return deriveLatestContextWindowSnapshot(
      projection.visibleTurnItems,
      latestProviderTurnTokenUsage(projection.providerTurns, projection, providerThread),
      providerThread,
    );
  });
  const rows = createMemo(() => {
    const thread = target();
    if (!thread) return [];
    const currentProject = project();
    const config = props.state()?.config;
    const provider = config?.providers.find(
      (provider) => provider.instanceId === thread.modelSelection.instanceId,
    );
    const local = props.status().local;
    const usage = contextUsage();
    const lineage = thread.lineage;
    const parent = lineage.parentThreadId;
    const family =
      props.state()?.shell?.threads.filter((entry) => entry.lineage.parentThreadId === thread.id) ??
      [];
    const choices: (Choice & { id: string; value: string })[] = [
      {
        id: "environment",
        title: "Environment and worktree",
        value: `${props.state()?.label ?? ""}\n${props.cwd() ?? "Workspace unavailable"}${thread.worktreePath ? "\nWorktree" : "\nMain checkout"}`,
        run: () => props.openTab("git"),
      },
      {
        id: "openIn",
        title: "Open in editor",
        value: "On the environment computer",
        run: () => {
          const cwd = props.cwd();
          if (cwd) openInEnvironmentEditor(props, cwd);
        },
      },
      {
        id: "scripts",
        title: "Project scripts",
        value:
          currentProject && config
            ? resolveProjectScripts(config.settings, currentProject)
                .map((script) => script.name)
                .join(" · ") || "No configured scripts"
            : "Project unavailable",
        run: () => {
          if (currentProject) projectActions(props, currentProject.id);
        },
      },
      {
        id: "branch",
        title: "Branch and pull requests",
        value: thread.branch ?? local?.refName ?? "No branch",
        run: () => props.ui.choose("Thread links", threadLinkChoices(props, thread)),
      },
      {
        id: "gitActions",
        title: "Git actions",
        value: "Branches · worktrees · commit · push · pull",
        run: () => props.openTab("git"),
      },
      {
        id: "changes",
        title: "Changes",
        value: local
          ? `${local.workingTree.files.length} files · +${local.workingTree.insertions} −${local.workingTree.deletions}`
          : "Status unavailable",
        run: () => props.openTab("changes"),
      },
      {
        id: "servers",
        title: "Servers",
        value:
          serverError() ||
          threadServers()
            .map(
              (server) =>
                `localhost:${server.port} · ${server.processName ?? (server.terminal ? "Terminal" : "Agent")}`,
            )
            .join("\n") ||
          "No thread servers detected",
        run: () => props.openTab("browser"),
      },
      {
        id: "automations",
        title: "Automations",
        value: "Scheduled work and delivery history",
        run: () => props.ui.openArea("schedules"),
      },
      {
        id: "lineage",
        title: "Lineage",
        value: `${parent ? `Parent: ${props.state()?.shell?.threads.find((entry) => entry.id === parent)?.title ?? parent}` : "Root conversation"} · ${family.length} related children`,
        run: () => void props.ui.run(() => threadRelationships(props, thread)),
      },
      {
        id: "sideChats",
        title: "Side chats",
        value: `${family.filter((entry) => entry.lineage.sideChat).length} related forks`,
        run: () => void props.ui.run(() => threadRelationships(props, thread)),
      },
      {
        id: "usage",
        title: "Usage limits",
        value:
          provider?.usageLimits?.unavailable?.message ??
          (provider?.usageLimits?.windows
            .map(
              (window) =>
                `${window.label}: ${Math.round(100 - window.usedPercent)}% left${window.resetsAt ? ` · resets ${window.resetsAt}` : ""}`,
            )
            .join("\n") ||
            "Usage limits unavailable"),
        run: () => props.ui.openArea("settings"),
      },
      {
        id: "context",
        title: "Context window",
        value: usage
          ? `${usage.usedTokens.toLocaleString()} tokens${usage.maxTokens ? ` / ${usage.maxTokens.toLocaleString()}` : ""}${usage.usedPercentage === null ? "" : ` · ${Math.round(usage.usedPercentage)}%`}`
          : "Context usage unavailable",
        run: () =>
          props.ui.text(
            "Context window",
            usage
              ? `${usage.usedTokens.toLocaleString()} tokens used${usage.maxTokens ? ` of ${usage.maxTokens.toLocaleString()}` : ""}`
              : "The provider has not reported context usage.",
          ),
      },
    ];
    return choices.filter((entry) => visible(entry.id));
  });
  let scroll: ScrollBoxRenderable | undefined;
  const activeIndex = () => Math.min(selected(), Math.max(0, rows().length - 1));
  useActiveKeyboard(
    () => props.focused && !props.ui.modal(),
    (event) => {
      if (event.name === "up" || event.name === "down") {
        const next = Math.max(
          0,
          Math.min(rows().length - 1, activeIndex() + (event.name === "down" ? 1 : -1)),
        );
        setSelected(next);
        scroll?.scrollChildIntoView(`thread-detail-${rows()[next]?.id}`);
      } else if (event.name === "return") rows()[activeIndex()]?.run();
      else if (event.name === "c") configureThreadDetails(props);
      else return;
      event.preventDefault();
      event.stopPropagation();
    },
  );
  return (
    <box flexGrow={1} minHeight={0} padding={1} onMouseDown={props.onFocus}>
      <text height={1} flexShrink={0} fg={theme.text} attributes={1}>
        Thread details
      </text>
      <text
        height={1}
        flexShrink={0}
        selectable={false}
        fg={theme.primary}
        onMouseDown={() => configureThreadDetails(props)}
      >
        Configure rows [C]
      </text>
      <Show
        when={target()}
        fallback={<text fg={theme.textMuted}>Select a conversation to see its details.</text>}
      >
        {(thread) => (
          <scrollbox
            ref={(value) => {
              scroll = value;
            }}
            scrollbarOptions={scrollbarOptions()}
            flexGrow={1}
            minHeight={0}
          >
            <For each={rows()}>
              {(row, index) => (
                <box
                  id={`thread-detail-${row.id}`}
                  marginTop={1}
                  flexDirection="column"
                  onMouseDown={() => {
                    setSelected(index());
                    row.run();
                  }}
                >
                  <text
                    selectable={false}
                    fg={props.focused && activeIndex() === index() ? theme.primary : theme.text}
                  >
                    {row.title}
                  </text>
                  <text fg={theme.textMuted} wrapMode="word">
                    {row.value}
                  </text>
                </box>
              )}
            </For>
            <Show when={visible("branch")}>
              <ThreadLinksSummary {...props} target={thread()} />
            </Show>
          </scrollbox>
        )}
      </Show>
      <text height={1} flexShrink={0} fg={theme.textMuted}>
        ↑↓ select · Enter open · C configure
      </text>
    </box>
  );
}
