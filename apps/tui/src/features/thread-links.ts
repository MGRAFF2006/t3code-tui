import {
  CommandId,
  ORCHESTRATION_V2_WS_METHODS,
  WS_METHODS,
  threadIssueKeysEqual,
  type IssueDetail,
  type IssueListCursors,
  type IssueListEntry,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadShell,
  type ProjectId,
  type ThreadIssueLink,
  type ThreadPullRequestKey,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import {
  pullRequestLinkProject,
  resolveLinkPullRequestInput,
} from "@t3tools/client-runtime/pull-request-link-input";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { findProjectOnChangeRequestHost } from "@t3tools/client-runtime/change-request-links";
import { planThreadPullRequestMutation } from "@t3tools/client-runtime/thread-pull-request-compatibility";
import {
  threadPullRequestKeysEqual,
  threadPullRequestsOf,
  visibleThreadPullRequests,
} from "@t3tools/client-runtime/thread-pull-requests";
import * as SecureRandom from "effect/crypto/SecureRandom";
import type { Choice, FeatureProps } from "../ui/controller.ts";
import { request } from "../rpc/request.ts";

type PullRequestReference = ThreadPullRequestKey & { readonly url: string };
type IssueReference = Pick<
  IssueDetail,
  "tracker" | "host" | "scope" | "key" | "projectId" | "url" | "displayKey" | "title"
>;

export const threadLinkedPullRequests = (thread: OrchestrationV2ThreadShell) =>
  visibleThreadPullRequests(threadPullRequestsOf(thread));

export function createThreadLinks(props: FeatureProps, target: OrchestrationV2ThreadShell) {
  const environment = props.state()?.environmentId;
  const selected = props.state()?.selectedThreadId;
  const guard = () => {
    const state = props.state();
    if (!environment || state?.environmentId !== environment)
      throw new Error("The environment changed. Open thread links again.");
    if (state.selectedThreadId !== selected)
      throw new Error("The selected thread changed. Open thread links again.");
    if (state.connection !== "connected" || !state.config)
      throw new Error("Reconnect before changing thread links.");
    const current = [...(state.shell?.threads ?? []), ...(state.shell?.archivedThreads ?? [])].find(
      (thread) => thread.id === target.id && thread.deletedAt === null,
    );
    if (!current) throw new Error("This thread is no longer available.");
    return current;
  };
  const allowed = (command: OrchestrationV2Command) => {
    let value = false;
    const stop = props.client.observePermission(
      ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
      command,
      (next: boolean) => {
        value = next;
      },
    );
    const result = value;
    stop();
    return result;
  };
  const send = async (command: OrchestrationV2Command) => {
    guard();
    if (!allowed(command)) throw new Error("This connection does not allow changing thread links.");
    await request(props.client, ORCHESTRATION_V2_WS_METHODS.dispatchCommand, command);
    guard();
  };
  const commandId = () => CommandId.make(SecureRandom.uuidV4Unsafe());
  const pullRequestCommand = (
    reference: PullRequestReference,
    linked: boolean,
  ): OrchestrationV2Command => {
    const mutation = planThreadPullRequestMutation({
      capabilities: props.state()?.config?.environment.capabilities,
      threadId: target.id,
      reference,
      linked,
    });
    if (!mutation) throw new Error("This environment does not support pull request links.");
    return mutation.type === "thread.pull-request.link"
      ? { type: mutation.type, ...mutation.input, commandId: commandId() }
      : { type: mutation.type, ...mutation.input, commandId: commandId() };
  };
  const issueCommand = (issue: IssueReference, linked: boolean): OrchestrationV2Command => ({
    commandId: commandId(),
    threadId: target.id,
    tracker: issue.tracker,
    host: issue.host,
    scope: issue.scope,
    key: issue.key,
    ...(linked
      ? {
          type: "thread.issue.link",
          projectId: issue.projectId,
          url: issue.url,
          displayKey: issue.displayKey,
          title: issue.title,
          source: "manual",
        }
      : { type: "thread.issue.unlink" }),
  });
  const pullRequestChoice = (reference: PullRequestReference): Choice | null => {
    const linked = threadLinkedPullRequests(guard()).some((link) =>
      threadPullRequestKeysEqual(link, reference),
    );
    const command = pullRequestCommand(reference, !linked);
    if (!allowed(command)) return null;
    return {
      title: linked ? "Unlink pull request from thread" : "Link pull request to thread",
      description: target.title,
      run: () =>
        void props.ui.run(
          () => send(pullRequestCommand(reference, !linked)),
          linked ? "Pull request unlinked." : "Pull request linked.",
        ),
    };
  };
  const issueChoice = (issue: IssueReference): Choice | null => {
    const linked = (guard().issues ?? []).some((link) => threadIssueKeysEqual(link, issue));
    if (!allowed(issueCommand(issue, !linked))) return null;
    return {
      title: linked ? "Unlink issue from thread" : "Link issue to thread",
      description: target.title,
      run: () =>
        void props.ui.run(
          () => send(issueCommand(issue, !linked)),
          linked ? "Issue unlinked." : "Issue linked.",
        ),
    };
  };
  const openPullRequest = (link: ThreadPullRequestLink) => {
    guard();
    props.ui.choose(`${link.repository} #${link.number}`, [
      {
        title: "Read current pull request",
        run: () =>
          void props.ui.run(async () => {
            guard();
            const projects = (props.state()?.shell?.projects ?? []).map((project) => ({
              ...project,
              environmentId: environment!,
            }));
            const project = findProjectOnChangeRequestHost(projects, link);
            if (!project) throw new Error("No project on this environment can read this host.");
            const value = await request(props.client, WS_METHODS.pullRequestsDetail, {
              projectId: project.id,
              host: link.host,
              repository: link.repository,
              number: link.number,
            });
            guard();
            props.ui.text(
              `${value.repository} #${value.number}: ${value.title}`,
              [
                `${value.state}${value.isDraft ? " · Draft" : ""}`,
                `${value.headBranch} → ${value.baseBranch}`,
                `+${value.additions} −${value.deletions} · ${value.changedFiles} files`,
                value.url,
                value.body,
                value.checks.length ? "Checks" : "",
                ...value.checks.map((check) => `${check.name}: ${check.status}`),
              ]
                .filter(Boolean)
                .join("\n\n"),
              "markdown",
            );
          }),
      },
      ...externalChoices(link.url),
      ...choiceList(pullRequestChoice(link)),
    ]);
  };
  const openIssue = (link: ThreadIssueLink | IssueListEntry) => {
    guard();
    props.ui.choose(`${link.displayKey}: ${link.title}`, [
      {
        title: "Read current issue",
        run: () =>
          void props.ui.run(async () => {
            guard();
            const value = await request(props.client, WS_METHODS.issuesDetail, {
              projectId: link.projectId,
              tracker: link.tracker,
              host: link.host,
              scope: link.scope,
              key: link.key,
            });
            guard();
            props.ui.text(
              `${value.displayKey}: ${value.title}`,
              [value.state.name, value.url, value.body].filter(Boolean).join("\n\n"),
              "markdown",
            );
          }),
      },
      ...externalChoices(link.url),
      ...choiceList(issueChoice(link)),
    ]);
  };
  function externalChoices(url: string): Choice[] {
    return [
      ...(props.ui.openBrowser
        ? [{ title: "Open in browser", run: () => props.ui.openBrowser?.(url) }]
        : []),
      { title: "Show link", run: () => props.ui.text("Link", url) },
    ];
  }
  function linkPullRequest() {
    guard();
    props.ui.form({
      title: `Link pull request to ${target.title}`,
      fields: [
        {
          name: "reference",
          label: "Pull request URL or number",
          required: true,
          description: "A number uses this thread's project repository.",
        },
      ],
      submitLabel: "Link pull request",
      onSubmit: async ({ reference = "" }) => {
        guard();
        const project = props
          .state()
          ?.shell?.projects.find((entry) => entry.id === target.projectId);
        const resolved = resolveLinkPullRequestInput({
          reference,
          project: pullRequestLinkProject(project?.repositoryIdentity),
          hasProject: (value) => sourceControlClients.parseChangeRequestUrl(value.url) !== null,
        });
        if (resolved === null) throw new Error("Enter a supported pull request URL or number.");
        if ("error" in resolved) throw new Error(resolved.error);
        await send(pullRequestCommand(resolved.link, true));
        props.ui.notify("Pull request linked.");
      },
    });
  }
  async function listIssues(projectId: ProjectId, query = "", cursors?: IssueListCursors) {
    guard();
    const result = await request(props.client, WS_METHODS.issuesList, {
      projectId,
      state: "all",
      involvement: "all",
      sort: "updated",
      limit: 50,
      ...(query ? { query } : {}),
      ...(cursors ? { cursors } : {}),
    });
    guard();
    props.ui.choose("Link issue to thread", [
      {
        title: "Search issues…",
        run: () =>
          props.ui.form({
            title: "Search issues to link",
            fields: [{ name: "query", label: "Search", value: query }],
            onSubmit: async ({ query = "" }) => listIssues(projectId, query.trim()),
          }),
      },
      {
        title: "Choose project…",
        run: () => {
          guard();
          props.ui.choose(
            "Read issues through project",
            (props.state()?.shell?.projects ?? []).map((project) => ({
              title: project.title,
              description: project.workspaceRoot,
              run: () => void props.ui.run(() => listIssues(project.id)),
            })),
          );
        },
      },
      ...result.entries.map((issue) => ({
        title: `${issue.displayKey}: ${issue.title}`,
        description: `${issue.state.name} · ${issue.host}/${issue.scope}`,
        run: () => openIssue(issue),
      })),
      ...(Object.keys(result.nextCursors).length
        ? [
            {
              title: "Load more issues…",
              run: () => void props.ui.run(() => listIssues(projectId, query, result.nextCursors)),
            },
          ]
        : []),
      ...result.errors.map((error) => ({
        title: `Unavailable: ${error.projectTitle}`,
        description: error.message,
        run: () => props.ui.text(error.projectTitle, error.message),
      })),
      ...(!result.entries.length
        ? [
            {
              title: "No issues found",
              run: () => props.ui.notify("Change the search or project."),
            },
          ]
        : []),
    ]);
  }
  const choices = (): Choice[] => {
    const current = guard();
    const pullRequests = threadLinkedPullRequests(current);
    const issues = current.issues ?? [];
    const permitted = allowed({
      type: "thread.metadata.update",
      commandId: commandId(),
      threadId: target.id,
      title: current.title,
    });
    return [
      ...pullRequests.map((link) => ({
        title: `PR ${link.repository} #${link.number}${link.snapshot ? `: ${link.snapshot.title}` : ""}`,
        description: [
          link.snapshot?.state,
          link.snapshot?.checksState,
          link.watch ? "Watching" : null,
        ]
          .filter(Boolean)
          .join(" · "),
        run: () => openPullRequest(link),
      })),
      ...issues.map((link) => ({
        title: `${link.displayKey}: ${link.title}`,
        description: `${link.tracker} · ${link.scope}`,
        run: () => openIssue(link),
      })),
      ...(permitted
        ? [
            { title: "Link pull request…", run: linkPullRequest },
            {
              title: "Link issue…",
              run: () => void props.ui.run(() => listIssues(target.projectId)),
            },
          ]
        : []),
      ...(!pullRequests.length && !issues.length
        ? [{ title: "No linked pull requests or issues", run: () => {} }]
        : []),
    ];
  };
  return {
    choices,
    open: () => props.ui.choose(`Links for ${target.title}`, choices()),
    openPullRequest,
    openIssue,
    pullRequestChoice,
    issueChoice,
  };
}

function choiceList(choice: Choice | null): Choice[] {
  return choice ? [choice] : [];
}

export function threadLinkChoices(
  props: FeatureProps,
  target: OrchestrationV2ThreadShell,
): Choice[] {
  const links = createThreadLinks(props, target);
  return [
    {
      title: "Linked pull requests and issues…",
      description: `${threadLinkedPullRequests(target).length} pull requests · ${target.issues?.length ?? 0} issues`,
      run: links.open,
    },
  ];
}

export function pullRequestThreadLinkChoice(
  props: FeatureProps,
  reference: PullRequestReference,
): Choice[] {
  const target = selectedThread(props);
  return target ? choiceList(createThreadLinks(props, target).pullRequestChoice(reference)) : [];
}

export function issueThreadLinkChoice(props: FeatureProps, issue: IssueReference): Choice[] {
  const target = selectedThread(props);
  return target ? choiceList(createThreadLinks(props, target).issueChoice(issue)) : [];
}

function selectedThread(props: FeatureProps) {
  const state = props.state();
  return [...(state?.shell?.threads ?? []), ...(state?.shell?.archivedThreads ?? [])].find(
    (thread) => thread.id === state?.selectedThreadId && thread.deletedAt === null,
  );
}
