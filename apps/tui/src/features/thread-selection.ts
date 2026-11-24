import {
  CommandId,
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  canSnooze,
  resolveSnoozePresets,
  pickSnoozePreset,
} from "@t3tools/client-runtime/state/thread-settled";
import { toServerClock } from "@t3tools/client-runtime/clock";
import * as DateTime from "effect/DateTime";
import * as SecureRandom from "effect/crypto/SecureRandom";
import type { FeatureProps, Choice } from "../ui/controller.ts";
import { request } from "../rpc/request.ts";

export type BulkThreadAction =
  | "pin"
  | "unpin"
  | "settle"
  | "unsettle"
  | "archive"
  | "unarchive"
  | "mark-unread"
  | "regenerate-title"
  | "delete"
  | "snooze";

export function createThreadSelectionActions(
  props: FeatureProps,
  ids: readonly string[],
  completed: (ids: readonly string[]) => void,
) {
  const environment = props.state()?.environmentId;
  const targets = [...new Set(ids)];
  const now = () => {
    const local = DateTime.toEpochMillis(DateTime.nowUnsafe());
    return DateTime.toDateUtc(
      DateTime.makeUnsafe(environment ? toServerClock(environment, local) : local),
    );
  };
  function current(id: string) {
    const state = props.state();
    if (!environment || state?.environmentId !== environment)
      throw new Error("The environment changed. Select threads again in their destination.");
    if (state.connection !== "connected" || !state.config)
      throw new Error("Reconnect before changing selected threads.");
    const target = [...(state.shell?.threads ?? []), ...(state.shell?.archivedThreads ?? [])].find(
      (thread) => thread.id === id && thread.deletedAt === null,
    );
    if (!target) throw new Error("Thread is no longer available.");
    return target;
  }
  function command(
    action: BulkThreadAction,
    target: OrchestrationV2ThreadShell,
    until?: string,
  ): OrchestrationV2Command {
    const base = { commandId: CommandId.make(SecureRandom.uuidV4Unsafe()), threadId: target.id };
    switch (action) {
      case "unsettle":
        return { ...base, type: "thread.unsettle", reason: "user" };
      case "regenerate-title":
        return { ...base, type: "thread.metadata.update", regenerateTitle: true };
      case "snooze": {
        if (
          !environment ||
          !canSnooze(presentThreadShell(environment, target), { now: now().toISOString() })
        )
          throw new Error("Resolve pending approvals, requests and queued work before snoozing.");
        if (!until || !(Date.parse(until) > now().getTime()))
          throw new Error("Choose a future snooze time with a timezone.");
        return { ...base, type: "thread.snooze", snoozedUntil: until };
      }
      default:
        return { ...base, type: `thread.${action}` };
    }
  }
  async function apply(action: BulkThreadAction, until?: string) {
    const succeeded: string[] = [];
    const failures: string[] = [];
    for (const id of targets) {
      try {
        const target = current(id);
        const input = command(action, target, until);
        let allowed = false;
        const stop = props.client.observePermission(
          ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
          input,
          (value) => {
            allowed = value;
          },
        );
        const permitted = allowed;
        stop();
        if (!permitted) throw new Error("This connection does not allow this action.");
        current(id);
        await request(props.client, ORCHESTRATION_V2_WS_METHODS.dispatchCommand, input);
        succeeded.push(id);
        if (
          action === "delete" &&
          props.state()?.environmentId === environment &&
          props.state()?.selectedThreadId === id
        )
          props.client.selectThread(null);
      } catch (error) {
        failures.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (props.state()?.environmentId === environment) completed(succeeded);
    if (failures.length)
      props.ui.text(
        "Selected thread results",
        `${succeeded.length} of ${targets.length} changed. Unsuccessful threads remain selected.\n\n${failures.join("\n")}`,
      );
    else props.ui.notify(`${succeeded.length} selected threads changed.`);
    return { succeeded, failures };
  }
  const run = (action: BulkThreadAction, until?: string) =>
    void props.ui.run(() => apply(action, until));
  function snooze() {
    const settings = props.state()?.config?.settings;
    if (!settings) return;
    const shown = resolveSnoozePresets(now(), { presets: settings.snoozePresets });
    props.ui.choose("Snooze selected threads", [
      ...shown.map((preset) => ({
        title: preset.label,
        description: preset.whenLabel,
        run: () => {
          current(targets[0]!);
          const picked = pickSnoozePreset({
            shown,
            id: preset.id,
            now: now(),
            presets: settings.snoozePresets,
          });
          if (!picked) {
            props.ui.notify("That snooze time has passed. Choose another time.", true);
            return;
          }
          run("snooze", picked.snoozedUntil);
        },
      })),
      {
        title: "Custom ISO date and time…",
        run: () =>
          props.ui.form({
            title: "Snooze selected threads",
            fields: [{ name: "until", label: "Until (include Z or timezone)", required: true }],
            onSubmit: async ({ until = "" }) => {
              if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(until) || !(Date.parse(until) > now().getTime()))
                throw new Error("Choose a future time with Z or an explicit timezone.");
              await apply("snooze", until);
            },
          }),
      },
    ]);
  }
  const choices: Choice[] = [
    ...(
      [
        ["pin", "Pin"],
        ["unpin", "Unpin"],
        ["settle", "Settle"],
        ["unsettle", "Move to active"],
        ["archive", "Archive"],
        ["unarchive", "Reopen archived"],
        ["mark-unread", "Mark unread"],
        ["regenerate-title", "Regenerate titles"],
      ] as const
    ).map(([action, title]) => ({ title, run: () => run(action) })),
    {
      title: "Snooze…",
      run: () =>
        void props.ui.run(async () => {
          current(targets[0]!);
          snooze();
        }),
    },
    {
      title: "Delete permanently…",
      run: () =>
        props.ui.confirm(
          "Delete selected threads",
          `Permanently delete ${targets.length} conversations and their history. This cannot be undone.`,
          async () => {
            if (await props.ui.beforeNavigate()) await apply("delete");
          },
          "Delete permanently",
        ),
    },
  ];
  return { choices, apply };
}
