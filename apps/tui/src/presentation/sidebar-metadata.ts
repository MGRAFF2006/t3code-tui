import { createSignal, onCleanup } from "solid-js";
import type { EnvironmentId, OrchestrationV2ThreadShell, ServerProvider } from "@t3tools/contracts";
import { getProviderClient } from "@t3tools/client-runtime/provider-clients";
import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import { hasUnseenCompletion } from "@t3tools/client-runtime/state/thread-settled";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import {
  normalizeProviderAccentColor,
  providerInstanceInitials,
  resolveProviderInstanceDisplayName,
} from "@t3tools/client-runtime/state/provider-instance-display";
import {
  resolveThreadCurrentPullRequestLink,
  threadPullRequestsOf,
  visibleThreadPullRequests,
} from "@t3tools/client-runtime/thread-pull-requests";
import { draftStore } from "../conversation/draft-storage.ts";
import { hasDraftContent } from "../conversation/draft.ts";
import type { TuiClient } from "../runtime/client.ts";
import { theme, themeMode } from "../theme/index.ts";
import { icon } from "./icons.ts";
import { threadStatus } from "./thread-status.ts";

const providerSymbols: Record<string, string> = {
  codex: "CX",
  claudeAgent: "CL",
  cursor: "CU",
  grok: "GR",
  opencode: "OC",
  antigravity: "AG",
  kiro: "KI",
  pi: "PI",
  muse: "MU",
  fx: "FX",
};

export function threadProviderIdentity(
  thread: Pick<
    OrchestrationV2ThreadShell,
    "providerInstanceId" | "modelSelection" | "latestRunId" | "pendingBackgroundTasks" | "status"
  >,
  providers: readonly ServerProvider[],
) {
  const hasRuntime =
    thread.latestRunId !== null ||
    (backgroundWorkHoldsCompletion(thread.pendingBackgroundTasks ?? []) &&
      thread.status !== "failed");
  const instanceId = hasRuntime ? thread.providerInstanceId : thread.modelSelection.instanceId;
  const provider = providers.find((entry) => entry.instanceId === instanceId);
  if (!provider)
    return {
      symbol: providerInstanceInitials(instanceId),
      label: instanceId,
      color: theme.textMuted,
    };
  const label = resolveProviderInstanceDisplayName(provider);
  const driver = getProviderClient(provider.driver);
  const color =
    normalizeProviderAccentColor(provider.accentColor) ??
    driver?.icon?.fill[themeMode()] ??
    (provider.driver === "claudeAgent"
      ? "#d97757"
      : provider.driver === "antigravity"
        ? "#5b87bf"
        : theme.text);
  const sameDriver = providers.filter((entry) => entry.driver === provider.driver);
  const symbol = providerSymbols[provider.driver] ?? providerInstanceInitials(label);
  return {
    symbol: sameDriver.length > 1 ? `${symbol}:${providerInstanceInitials(label)}` : symbol,
    label,
    color,
  };
}

export function threadRelationship(thread: Pick<OrchestrationV2ThreadShell, "lineage">) {
  if (thread.lineage.sideChat) return { symbol: icon("sideChat"), label: "Side chat" };
  if (thread.lineage.relationshipToParent === "subagent")
    return { symbol: icon("subagent"), label: "Subagent" };
  if (thread.lineage.relationshipToParent === "fork")
    return { symbol: icon("fork"), label: "Fork" };
  return null;
}

export function threadPullRequestIndicator(thread: OrchestrationV2ThreadShell) {
  const links = threadPullRequestsOf(thread);
  const current = resolveThreadCurrentPullRequestLink(links);
  if (!current) return null;
  const snapshot = current.snapshot;
  const checks = snapshot?.checksState;
  const state = snapshot?.state;
  const extra = visibleThreadPullRequests(links).length - 1;
  const status =
    state === "open"
      ? [snapshot?.isDraft ? "draft" : checks ? null : "open", checks ? `checks ${checks}` : null]
          .filter(Boolean)
          .join(" · ")
      : (state ?? "status unknown");
  return {
    label: `#${current.number}${extra > 0 ? `+${extra}` : ""} ${status}`,
    color:
      state === "closed"
        ? theme.textMuted
        : state === "merged"
          ? theme.statusInput
          : checks === "failing"
            ? theme.error
            : checks === "pending"
              ? theme.warning
              : checks === "passing"
                ? theme.statusDone
                : theme.primary,
  };
}

export function createThreadDraftMarker(client: TuiClient, onError: (message: string) => void) {
  const persistence = draftStore(client.localStateDirectory, onError);
  const [revision, setRevision] = createSignal(0);
  onCleanup(persistence.subscribe(() => setRevision((value) => value + 1)));
  return (
    environmentId: string | null | undefined,
    threadId: string,
    selectedThreadId?: string | null,
  ) => {
    revision();
    if (!environmentId || threadId === selectedThreadId) return false;
    const draft = persistence.get(`${environmentId}/${threadId}`);
    return draft !== undefined && hasDraftContent(draft);
  };
}

export function threadFolderIndicator(
  threads: readonly OrchestrationV2ThreadShell[],
  environmentId: EnvironmentId,
  now: string,
) {
  const presented = threads.map((thread) => presentThreadShell(environmentId, thread));
  const statuses = presented.map((thread) => threadStatus(thread, now));
  if (statuses.some((status) => ["approval", "input", "request", "limited"].includes(status)))
    return { label: "Needs you", color: theme.warning };
  if (statuses.includes("failed")) return { label: "Failed", color: theme.error };
  if (
    presented.some(
      (thread, index) =>
        (statuses[index] === "ready" ||
          statuses[index] === "done" ||
          statuses[index] === "woken") &&
        hasUnseenCompletion(thread),
    )
  )
    return { label: "Done", color: theme.statusDone };
  if (statuses.includes("working")) return { label: "Working", color: theme.statusWorking };
  return null;
}
