import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js";
import { secondTick, toServerClock } from "@t3tools/client-runtime/clock";
import type { EnvironmentId } from "@t3tools/contracts";
import { theme } from "../theme/index.ts";
import { activityDuration, resetCountdown, type ActivityTiming } from "./activity-time.logic.ts";

function createSecondTime(enabled: (now: number) => boolean) {
  const [now, setNow] = createSignal(secondTick.getSnapshot());
  const live = createMemo(() => enabled(now()));
  // Subscribe only while this visible label needs the shared render clock.
  createEffect(() => {
    if (!live()) return;
    const update = () => setNow(secondTick.getSnapshot());
    update();
    onCleanup(secondTick.subscribe(update));
  });
  return now;
}

export function ElapsedActivity(props: {
  timing: ActivityTiming | null;
  environmentId?: EnvironmentId | null | undefined;
}) {
  const now = createSecondTime(() => props.timing?.completedAt === null);
  return (
    <Show when={props.timing}>
      {(timing) => (
        <text selectable={false} flexShrink={0} fg={theme.textMuted}>
          {` · ${activityDuration(timing(), props.environmentId ? toServerClock(props.environmentId, now()) : now())} `}
        </text>
      )}
    </Show>
  );
}

export function ResetCountdown(props: {
  resetAt: string | null | undefined;
  environmentId?: EnvironmentId | null | undefined;
}) {
  const now = createSecondTime((local) => {
    const current = props.environmentId ? toServerClock(props.environmentId, local) : local;
    return Boolean(props.resetAt && Date.parse(props.resetAt) > current);
  });
  const label = () =>
    resetCountdown(
      props.resetAt,
      props.environmentId ? toServerClock(props.environmentId, now()) : now(),
    );
  return (
    <Show when={label()}>
      {(value) => (
        <text height={1} fg={theme.textMuted}>
          {value()}
        </text>
      )}
    </Show>
  );
}
