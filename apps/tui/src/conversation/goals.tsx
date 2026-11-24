import { createEffect, createMemo, createSignal, on, onCleanup, Show } from "solid-js";
import {
  AuthOrchestrationOperateScope,
  type OrchestrationV2ThreadProjection,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { presentProviderGoal } from "@t3tools/client-runtime/state/thread-execution";
import type { Choice, FeatureProps } from "../ui/controller.ts";
import { theme } from "../theme/index.ts";
import { conversationGoalState, goalObjectiveCommand } from "./goals.logic.ts";

export function createConversationGoals(
  props: FeatureProps & { projection: () => OrchestrationV2ThreadProjection },
) {
  const environmentId = props.state()?.environmentId;
  const threadId = props.projection().thread.id;
  const [canOperate, setCanOperate] = createSignal(false);
  const [sending, setSending] = createSignal(false);
  let active = true;
  onCleanup(() => {
    active = false;
  });
  createEffect(
    on(
      () => props.state()?.environmentId,
      (destination) => {
        setCanOperate(false);
        if (destination && destination === environmentId)
          onCleanup(props.client.observeScope(AuthOrchestrationOperateScope, setCanOperate));
      },
    ),
  );
  const state = createMemo(() => {
    const snapshot = props.state();
    const projection = props.projection();
    const provider = snapshot?.config?.providers.find(
      (entry) => entry.instanceId === projection.thread.modelSelection.instanceId,
    );
    const shell =
      snapshot?.shell?.threads.find((entry) => entry.id === threadId) ??
      snapshot?.shell?.archivedThreads.find((entry) => entry.id === threadId);
    return conversationGoalState(projection, provider, shell?.goal);
  });
  const presentation = createMemo(() => {
    const { goal, working } = state();
    return goal ? presentProviderGoal(goal, working) : null;
  });
  const unavailable = () =>
    props.state()?.connection !== "connected"
      ? "Reconnect to this environment before changing its goal."
      : !canOperate()
        ? "This connection does not permit running or controlling goals."
        : sending()
          ? "Wait for the current goal action to finish."
          : state().unavailable;
  const scope = () => ({
    instanceId: props.projection().thread.modelSelection.instanceId,
    objective: state().goal?.objective ?? null,
  });
  const guard = (target: { instanceId: ProviderInstanceId; objective: string | null }) => {
    if (
      !active ||
      props.state()?.environmentId !== environmentId ||
      props.state()?.selectedThreadId !== threadId ||
      props.state()?.thread?.thread.id !== threadId ||
      props.projection().thread.modelSelection.instanceId !== target.instanceId
    )
      throw new Error("Return to the original conversation and provider to change its goal.");
    if ((state().goal?.objective ?? null) !== target.objective)
      throw new Error("The goal changed. Reopen goal controls before changing it.");
    const reason = unavailable();
    if (reason) throw new Error(reason);
  };
  const send = async (
    target: ReturnType<typeof scope>,
    text: string,
    control: "set" | "clear" | "pause" | "resume",
    delivery: "auto" | "queue" = "auto",
  ) => {
    guard(target);
    const current = state();
    const permitted =
      control === "set"
        ? current.canSet
        : control === "clear"
          ? current.canClear
          : control === "pause"
            ? current.canPause
            : current.canResume;
    if (!permitted)
      throw new Error("This goal action is no longer available. Reopen goal controls.");
    setSending(true);
    try {
      await props.client.send(text, { dispatchMode: delivery });
    } finally {
      if (active) setSending(false);
    }
  };
  const edit = () => {
    const target = scope();
    const reason = unavailable();
    if (reason || !state().canSet) {
      props.ui.text(
        "Goal unavailable",
        reason ?? state().unavailable ?? "This provider does not support goals.",
      );
      return;
    }
    props.ui.form({
      title: target.objective ? "Edit goal" : "Set goal",
      description: state().working
        ? "Starting now can stop the current turn. Queue the goal to wait for it."
        : (state().limitedControls ??
          "Describe a verifiable result. The provider can keep working across turns until it is met."),
      fields: [
        {
          name: "objective",
          label: "Goal objective",
          type: "multiline",
          value: target.objective ?? "",
          required: true,
        },
        ...(state().working
          ? [
              {
                name: "delivery",
                label: "Delivery",
                type: "select" as const,
                value: "auto",
                options: [
                  { label: "Start now", value: "auto" },
                  { label: "Queue after current turn", value: "queue" },
                ],
              },
            ]
          : []),
      ],
      submitLabel: target.objective ? "Update goal" : "Start goal",
      onSubmit: async ({ objective = "", delivery = "auto" }) =>
        send(
          target,
          goalObjectiveCommand(objective),
          "set",
          delivery === "queue" ? "queue" : "auto",
        ),
    });
  };
  const details = () => {
    const value = state();
    const presented = presentation();
    props.ui.text(
      "Goal progress",
      presented && value.goal
        ? [
            presented.title,
            presented.objective,
            presented.usage,
            value.goal.lastCheck ? `Last check: ${value.goal.lastCheck}` : null,
            value.limitedControls,
          ]
            .filter(Boolean)
            .join("\n\n")
        : (value.limitedControls ?? "No goal is set for this provider."),
    );
  };
  const open = () => {
    const value = state();
    const target = scope();
    const reason = unavailable();
    const choices: Choice[] = [];
    if (value.goal)
      choices.push({
        title: "View goal progress",
        description: presentation()?.usage ?? value.goal.objective,
        run: details,
      });
    if (!reason && value.canSet) {
      choices.push({ title: value.goal ? "Edit goal" : "Set goal", run: edit });
      if (value.canPause)
        choices.push({
          title: "Pause goal",
          run: () => void props.ui.run(() => send(target, "/goal pause", "pause")),
        });
      if (value.canResume)
        choices.push({
          title: "Resume goal",
          run: () => void props.ui.run(() => send(target, "/goal resume", "resume")),
        });
      if (value.canClear)
        choices.push({
          title: "Clear goal",
          run: () =>
            props.ui.confirm(
              "Clear goal",
              target.objective ?? "Remove this goal.",
              () => send(target, "/goal clear", "clear"),
              "Clear goal",
            ),
        });
    }
    if (reason || value.limitedControls)
      choices.push({
        title: reason ? "Goal controls unavailable" : "Provider goal controls",
        description: reason ?? value.limitedControls!,
        run: () => props.ui.text("Provider goal controls", reason ?? value.limitedControls!),
      });
    props.ui.choose("Goal", choices);
  };
  function Card() {
    return (
      <Show when={presentation()}>
        {(value) => (
          <box paddingX={1} marginTop={1} backgroundColor={theme.backgroundPanel}>
            <box flexDirection="row" gap={1}>
              <text
                fg={state().goal?.status === "complete" ? theme.success : theme.primary}
                flexGrow={1}
                minWidth={0}
                truncate
                height={1}
              >{`${value().title}${value().usage ? ` · ${value().usage}` : ""}`}</text>
              <text selectable={false} fg={theme.primary} onMouseDown={open}>
                Manage goal
              </text>
            </box>
            <text fg={theme.textMuted} height={1} truncate>
              {value().objective}
            </text>
          </box>
        )}
      </Show>
    );
  }
  return { Card, open, edit };
}
