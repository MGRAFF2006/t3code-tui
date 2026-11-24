import {
  CommandId,
  MessageId,
  ThreadId,
  WS_METHODS,
  type EnvironmentId,
  type ModelSelection,
  type OrchestrationProjectShell,
  type OrchestrationV2ThreadLaunchWorkspaceStrategy,
  type RuntimeMode,
  resolveProjectProviderInstanceEnabled,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { getComposerPromptLengthFeedback } from "../conversation/prompt-length.ts";
import { selectableModels } from "../presentation/models.ts";
import { request } from "../rpc/request.ts";
import type { Choice, FeatureProps } from "../ui/controller.ts";
import type { ThreadLaunchContext } from "./launch-context.ts";

export interface NewThreadLaunchOptions {
  readonly projectId?: string;
  readonly isCurrent?: () => boolean;
  readonly onLaunched: (result: {
    environmentId: EnvironmentId;
    threadId: string;
    background: boolean;
  }) => Promise<void>;
  readonly onAddProject?: () => void;
  readonly onScratch?: () => void;
}

export function newThreadLaunch(props: FeatureProps, options: NewThreadLaunchOptions) {
  const origin = props.state()?.environmentId;
  if (!origin) throw new Error("Connect to an environment before creating a thread.");
  let context: ThreadLaunchContext;
  let project: OrchestrationProjectShell;
  let workspace: OrchestrationV2ThreadLaunchWorkspaceStrategy | undefined;
  let modelSelection: ModelSelection | undefined;
  let runtimeMode: RuntimeMode | undefined;
  let initialPrompt = "";
  let title = "New thread";
  let submission:
    | { commandId: CommandId; threadId: ThreadId; messageId: MessageId; fingerprint: string }
    | undefined;
  const isCurrent = () =>
    props.state()?.environmentId === origin && (options.isCurrent?.() ?? true);
  const guard = () => {
    if (!isCurrent()) throw new Error("The destination view changed. Open New thread again.");
  };
  const transport = () => props.client.captureTransportFor(context.environmentId);
  const run = (action: () => Promise<unknown>) => void props.ui.run(action);
  const settings = () =>
    resolveProjectSettings(context.config.settings, project.id, project).settings;
  const workspaceLabel = () =>
    workspace?.type === "root"
      ? "Main checkout"
      : workspace?.type === "existing_worktree"
        ? workspace.worktreePath
        : workspace?.type === "worktree"
          ? `New worktree from ${workspace.baseRef}`
          : "Project default";

  function show() {
    guard();
    props.ui.choose(`New thread · ${project.title}`, [
      {
        title: "Create thread",
        description: `${context.config.environment.label} · ${workspaceLabel()} · open an empty composer`,
        run: () => run(() => launch(false)),
      },
      {
        title: "Compose initial prompt…",
        description: "Send and open the thread, or send in the background and keep composing.",
        run: compose,
      },
      {
        title: `Machine: ${context.config.environment.label}`,
        description: "Choose the destination for this draft without changing the current view.",
        run: () => run(machines),
      },
      { title: `Project: ${project.title}`, description: project.workspaceRoot, run: projects },
      { title: `Workspace: ${workspaceLabel()}`, run: chooseWorkspace },
      ...(workspace?.type === "worktree"
        ? [
            {
              title: `Base branch: ${workspace.baseRef}`,
              run: () => run(() => branches()),
            },
            {
              title: `Remote starting point: ${workspace.startFromOrigin ? "On" : "Off"}`,
              description: "Fetch the selected branch's remote tip before creating the worktree.",
              run: () => {
                guard();
                if (workspace?.type !== "worktree") return;
                workspace = { ...workspace, startFromOrigin: !workspace.startFromOrigin };
                show();
              },
            },
          ]
        : []),
      {
        title: `Model: ${modelSelection?.model ?? "Project default"}`,
        run: chooseModel,
      },
      { title: `Permissions: ${runtimeMode ?? "Project default"}`, run: permissions },
    ]);
  }

  async function launch(background: boolean, prompt?: string) {
    guard();
    const text = prompt?.trim();
    if (background && !text) throw new Error("Enter a prompt before submitting in the background.");
    const feedback = getComposerPromptLengthFeedback(text ?? "");
    if (feedback.message) throw new Error(feedback.message);
    if (!background && !(await props.ui.beforeNavigate())) return;
    guard();
    const fingerprint = JSON.stringify({
      environmentId: context.environmentId,
      projectId: project.id,
      title,
      text,
      workspace,
      modelSelection,
      runtimeMode,
    });
    if (submission && submission.fingerprint !== fingerprint)
      throw new Error(
        "Retry the previous launch unchanged before changing its options or prompt. Its outcome is still unknown.",
      );
    submission ??= {
      threadId: ThreadId.make(SecureRandom.uuidV4Unsafe()),
      commandId: CommandId.make(SecureRandom.uuidV4Unsafe()),
      messageId: MessageId.make(SecureRandom.uuidV4Unsafe()),
      fingerprint,
    };
    const environmentId = context.environmentId;
    const id = await props.client.createThread(project.id, title.trim() || "New thread", text, {
      environmentId,
      commandId: submission.commandId,
      threadId: submission.threadId,
      messageId: submission.messageId,
      ...(workspace ? { workspaceStrategy: workspace } : {}),
      ...(modelSelection ? { modelSelection } : {}),
      ...(runtimeMode ? { runtimeMode } : {}),
    });
    submission = undefined;
    props.ui.notify(`Thread created on ${context.config.environment.label}.`);
    if (!isCurrent()) return;
    await options.onLaunched({ environmentId, threadId: id, background });
    if (background && isCurrent()) {
      initialPrompt = "";
      title = "New thread";
      compose();
    }
  }

  function compose() {
    guard();
    props.ui.form({
      title: `New thread · ${project.title}`,
      description: `${context.config.environment.label} · ${workspaceLabel()}. Background submission keeps these launch options and opens a fresh prompt.`,
      fields: [
        { name: "title", label: "Thread title", value: title, required: true },
        {
          name: "prompt",
          label: "Initial prompt",
          type: "multiline",
          value: initialPrompt,
          required: true,
        },
        {
          name: "delivery",
          label: "After sending",
          type: "select",
          value: "open",
          options: [
            { label: "Open the created thread", value: "open" },
            { label: "Stay in a fresh draft", value: "background" },
          ],
        },
      ],
      submitLabel: "Create and send",
      onSubmit: async (values) => {
        guard();
        title = values.title ?? title;
        initialPrompt = values.prompt ?? "";
        await launch(values.delivery === "background", initialPrompt);
      },
    });
  }

  async function machines() {
    guard();
    const available = await props.client.environments();
    guard();
    props.ui.choose(
      "Launch destination",
      available.map((environment) => ({
        title: environment.label,
        description:
          environment.environmentId === context.environmentId
            ? "Selected for this draft"
            : "Projects and defaults belong to this machine",
        run: () =>
          run(async () => {
            guard();
            const next = await props.client.prepareThreadLaunch(environment.environmentId);
            guard();
            context = next;
            workspace = undefined;
            modelSelection = undefined;
            runtimeMode = undefined;
            projects();
          }),
      })),
    );
  }

  function projects() {
    guard();
    props.ui.choose(`New thread on ${context.config.environment.label}`, [
      { title: "Choose another machine…", run: () => run(machines) },
      ...context.shell.projects
        .filter((entry) => !entry.archivedAt)
        .map((entry) => ({
          title: entry.title,
          description: entry.workspaceRoot,
          run: () => {
            guard();
            project = entry;
            workspace = undefined;
            modelSelection = undefined;
            runtimeMode = undefined;
            show();
          },
        })),
      ...(context.environmentId === origin && options.onScratch
        ? [{ title: "New scratch conversation", run: options.onScratch }]
        : []),
      ...(context.environmentId === origin && options.onAddProject
        ? [{ title: "Add project…", run: options.onAddProject }]
        : []),
    ]);
  }

  async function branches(cursor = 0, query = "") {
    guard();
    const capturedContext = context;
    const capturedProject = project;
    const result = await request(await transport(), WS_METHODS.vcsListRefs, {
      cwd: project.workspaceRoot,
      refKind: "all",
      limit: 100,
      cursor,
      ...(query.trim() ? { query: query.trim() } : {}),
    });
    guard();
    if (context !== capturedContext || project !== capturedProject) return;
    if (!result.isRepo)
      throw new Error("This project is not a Git repository. Use its main checkout.");
    props.ui.choose("Worktree base branch", [
      {
        title: "Search branches…",
        description: query || "Search local and remote refs",
        run: () =>
          props.ui.form({
            title: "Search base branches",
            fields: [{ name: "query", label: "Branch query", value: query }],
            onSubmit: async ({ query: next = "" }) => branches(0, next),
          }),
      },
      {
        title: "Enter a reference…",
        description: "Local branch, remote branch, tag or commit",
        run: () =>
          props.ui.form({
            title: "Worktree base reference",
            fields: [{ name: "ref", label: "Branch, tag or commit", value: query, required: true }],
            onSubmit: async ({ ref = "" }) => {
              guard();
              const previous = workspace?.type === "worktree" ? workspace : undefined;
              workspace = {
                type: "worktree",
                baseRef: ref.trim(),
                startFromOrigin:
                  previous?.startFromOrigin ?? settings().newWorktreesStartFromOrigin,
              };
              show();
            },
          }),
      },
      ...result.refs.map((ref) => ({
        title: ref.name,
        description: [
          ref.isDefault ? "Default branch" : null,
          ref.isRemote ? "Remote" : "Local",
          ref.current ? "Current checkout" : null,
        ]
          .filter(Boolean)
          .join(" · "),
        run: () => {
          guard();
          const previous = workspace?.type === "worktree" ? workspace : undefined;
          workspace = {
            type: "worktree",
            baseRef: ref.name,
            startFromOrigin: previous?.startFromOrigin ?? settings().newWorktreesStartFromOrigin,
          };
          show();
        },
      })),
      ...(result.nextCursor === null
        ? []
        : [{ title: "More branches…", run: () => run(() => branches(result.nextCursor!, query)) }]),
    ]);
  }

  async function existingWorktrees(cursor = 0) {
    guard();
    const capturedContext = context;
    const capturedProject = project;
    const result = await request(await transport(), WS_METHODS.vcsListRefs, {
      cwd: project.workspaceRoot,
      refKind: "local",
      limit: 100,
      cursor,
    });
    guard();
    if (context !== capturedContext || project !== capturedProject) return;
    const seen = new Set<string>();
    const choices: Choice[] = result.refs.flatMap((ref) => {
      if (
        !ref.worktreePath ||
        ref.worktreePath === project.workspaceRoot ||
        seen.has(ref.worktreePath)
      )
        return [];
      seen.add(ref.worktreePath);
      const path = ref.worktreePath;
      return [
        {
          title: ref.name,
          description: path,
          run: () => {
            guard();
            workspace = { type: "existing_worktree", worktreePath: path, branch: ref.name };
            show();
          },
        },
      ];
    });
    props.ui.choose("Existing worktrees", [
      {
        title: "Enter worktree path…",
        description: "Also supports a detached worktree",
        run: () =>
          props.ui.form({
            title: "Existing worktree",
            fields: [
              {
                name: "path",
                label: "Worktree directory on the destination machine",
                required: true,
              },
            ],
            onSubmit: async ({ path = "" }) => {
              guard();
              workspace = { type: "existing_worktree", worktreePath: path.trim() };
              show();
            },
          }),
      },
      ...choices,
      ...(result.nextCursor === null
        ? []
        : [
            {
              title: "More worktrees…",
              run: () => run(() => existingWorktrees(result.nextCursor!)),
            },
          ]),
      { title: "Back to launch options", run: show },
    ]);
  }

  function chooseWorkspace() {
    guard();
    props.ui.choose("Thread workspace", [
      {
        title: "Project default",
        description: "Preserve the environment, project and t3.json launch policy.",
        run: () => {
          workspace = undefined;
          show();
        },
      },
      {
        title: "Main checkout",
        description: project.workspaceRoot,
        run: () => {
          workspace = { type: "root" };
          show();
        },
      },
      { title: "Existing worktree…", run: () => run(() => existingWorktrees()) },
      { title: "New worktree…", run: () => run(() => branches()) },
    ]);
  }

  function chooseModel() {
    guard();
    props.ui.choose("Launch model", [
      {
        title: "Project default",
        description: "Resolve defaults and usage fallback on the destination at launch.",
        run: () => {
          modelSelection = undefined;
          show();
        },
      },
      ...selectableModels(
        context.config.providers.filter((provider) =>
          resolveProjectProviderInstanceEnabled(
            context.config.settings,
            project.id,
            provider.instanceId,
          ),
        ),
        context.config.settings,
        modelSelection,
      ).map(({ provider, model }) => ({
        title: model.name,
        category: provider.displayName ?? provider.driver,
        description: model.slug,
        run: () => {
          guard();
          modelSelection = { instanceId: provider.instanceId, model: model.slug };
          show();
        },
      })),
    ]);
  }

  function permissions() {
    guard();
    props.ui.choose("Launch permissions", [
      {
        title: "Project default",
        run: () => {
          runtimeMode = undefined;
          show();
        },
      },
      ...(["approval-required", "auto-accept-edits", "auto", "full-access"] as const).map(
        (mode) => ({
          title: mode,
          run: () => {
            guard();
            runtimeMode = mode;
            show();
          },
        }),
      ),
    ]);
  }

  run(async () => {
    context = await props.client.prepareThreadLaunch(origin);
    guard();
    const selected = context.shell.projects.find((entry) => entry.id === options.projectId);
    if (selected) {
      project = selected;
      show();
    } else projects();
  });
}
