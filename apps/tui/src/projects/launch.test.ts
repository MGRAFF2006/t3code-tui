import { describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  WS_METHODS,
  type VcsListRefsResult,
  type ServerConfig,
} from "@t3tools/contracts";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts/settings";
import {
  v2Project,
  v2ShellSnapshot,
} from "../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures.ts";
import type { TuiClient, TuiSnapshot } from "../runtime/client.ts";
import type { Choice, FeatureProps, FieldFormOptions, UiController } from "../ui/controller.ts";
import { newThreadLaunch } from "./launch.ts";
import type { ThreadLaunchContext } from "./launch-context.ts";

function harness() {
  const origin = EnvironmentId.make("origin");
  const destination = EnvironmentId.make("destination");
  const remoteProject = {
    ...v2Project,
    id: ProjectId.make("remote-project"),
    title: "Remote project",
    workspaceRoot: "/remote/project",
  };
  const context = (environmentId: EnvironmentId): ThreadLaunchContext => ({
    environmentId,
    config: {
      environment: {
        environmentId,
        label: environmentId === origin ? "Current machine" : "Other machine",
      },
      providers: [],
      settings: DEFAULT_SERVER_SETTINGS,
    } as unknown as ServerConfig,
    shell: {
      ...v2ShellSnapshot,
      projects: environmentId === origin ? [v2Project] : [remoteProject],
    },
  });
  let state = { environmentId: origin } as TuiSnapshot;
  let menu: Choice[] = [];
  let form: FieldFormOptions | undefined;
  let current = true;
  let pending: Promise<unknown> = Promise.resolve();
  const refs: VcsListRefsResult = {
    isRepo: true,
    hasPrimaryRemote: true,
    nextCursor: null,
    totalCount: 2,
    refs: [
      { name: "main", current: true, isDefault: true, worktreePath: v2Project.workspaceRoot },
      { name: "topic", current: false, isDefault: false, worktreePath: "/remote/topic" },
    ],
  };
  const invoke = vi.fn(async (method: string) => {
    if (method === WS_METHODS.vcsListRefs) return refs;
    throw new Error(`Unexpected request: ${method}`);
  });
  const createThread = vi.fn<TuiClient["createThread"]>().mockResolvedValue("created-thread");
  const onLaunched = vi.fn().mockResolvedValue(undefined);
  const beforeNavigate = vi.fn().mockResolvedValue(true);
  const props: FeatureProps = {
    client: {
      prepareThreadLaunch: async (id: string) => context(EnvironmentId.make(id)),
      captureTransportFor: async () => ({ invoke }),
      environments: async () => [
        { environmentId: origin, label: "Current machine", enabled: true },
        { environmentId: destination, label: "Other machine", enabled: true },
      ],
      createThread,
    } as unknown as TuiClient,
    state: () => state,
    ui: {
      choose: (_title: string, options: Choice[]) => {
        menu = options;
      },
      form: (options: FieldFormOptions) => {
        form = options;
      },
      run: (action: () => Promise<unknown>) => {
        pending = action();
        return pending;
      },
      notify: () => {},
      beforeNavigate,
    } as unknown as UiController,
    focused: true,
    onFocus: () => {},
  };
  newThreadLaunch(props, { projectId: v2Project.id, isCurrent: () => current, onLaunched });
  return {
    createThread,
    onLaunched,
    beforeNavigate,
    invoke,
    refs,
    origin,
    destination,
    remoteProject,
    state: () => state,
    setState: (value: TuiSnapshot) => {
      state = value;
    },
    setCurrent: (value: boolean) => {
      current = value;
    },
    choose: (title: string) => {
      const action = menu.find(
        (entry) => entry.title === title || entry.title.startsWith(`${title}:`),
      );
      if (!action)
        throw new Error(`No choice ${title}: ${menu.map((entry) => entry.title).join(", ")}`);
      action.run();
    },
    form: () => {
      if (!form) throw new Error("No form");
      return form;
    },
    menu: () => menu,
    pending: () => pending,
  };
}

