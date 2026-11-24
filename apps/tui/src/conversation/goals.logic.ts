import {
  parseGoalCommand,
  type OrchestrationV2ProviderGoal,
  type OrchestrationV2ThreadProjection,
  type ServerProvider,
} from "@t3tools/contracts";
import { satisfiesSemverRange } from "@t3tools/shared/semver";
import { deriveThreadQueueWorkflowState } from "@t3tools/client-runtime/state/thread-workflows";

export function conversationGoalState(
  projection: OrchestrationV2ThreadProjection,
  provider: ServerProvider | undefined,
  shellGoal: OrchestrationV2ProviderGoal | null | undefined,
) {
  const instanceId = projection.thread.modelSelection.instanceId;
  const providerThread = projection.providerThreads.find(
    (entry) => entry.id === projection.thread.activeProviderThreadId,
  );
  const goal =
    providerThread && providerThread.providerInstanceId !== instanceId
      ? null
      : shellGoal !== undefined
        ? shellGoal
        : (providerThread?.goal ?? null);
  const session =
    projection.providerSessions.find(
      (entry) =>
        entry.id === providerThread?.providerSessionId && entry.providerInstanceId === instanceId,
    ) ??
    projection.providerSessions.findLast(
      (entry) =>
        entry.providerInstanceId === instanceId &&
        entry.status !== "stopped" &&
        entry.status !== "error",
    );
  const advertised = session?.capabilities.turns.supportsNativeGoals;
  const support = providerGoalSupport(provider, advertised);
  const working = deriveThreadQueueWorkflowState(projection).activeRun !== null;
  return {
    goal,
    working,
    ...support,
    canClear: support.canManage && goal !== null,
    canPause: support.canPause && goal?.status === "active",
    canResume:
      support.canPause &&
      goal !== null &&
      goal.status !== "active" &&
      goal.status !== "complete" &&
      !working,
  };
}

export function providerGoalSupport(
  provider:
    | Pick<ServerProvider, "driver" | "version" | "slashCommands" | "enabled" | "installed">
    | undefined,
  advertised: boolean | undefined,
) {
  const driver = provider?.driver;
  const supported =
    advertised !== false &&
    (driver === "codex" ||
      driver === "claudeAgent" ||
      ((driver === "opencode" || driver === "antigravity") &&
        (advertised === true ||
          (driver === "opencode"
            ? satisfiesSemverRange(provider?.version ?? "", ">=2.2.5")
            : (provider?.slashCommands.some(
                (command) => command.name.replace(/^\//, "") === "goal",
              ) ?? false)))));
  const canSet = supported && provider?.enabled === true && provider.installed;
  const canManage = canSet && driver !== "antigravity";
  const canPause = canManage && driver !== "claudeAgent";
  return {
    canSet,
    canManage,
    canPause,
    limitedControls:
      driver === "antigravity"
        ? "Antigravity accepts goal objectives but does not report goal status or support show, pause, resume or clear. Interrupt its running turn, then ask it to stop the goal."
        : driver === "claudeAgent"
          ? "Claude goals cannot pause or resume. Stopping a turn leaves the goal set; Clear removes it."
          : null,
    unavailable: !supported
      ? "This provider has not advertised native goal support. Codex, Claude and OpenCode 2.2.5 or newer support goals."
      : !canSet
        ? "Enable and install this provider before changing its goal."
        : null,
  };
}

export function goalObjectiveCommand(objective: string) {
  const value = objective.trim();
  if (!value) throw new Error("Enter a verifiable goal objective.");
  const text = `/goal ${value}`;
  if (parseGoalCommand({ text })?.type !== "set")
    throw new Error(
      "Use a descriptive objective; edit, clear, pause and resume are goal commands.",
    );
  return text;
}
