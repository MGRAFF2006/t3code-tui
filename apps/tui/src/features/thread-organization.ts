import {
  CommandId,
  ORCHESTRATION_V2_WS_METHODS,
  ThreadId,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  canSnooze,
  effectiveSnoozed,
  isThreadWokeUnseen,
  localSnoozeDate,
  localSnoozeTime,
  pickSnoozePreset,
  resolveCustomSnooze,
  resolveSnoozePresets,
  threadWokeAt,
} from "@t3tools/client-runtime/state/thread-settled";
import { toServerClock } from "@t3tools/client-runtime/clock";
import * as DateTime from "effect/DateTime";
import * as SecureRandom from "effect/crypto/SecureRandom";
import type { Choice, FeatureProps } from "../ui/controller.ts";
import { request } from "../rpc/request.ts";
import { planThreadReorder, type ThreadMove } from "./thread-organization.logic.ts";

export function threadOrganizationChoices(
  props: FeatureProps,
  target: OrchestrationV2ThreadShell,
): Choice[] {
  if (target.archivedAt !== null || target.deletedAt !== null) return [];
  const environment = props.state()?.environmentId;
  const commandId = () => CommandId.make(SecureRandom.uuidV4Unsafe());
  const threads = () => {
    const shell = props.state()?.shell;
    return [...(shell?.threads ?? []), ...(shell?.archivedThreads ?? [])];
  };
  const guard = () => {
    const state = props.state();
    if (!environment || state?.environmentId !== environment)
      throw new Error("The environment changed. Reopen thread actions in its destination.");
    if (state.connection !== "connected" || !state.config)
      throw new Error(
        "Reconnect and wait for the environment to load before changing this thread.",
      );
    const current = threads().find((thread) => thread.id === target.id);
    if (!current || current.deletedAt !== null)
      throw new Error("This thread is no longer available. Reopen the thread list.");
    return current;
  };
  const now = () =>
    DateTime.toDateUtc(
      DateTime.makeUnsafe(
        environment
          ? toServerClock(environment, DateTime.toEpochMillis(DateTime.nowUnsafe()))
          : DateTime.toEpochMillis(DateTime.nowUnsafe()),
      ),
    );
  const permission = (command: OrchestrationV2Command) => {
    let allowed = false;
    const stop = props.client.observePermission(
      ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
      command,
      (value) => {
        allowed = value;
      },
    );
    const result = allowed;
    stop();
    return result;
  };
  const send = async (command: OrchestrationV2Command) => {
    guard();
    if (!permission(command)) throw new Error("This connection does not allow this thread action.");
    await request(props.client, ORCHESTRATION_V2_WS_METHODS.dispatchCommand, command);
  };
  const snooze = async (until: string) => {
    const current = guard();
    if (
      !environment ||
      !canSnooze(presentThreadShell(environment, current), { now: now().toISOString() })
    )
      throw new Error("Respond to pending approvals, requests or queued work before snoozing.");
    if (!(Date.parse(until) > now().getTime())) throw new Error("Choose a future snooze time.");
    await send({
      type: "thread.snooze",
      commandId: commandId(),
      threadId: target.id,
      snoozedUntil: until,
    });
  };
  const customDate = () => {
    const initial = DateTime.toDateUtc(DateTime.add(DateTime.makeUnsafe(now()), { hours: 1 }));
    props.ui.form({
      title: "Custom snooze date",
      description: "Use this terminal's local date and time.",
      fields: [
        {
          name: "date",
          label: "Date (YYYY-MM-DD)",
          value: localSnoozeDate(initial),
          required: true,
        },
        { name: "time", label: "Time (HH:MM)", value: localSnoozeTime(initial), required: true },
      ],
      onSubmit: async ({ date = "", time = "" }) => {
        guard();
        const until = resolveCustomSnooze({ mode: "date", date, time }, now());
        if (!until) throw new Error("Choose a valid future local date and time.");
        await snooze(until);
      },
    });
  };
  const customDuration = () =>
    props.ui.form({
      title: "Custom snooze duration",
      fields: [
        { name: "amount", label: "Duration", type: "number", value: "1", required: true },
        {
          name: "unit",
          label: "Unit",
          type: "select",
          value: "hours",
          options: [
            { label: "Minutes", value: "minutes" },
            { label: "Hours", value: "hours" },
            { label: "Days", value: "days" },
          ],
        },
      ],
      onSubmit: async ({ amount = "", unit = "hours" }) => {
        guard();
        if (unit !== "minutes" && unit !== "hours" && unit !== "days")
          throw new Error("Choose minutes, hours or days.");
        const until = resolveCustomSnooze({ mode: "duration", amount, unit }, now());
        if (!until) throw new Error("Enter a positive duration that produces a valid future time.");
        await snooze(until);
      },
    });
  const snoozeMenu = () => {
    const current = guard();
    if (
      !environment ||
      !canSnooze(presentThreadShell(environment, current), { now: now().toISOString() })
    )
      throw new Error("Respond to pending approvals, requests or queued work before snoozing.");
    const presets = props.state()!.config!.settings.snoozePresets;
    const format = props.client.preferences().timestampFormat;
    const formatTime = (date: Date) =>
      new Intl.DateTimeFormat(undefined, {
        hour: "numeric",
        minute: "2-digit",
        ...(format !== "locale" ? { hour12: format === "12-hour" } : {}),
      }).format(date);
    const shown = resolveSnoozePresets(now(), { presets, formatTime });
    props.ui.choose("Snooze thread", [
      ...shown.map((preset) => ({
        title: preset.label,
        description: preset.whenLabel,
        run: () =>
          void props.ui.run(async () => {
            guard();
            const picked = pickSnoozePreset({
              shown,
              id: preset.id,
              now: now(),
              presets,
              formatTime,
            });
            if (!picked) throw new Error("That snooze time has passed. Choose another time.");
            await snooze(picked.snoozedUntil);
          }),
      })),
      { title: "Custom date and time…", run: customDate },
      { title: "Custom duration…", run: customDuration },
      {
        title: "ISO date and time…",
        run: () =>
          props.ui.form({
            title: "Snooze until ISO date",
            description: "Include Z or an explicit timezone offset.",
            fields: [
              {
                name: "until",
                label: "Until",
                value: DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(now()), { hours: 1 })),
                required: true,
              },
            ],
            onSubmit: async ({ until = "" }) => {
              guard();
              if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(until))
                throw new Error("Include Z or a timezone offset, such as +01:00.");
              await snooze(DateTime.formatIso(DateTime.makeUnsafe(until)));
            },
          }),
      },
    ]);
  };
  const reorderMenu = () => {
    const current = guard();
    const pinned = current.pinnedAt != null;
    props.ui.choose(
      pinned ? "Reorder pinned threads" : "Reorder active threads",
      (
        [
          ["up", "Move up"],
          ["down", "Move down"],
          ["first", "Move to top"],
          ["last", "Move to bottom"],
        ] as const
      ).map(([move, title]) => ({
        title,
        run: () =>
          void props.ui.run(async () => {
            const latest = guard();
            if ((latest.pinnedAt != null) !== pinned)
              throw new Error("The thread's pin state changed. Reopen the reorder menu.");
            if (!environment) return;
            const assignments = planThreadReorder({
              threads: threads(),
              targetId: target.id,
              environmentId: environment,
              now: now().toISOString(),
              move: move satisfies ThreadMove,
            });
            if (!assignments.length) {
              props.ui.notify("The thread is already at this position or has left this shelf.");
              return;
            }
            const commands = assignments.map(({ id, orderKey }) => ({
              type: pinned ? ("thread.pin.reorder" as const) : ("thread.active.reorder" as const),
              commandId: commandId(),
              threadId: ThreadId.make(id),
              orderKey,
            }));
            if (commands.some((command) => !permission(command)))
              throw new Error("This connection cannot reorder all affected threads.");
            for (const command of commands) await send(command);
          }, "Thread order saved."),
      })),
    );
  };
  const shell = environment ? presentThreadShell(environment, target) : null;
  const currentNow = now().toISOString();
  const snoozed = shell && effectiveSnoozed(shell, { now: currentNow });
  const wokeAt = shell ? threadWokeAt(shell, { now: currentNow }) : null;
  const wokeUnseen =
    shell &&
    isThreadWokeUnseen({
      wokeAt,
      settled: shell.settledOverride === "settled",
      lastVisitedAt: shell.lastVisitedAt,
      latestRunCompletedAt: shell.latestRun?.completedAt ?? null,
    });
  return [
    {
      title: snoozed ? "Change snooze…" : "Snooze thread…",
      run: () => void props.ui.run(async () => snoozeMenu()),
    },
    ...(snoozed
      ? [
          {
            title: "Unsnooze thread",
            run: () =>
              void props.ui.run(() =>
                send({
                  type: "thread.unsnooze",
                  commandId: commandId(),
                  threadId: target.id,
                  reason: "user",
                }),
              ),
          },
        ]
      : []),
    ...(wokeUnseen && wokeAt
      ? [
          {
            title: "Dismiss wake notification",
            description: "Clear this wake without opening the conversation.",
            run: () =>
              void props.ui.run(() =>
                send({
                  type: "thread.visit",
                  commandId: commandId(),
                  threadId: target.id,
                  visitedAt: wokeAt,
                  opened: false,
                }),
              ),
          },
        ]
      : []),
    ...(target.archivedAt === null &&
    !snoozed &&
    (target.pinnedAt != null || target.settledOverride !== "settled")
      ? [
          {
            title: "Reorder thread…",
            description: "Move within its pinned or active shelf across projects.",
            run: () => void props.ui.run(async () => reorderMenu()),
          },
        ]
      : []),
  ];
}
