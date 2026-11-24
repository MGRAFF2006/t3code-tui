import { describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadShell,
  type ServerConfig,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts/settings";
import {
  v2ThreadShell,
  v2ShellSnapshot,
} from "../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures.ts";
import type { TuiClient, TuiSnapshot } from "../runtime/client.ts";
import { DEFAULT_TUI_PREFERENCES } from "../runtime/preferences.ts";
import type { Choice, FeatureProps, FieldFormOptions, UiController } from "../ui/controller.ts";
import { threadOrganizationChoices } from "./thread-organization.ts";

function harness(target: OrchestrationV2ThreadShell) {
  const original: TuiSnapshot = {
    environmentId: EnvironmentId.make("environment-1"),
    label: "Fixture",
    connection: "connected",
    error: null,
    config: { settings: DEFAULT_SERVER_SETTINGS } as ServerConfig,
    shell: { ...v2ShellSnapshot, threads: [target] },
    selectedThreadId: null,
    thread: null,
    hasMoreHistory: false,
    workspaceMutationId: null,
  };
  let state = original;
  let allowed = true;
  let observations = 0;
  let opened = 0;
  let menu: Choice[] = [];
  let form: FieldFormOptions | undefined;
  let pending: Promise<unknown> = Promise.resolve();
  const sent: OrchestrationV2Command[] = [];
  const props: FeatureProps = {
    client: {
      preferences: () => DEFAULT_TUI_PREFERENCES,
      observePermission: (_method: string, _input: unknown, listener: (value: boolean) => void) => {
        observations += 1;
        listener(allowed);
        return () => {
          observations -= 1;
          listener(false);
        };
      },
      invoke: async (_method: string, command: OrchestrationV2Command) => {
        sent.push(command);
        return {};
      },
    } as unknown as TuiClient,
    state: () => state,
    ui: {
      run: (action: () => Promise<unknown>) => {
        pending = action();
        return pending;
      },
      choose: (_title: string, options: Choice[]) => {
        menu = options;
      },
      form: (value: FieldFormOptions) => {
        form = value;
      },
      notify: () => {},
      openThread: () => {
        opened += 1;
      },
    } as unknown as UiController,
    focused: true,
    onFocus: () => {},
  };
  return {
    actions: threadOrganizationChoices(props, target),
    original,
    sent,
    menu: () => menu,
    form: () => {
      if (!form) throw new Error("No snooze form opened");
      return form;
    },
    pending: () => pending,
    observations: () => observations,
    opened: () => opened,
    setState: (next: TuiSnapshot) => {
      state = next;
    },
    setAllowed: (next: boolean) => {
      allowed = next;
    },
  };
}

describe("terminal thread organization destination safety", () => {
  it("rechecks the captured destination, permission and new pending work when submitting an open snooze form", async () => {
    const target = { ...v2ThreadShell, latestUserMessageAt: null };
    const test = harness(target);
    test.actions.find((action) => action.title === "Snooze thread…")!.run();
    await test.pending();
    test
      .menu()
      .find((action) => action.title === "Custom duration…")!
      .run();
    const form = test.form();
    test.setState({ ...test.original, environmentId: EnvironmentId.make("other-environment") });
    await expect(form.onSubmit({ amount: "2", unit: "hours" })).rejects.toThrow(
      "environment changed",
    );
    expect(test.sent).toEqual([]);
    test.setState(test.original);
    test.setAllowed(false);
    await expect(form.onSubmit({ amount: "2", unit: "hours" })).rejects.toThrow("does not allow");
    expect(test.observations()).toBe(0);
    expect(test.sent).toEqual([]);
    test.setAllowed(true);
    test.setState({
      ...test.original,
      shell: { ...v2ShellSnapshot, threads: [{ ...target, pendingGuestMessageCount: 1 }] },
    });
    await expect(form.onSubmit({ amount: "2", unit: "hours" })).rejects.toThrow(
      "pending approvals",
    );
    expect(test.sent).toEqual([]);
    test.setState({ ...test.original, shell: { ...v2ShellSnapshot, threads: [] } });
    await expect(form.onSubmit({ amount: "2", unit: "hours" })).rejects.toThrow(
      "no longer available",
    );
    test.setState(test.original);
    await form.onSubmit({ amount: "2", unit: "hours" });
    expect(test.sent).toHaveLength(1);
    expect(test.sent[0]).toMatchObject({ type: "thread.snooze", threadId: target.id });
    expect(test.observations()).toBe(0);
  });

  it("dismisses only the captured wake timestamp without opening the thread or marking a later wake seen", async () => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-06-20T12:00:00Z"));
    const first = DateTime.makeUnsafe("2026-06-20T10:00:00Z");
    const target = {
      ...v2ThreadShell,
      latestUserMessageAt: null,
      snoozedAt: DateTime.makeUnsafe("2026-06-20T09:00:00Z"),
      snoozedUntil: first,
    };
    const test = harness(target);
    const action = test.actions.find((choice) => choice.title === "Dismiss wake notification");
    expect(action).toBeDefined();
    test.setState({
      ...test.original,
      shell: {
        ...v2ShellSnapshot,
        threads: [{ ...target, snoozedUntil: DateTime.makeUnsafe("2026-06-20T11:00:00Z") }],
      },
    });
    action!.run();
    await test.pending();
    expect(test.sent).toHaveLength(1);
    expect(test.sent[0]).toMatchObject({
      type: "thread.visit",
      threadId: target.id,
      visitedAt: "2026-06-20T10:00:00.000Z",
      opened: false,
    });
    expect(test.opened()).toBe(0);
    expect(test.observations()).toBe(0);
  });
});
