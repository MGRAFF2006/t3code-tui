import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type OrchestrationV2Command,
  type ServerConfig,
} from "@t3tools/contracts";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts/settings";
import {
  v2ThreadShell,
  v2ShellSnapshot,
} from "../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures.ts";
import type { TuiClient, TuiSnapshot } from "../runtime/client.ts";
import type { FeatureProps, UiController } from "../ui/controller.ts";
import { createThreadSelectionActions } from "./thread-selection.ts";
import { threadProjectGroups } from "../presentation/thread-grouping.ts";

function setup() {
  const first = { ...v2ThreadShell, id: ThreadId.make("first"), latestUserMessageAt: null };
  const second = { ...first, id: ThreadId.make("second") };
  let state: TuiSnapshot = {
    environmentId: EnvironmentId.make("origin"),
    label: "Origin",
    connection: "connected",
    error: null,
    config: { settings: DEFAULT_SERVER_SETTINGS } as ServerConfig,
    shell: { ...v2ShellSnapshot, threads: [first, second] },
    selectedThreadId: null,
    thread: null,
    hasMoreHistory: false,
    workspaceMutationId: null,
  };
  const sent: OrchestrationV2Command[] = [];
  let allow = true;
  let afterSend = () => {};
  let reject = "";
  let completed: readonly string[] = [];
  const details: string[] = [];
  let observations = 0;
  const props: FeatureProps = {
    state: () => state,
    client: {
      observePermission: (
        _method: string,
        _input: unknown,
        listener: (allowed: boolean) => void,
      ) => {
        observations++;
        listener(allow);
        return () => {
          observations--;
          listener(false);
        };
      },
      invoke: async (_method: string, command: OrchestrationV2Command) => {
        sent.push(command);
        if ("threadId" in command && command.threadId === reject)
          throw new Error("Rejected by server");
        afterSend();
        return {};
      },
    } as unknown as TuiClient,
    ui: {
      notify: () => {},
      text: (_title: string, body: string) => {
        details.push(body);
      },
    } as unknown as UiController,
    focused: true,
    onFocus: () => {},
  };
  return {
    first,
    second,
    sent,
    details,
    state: () => state,
    change: (next: TuiSnapshot) => {
      state = next;
    },
    allow: (next: boolean) => {
      allow = next;
    },
    reject: (next: string) => {
      reject = next;
    },
    after: (next: () => void) => {
      afterSend = next;
    },
    completed: () => completed,
    observations: () => observations,
    actions: createThreadSelectionActions(props, [first.id, second.id], (ids) => {
      completed = ids;
    }),
  };
}

describe("native selected thread actions", () => {
  it("retains failed targets and stops sends after destination changes or permissions are revoked", async () => {
    const h = setup();
    h.reject(h.second.id);
    expect(await h.actions.apply("pin")).toMatchObject({
      succeeded: [h.first.id],
      failures: [expect.stringContaining("Rejected by server")],
    });
    expect(h.completed()).toEqual([h.first.id]);
    expect(h.details[0]).toContain("1 of 2 changed");
    expect(h.observations()).toBe(0);
    h.sent.length = 0;
    h.reject("");
    h.after(() => h.change({ ...h.state(), environmentId: EnvironmentId.make("newer") }));
    expect(await h.actions.apply("settle")).toMatchObject({
      succeeded: [h.first.id],
      failures: [expect.stringContaining("environment changed")],
    });
    expect(h.sent).toHaveLength(1);
    h.change({ ...h.state(), environmentId: EnvironmentId.make("origin") });
    h.sent.length = 0;
    h.after(() => h.allow(false));
    expect(await h.actions.apply("archive")).toMatchObject({
      succeeded: [h.first.id],
      failures: [expect.stringContaining("does not allow")],
    });
    expect(h.sent).toHaveLength(1);
    expect(h.observations()).toBe(0);
  });

  it("rechecks new pending work per target before snoozing and groups by shelf without losing manual order", async () => {
    const h = setup();
    h.change({
      ...h.state(),
      shell: {
        ...v2ShellSnapshot,
        threads: [h.first, { ...h.second, pendingGuestMessageCount: 1 }],
      },
    });
    const result = await h.actions.apply("snooze", "2099-01-01T10:00:00Z");
    expect(result.succeeded).toEqual([h.first.id]);
    expect(result.failures).toEqual([expect.stringContaining("pending approvals")]);
    expect(h.sent).toHaveLength(1);
    const other = {
      ...h.first,
      id: ThreadId.make("other"),
      projectId: ProjectId.make("other-project"),
    };
    const pinned = { ...h.second, pinnedAt: h.first.createdAt };
    expect(
      threadProjectGroups([pinned, h.first, other, h.second]).map((group) =>
        group.threads.map((thread) => thread.id),
      ),
    ).toEqual([[pinned.id], [h.first.id, h.second.id], [other.id]]);
  });
});
