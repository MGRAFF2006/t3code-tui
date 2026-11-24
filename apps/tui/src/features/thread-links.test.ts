import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  IssueTrackerKind,
  SourceControlProviderKind,
  ThreadId,
  WS_METHODS,
  type IssueListEntry,
  type IssueListResult,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadShell,
  type RepositoryIdentity,
  type ServerConfig,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import {
  v2Project,
  v2ShellSnapshot,
  v2ThreadShell,
} from "../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures.ts";
import type { TuiClient, TuiSnapshot } from "../runtime/client.ts";
import type { Choice, FeatureProps, FieldFormOptions, UiController } from "../ui/controller.ts";
import { createThreadLinks, threadLinkChoices, threadLinkedPullRequests } from "./thread-links.ts";

const reference = {
  host: "github.com",
  repository: "acme/app",
  number: 12,
  url: "https://github.com/acme/app/pull/12",
};
const linked: ThreadPullRequestLink = {
  ...reference,
  source: "manual",
  linkedAt: "2026-11-24T10:00:00.000Z",
  snapshot: null,
  stack: null,
};
const issue: IssueListEntry = {
  projectId: v2Project.id,
  projectTitle: v2Project.title,
  tracker: IssueTrackerKind.make("github"),
  host: "github.com",
  scope: "acme/app",
  key: "4",
  displayKey: "#4",
  title: "Read-only tracker issue",
  url: "https://github.com/acme/app/issues/4",
  author: null,
  state: { category: "open", name: "Open" },
  createdAt: "2026-11-24T09:00:00.000Z",
  updatedAt: "2026-11-24T10:00:00.000Z",
  closedAt: null,
  assignees: [],
  labels: [],
  commentCount: 0,
};
const issuePage = (entries: IssueListEntry[], nextCursors = {}): IssueListResult => ({
  entries,
  nextCursors,
  errors: [],
  viewers: {},
  trackers: [],
});

function harness(target: OrchestrationV2ThreadShell = v2ThreadShell) {
  const original: TuiSnapshot = {
    environmentId: EnvironmentId.make("environment-1"),
    label: "Fixture",
    connection: "connected",
    error: null,
    config: { environment: { capabilities: {} } } as ServerConfig,
    shell: {
      ...v2ShellSnapshot,
      projects: [
        {
          ...v2Project,
          repositoryIdentity: {
            canonicalKey: "github.com/acme/app",
            provider: SourceControlProviderKind.make("github"),
            displayName: "acme/app",
            locator: {
              source: "git-remote",
              remoteName: "origin",
              remoteUrl: "https://github.com/acme/app.git",
            },
          } satisfies RepositoryIdentity,
        },
      ],
      threads: [target],
    },
    selectedThreadId: target.id,
    thread: null,
    hasMoreHistory: false,
    workspaceMutationId: null,
  };
  let state = original;
  let permitted = true;
  let observers = 0;
  let menu: Choice[] = [];
  let form: FieldFormOptions | undefined;
  let pending: Promise<unknown> = Promise.resolve();
  let handleRequest: (method: string, input: unknown) => Promise<unknown> = async () => ({});
  const sent: { method: string; input: unknown }[] = [];
  const texts: string[] = [];
  const props: FeatureProps = {
    client: {
      observePermission: (_method: string, _input: unknown, listener: (value: boolean) => void) => {
        observers += 1;
        listener(permitted);
        return () => {
          observers -= 1;
          listener(false);
        };
      },
      invoke: async (method: string, input: unknown) => {
        sent.push({ method, input });
        return handleRequest(method, input);
      },
    } as unknown as TuiClient,
    state: () => state,
    ui: {
      choose: (_title: string, options: Choice[]) => {
        menu = options;
      },
      form: (value: FieldFormOptions) => {
        form = value;
      },
      text: (_title: string, content: string) => texts.push(content),
      notify: () => {},
      run: (action: () => Promise<unknown>) => {
        pending = action();
        return pending;
      },
    } as unknown as UiController,
    focused: true,
    onFocus: () => {},
  };
  const choose = (title: string) => {
    const option = menu.find((option) => option.title === title);
    if (!option) throw new Error(`Missing choice ${title}: ${menu.map((option) => option.title)}`);
    option.run();
  };
  return {
    props,
    original,
    sent,
    texts,
    choose,
    menu: () => menu,
    form: () => {
      if (!form) throw new Error("No form opened");
      return form;
    },
    pending: () => pending,
    observers: () => observers,
    setState: (next: TuiSnapshot) => {
      state = next;
    },
    setPermission: (next: boolean) => {
      permitted = next;
    },
    setRequest: (next: typeof handleRequest) => {
      handleRequest = next;
    },
  };
}