describe("native new-thread launch drafts", () => {
  it("captures a remote destination, project, worktree base and remote-tip override without switching the current view", async () => {
    const test = harness();
    await test.pending();
    const currentView = test.state();
    test.choose("Machine");
    await test.pending();
    test.choose("Other machine");
    await test.pending();
    test.choose("Remote project");
    test.choose("Workspace");
    test.choose("New worktree…");
    await test.pending();
    test.choose("main");
    test.choose("Remote starting point");
    test.choose("Create thread");
    await test.pending();
    expect(test.createThread).toHaveBeenCalledWith(
      test.remoteProject.id,
      "New thread",
      undefined,
      expect.objectContaining({
        environmentId: test.destination,
        workspaceStrategy: { type: "worktree", baseRef: "main", startFromOrigin: false },
      }),
    );
    expect(test.onLaunched).toHaveBeenCalledWith({
      environmentId: test.destination,
      threadId: "created-thread",
      background: false,
    });
    expect(test.state()).toBe(currentView);
  });

  it("launches existing worktrees, restores inherited launch policy and keeps background prompt submission in a fresh draft", async () => {
    const test = harness();
    await test.pending();
    test.choose("Workspace");
    test.choose("Existing worktree…");
    await test.pending();
    test.choose("topic");
    test.choose("Compose initial prompt…");
    await test
      .form()
      .onSubmit({ title: "Background task", prompt: "Run this task", delivery: "background" });
    expect(test.createThread).toHaveBeenLastCalledWith(
      v2Project.id,
      "Background task",
      "Run this task",
      expect.objectContaining({
        environmentId: test.origin,
        workspaceStrategy: {
          type: "existing_worktree",
          worktreePath: "/remote/topic",
          branch: "topic",
        },
      }),
    );
    expect(test.beforeNavigate).not.toHaveBeenCalled();
    expect(test.onLaunched).toHaveBeenCalledWith({
      environmentId: test.origin,
      threadId: "created-thread",
      background: true,
    });
    expect(test.form().fields.find((field) => field.name === "prompt")?.value).toBe("");
    expect(test.form().description).toContain("/remote/topic");

    await test.form().onSubmit({ title: "Next task", prompt: "Next", delivery: "background" });
    const first = test.createThread.mock.calls[0]?.[3];
    const second = test.createThread.mock.calls[1]?.[3];
    expect(second?.threadId).not.toBe(first?.threadId);
  });

  it("keeps main-checkout selection distinct from project default and rejects stale views before launch", async () => {
    const test = harness();
    await test.pending();
    test.choose("Workspace");
    test.choose("Main checkout");
    test.choose("Create thread");
    await test.pending();
    expect(test.createThread.mock.calls[0]?.[3]?.workspaceStrategy).toEqual({ type: "root" });
    test.choose("Workspace");
    test.choose("Project default");
    test.choose("Create thread");
    await test.pending();
    expect(test.createThread.mock.calls[1]?.[3]).not.toHaveProperty("workspaceStrategy");
    test.choose("Compose initial prompt…");
    const staleForm = test.form();
    test.setCurrent(false);
    await expect(staleForm.onSubmit({ title: "Stale", prompt: "Must not send" })).rejects.toThrow(
      "view changed",
    );
    expect(test.createThread).toHaveBeenCalledTimes(2);
  });

  it("retains prompt and request identities for an uncertain launch, rejects changed retries and validates oversized text before dispatch", async () => {
    const test = harness();
    await test.pending();
    test.choose("Compose initial prompt…");
    const original = test.form();
    await expect(
      original.onSubmit({
        title: "Long",
        prompt: "x".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS + 1),
      }),
    ).rejects.toThrow("over");
    expect(test.createThread).not.toHaveBeenCalled();
    test.createThread.mockRejectedValueOnce(new Error("Connection lost"));
    const values = { title: "Retry task", prompt: "Keep this text", delivery: "background" };
    await expect(original.onSubmit(values)).rejects.toThrow("Connection lost");
    const firstAttempt = test.createThread.mock.calls[0]?.[3];
    await expect(original.onSubmit({ ...values, prompt: "Changed" })).rejects.toThrow("unchanged");
    expect(test.createThread).toHaveBeenCalledTimes(1);
    await original.onSubmit(values);
    expect(test.createThread.mock.calls[1]?.[3]).toEqual(firstAttempt);
  });
});