describe("native thread pull request and issue links", () => {
  it("resolves a bare PR against the captured project and rechecks thread, environment and permission on form submission", async () => {
    const test = harness();
    const staleMenu = threadLinkChoices(test.props, v2ThreadShell);
    createThreadLinks(test.props, v2ThreadShell).open();
    test.choose("Link pull request…");
    const form = test.form();
    test.setState({ ...test.original, environmentId: EnvironmentId.make("other-environment") });
    expect(() => staleMenu[0]!.run()).toThrow("environment changed");
    await expect(form.onSubmit({ reference: "#12" })).rejects.toThrow("environment changed");
    test.setState({ ...test.original, selectedThreadId: ThreadId.make("another-thread") });
    await expect(form.onSubmit({ reference: "#12" })).rejects.toThrow("selected thread changed");
    test.setState(test.original);
    test.setPermission(false);
    await expect(form.onSubmit({ reference: "#12" })).rejects.toThrow("does not allow");
    expect(test.sent).toEqual([]);
    expect(test.observers()).toBe(0);
    test.setPermission(true);
    await form.onSubmit({ reference: "#12" });
    expect(test.sent[0]?.input).toMatchObject({
      type: "thread.pull-request.link",
      threadId: v2ThreadShell.id,
      ...reference,
      source: "manual",
    });
    const command = test.sent[0]?.input as OrchestrationV2Command;
    expect(command.commandId).toBeTruthy();
    expect(test.observers()).toBe(0);
  });

  it("offers legacy PR unlink and filters dismissed stack members without reviving an explicitly empty link list", async () => {
    const legacy = {
      ...v2ThreadShell,
      linkedPullRequest: { ...reference, projectId: v2Project.id },
    };
    const test = harness(legacy);
    const links = createThreadLinks(test.props, legacy);
    links.open();
    expect(test.menu().find((option) => option.title === "PR acme/app #12")).toBeDefined();
    test.choose("PR acme/app #12");
    test.choose("Unlink pull request from thread");
    await test.pending();
    expect(test.sent[0]?.input).toMatchObject({
      type: "thread.pull-request.unlink",
      threadId: legacy.id,
      host: reference.host,
      repository: reference.repository,
      number: reference.number,
    });
    expect(threadLinkedPullRequests({ ...legacy, pullRequests: [] })).toEqual([]);
    expect(
      threadLinkedPullRequests({
        ...v2ThreadShell,
        pullRequests: [linked, { ...linked, number: 13, source: "stack-dismissed" }],
      }).map((link) => link.number),
    ).toEqual([12]);
  });

  it("pages tracker issues and links or unlinks them independently of tracker write access", async () => {
    const test = harness();
    test.setRequest(async (method, input) => {
      if (method === WS_METHODS.issuesList)
        return "cursors" in (input as Record<string, unknown>)
          ? issuePage([issue])
          : issuePage([], { "github.com acme/app": "older" });
      return {};
    });
    createThreadLinks(test.props, v2ThreadShell).open();
    test.choose("Link issue…");
    await test.pending();
    test.choose("Load more issues…");
    await test.pending();
    expect(test.sent[1]).toEqual({
      method: WS_METHODS.issuesList,
      input: {
        projectId: v2Project.id,
        state: "all",
        involvement: "all",
        sort: "updated",
        limit: 50,
        cursors: { "github.com acme/app": "older" },
      },
    });
    test.choose("#4: Read-only tracker issue");
    test.choose("Link issue to thread");
    await test.pending();
    expect(test.sent[2]?.input).toMatchObject({
      type: "thread.issue.link",
      threadId: v2ThreadShell.id,
      tracker: "github",
      host: "github.com",
      scope: "acme/app",
      key: "4",
      projectId: v2Project.id,
      displayKey: "#4",
      title: issue.title,
      url: issue.url,
      source: "manual",
    });
    const target = {
      ...v2ThreadShell,
      issues: [{ ...issue, source: "manual" as const, linkedAt: "2026-11-24T10:00:00.000Z" }],
    };
    test.setState({ ...test.original, shell: { ...test.original.shell!, threads: [target] } });
    createThreadLinks(test.props, target).openIssue(target.issues[0]!);
    test.setPermission(false);
    test.choose("Unlink issue from thread");
    await expect(test.pending()).rejects.toThrow("does not allow");
    test.setPermission(true);
    test.choose("Unlink issue from thread");
    await test.pending();
    expect(test.sent[3]?.input).toMatchObject({
      type: "thread.issue.unlink",
      threadId: v2ThreadShell.id,
      tracker: "github",
      host: "github.com",
      scope: "acme/app",
      key: "4",
    });
  });

  it("keeps read-only link details available and discards a detail reply after navigation", async () => {
    const target = { ...v2ThreadShell, pullRequests: [linked] };
    const test = harness(target);
    test.setPermission(false);
    const links = createThreadLinks(test.props, target);
    links.open();
    expect(test.menu().map((option) => option.title)).toEqual(["PR acme/app #12"]);
    test.choose("PR acme/app #12");
    expect(test.menu().map((option) => option.title)).toEqual([
      "Read current pull request",
      "Show link",
    ]);
    const deferred = Promise.withResolvers<unknown>();
    test.setRequest(() => deferred.promise);
    test.choose("Read current pull request");
    test.setState({ ...test.original, selectedThreadId: ThreadId.make("another-thread") });
    deferred.resolve({ ...reference, title: "Late result", checks: [], body: "Do not show" });
    await expect(test.pending()).rejects.toThrow("selected thread changed");
    expect(test.texts).toEqual([]);
    expect(test.sent).toHaveLength(1);
    expect(test.sent[0]).toEqual({
      method: WS_METHODS.pullRequestsDetail,
      input: { projectId: v2Project.id, host: "github.com", repository: "acme/app", number: 12 },
    });
  });
});
