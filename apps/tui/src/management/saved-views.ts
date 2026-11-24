// @effect-diagnostics nodeBuiltinImport:off -- Named list views use the terminal's private state directory.
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import * as SecureRandom from "effect/crypto/SecureRandom";
import {
  EnvironmentId,
  IssueInvolvement,
  IssueListSort,
  IssueListState,
  ProjectId,
  PullRequestInvolvement,
  PullRequestListState,
} from "@t3tools/contracts";
import { PullRequestListSort } from "@t3tools/client-runtime/pull-request-list-preferences";
import { SavedViewIdentity, savedViewNameError } from "@t3tools/client-runtime/saved-views";
import {
  preparePrivateDirectory,
  readPrivateFile,
  writePrivateFile,
} from "../connections/files.ts";
import type { FeatureProps } from "../ui/controller.ts";
import { acquirePrivateStateLock } from "../connections/state-lock.ts";

const Query = Schema.String.check(Schema.isMaxLength(200));
export const PullRequestBrowseFilters = Schema.Struct({
  state: PullRequestListState,
  involvement: PullRequestInvolvement,
  query: Query,
  sort: PullRequestListSort,
});
export type PullRequestBrowseFilters = typeof PullRequestBrowseFilters.Type;
export const IssueBrowseFilters = Schema.Struct({
  state: IssueListState,
  involvement: IssueInvolvement,
  query: Query,
  labels: Schema.String.check(Schema.isMaxLength(4096)),
  assignee: Schema.String.check(Schema.isMaxLength(320)),
  sort: IssueListSort,
});
export type IssueBrowseFilters = typeof IssueBrowseFilters.Type;
const scopeFields = {
  environmentId: EnvironmentId,
  projectId: ProjectId,
};
const ViewInput = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("pull-requests"),
    ...scopeFields,
    filters: PullRequestBrowseFilters,
  }),
  Schema.Struct({
    kind: Schema.Literal("issues"),
    ...scopeFields,
    filters: IssueBrowseFilters,
  }),
]);
export type TuiSavedViewInput = typeof ViewInput.Type;
const View = Schema.Union([
  Schema.Struct({
    ...SavedViewIdentity.fields,
    ...ViewInput.members[0].fields,
  }),
  Schema.Struct({
    ...SavedViewIdentity.fields,
    ...ViewInput.members[1].fields,
  }),
]);
export type TuiSavedView = typeof View.Type;
const Document = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(1),
    views: Schema.Array(View).check(Schema.isMaxLength(200)),
  }),
);
const decode = Schema.decodeSync(Document);
const encode = Schema.encodeSync(Document);
const decodeView = Schema.decodeSync(View);

export async function createSavedViews(directory: string) {
  await preparePrivateDirectory(directory);
  const filename = NodePath.join(directory, "saved-views.json");
  const read = async (): Promise<readonly TuiSavedView[]> => {
    try {
      const contents = await readPrivateFile(filename);
      return contents === null ? [] : decode(contents).views;
    } catch (error) {
      throw new Error("Saved terminal views could not be read. The file was left unchanged.", {
        cause: error,
      });
    }
  };
  let pending: Promise<unknown> = Promise.resolve();
  const change = (transform: (views: readonly TuiSavedView[]) => readonly TuiSavedView[]) => {
    const operation = pending.then(async () => {
      const lock = await acquirePrivateStateLock(
        `${filename}.lock.sqlite`,
        "Saved terminal views are busy. Retry after other TUI writes finish.",
        { wait: false },
      );
      try {
        const views = transform(await read());
        await writePrivateFile(filename, encode({ version: 1, views }));
        return views;
      } finally {
        lock.close();
      }
    });
    pending = operation.catch(() => undefined);
    return operation;
  };
  const requireView = (views: readonly TuiSavedView[], id: string) => {
    const view = views.find((view) => view.id === id);
    if (!view) throw new Error("This saved view was removed. Open saved views again.");
    return view;
  };
  return {
    list: read,
    save: (input: TuiSavedViewInput, name: string, id?: string) =>
      change((views) => {
        if (id) requireView(views, id);
        const error = savedViewNameError(
          name,
          views.filter(
            (view) => view.kind === input.kind && view.environmentId === input.environmentId,
          ),
          id,
        );
        if (error) throw new Error(error);
        const next = decodeView({
          ...input,
          id: id ?? SecureRandom.uuidV4Unsafe(),
          name: name.trim(),
        });
        return id ? views.map((view) => (view.id === id ? next : view)) : [...views, next];
      }),
    rename: (id: string, name: string) =>
      change((views) => {
        const current = requireView(views, id);
        const error = savedViewNameError(
          name,
          views.filter(
            (view) => view.kind === current.kind && view.environmentId === current.environmentId,
          ),
          id,
        );
        if (error) throw new Error(error);
        return views.map((view) => (view.id === id ? { ...view, name: name.trim() } : view));
      }),
    remove: (id: string) => change((views) => views.filter((view) => view.id !== id)),
  };
}

export function savedViewProject(props: FeatureProps, view: TuiSavedViewInput) {
  const state = props.state();
  if (state?.environmentId !== view.environmentId)
    throw new Error("The environment changed. Open saved views again.");
  const project = state.shell?.projects.find((project) => project.id === view.projectId);
  if (!project) throw new Error("The saved view's project is unavailable on this environment.");
  return project;
}

export async function showSavedViews(
  props: FeatureProps,
  current: TuiSavedViewInput,
  apply: (view: TuiSavedView) => void,
) {
  savedViewProject(props, current);
  const store = await createSavedViews(props.client.localStateDirectory);
  const views = (await store.list()).filter(
    (view) => view.kind === current.kind && view.environmentId === current.environmentId,
  );
  savedViewProject(props, current);
  props.ui.choose(current.kind === "issues" ? "Saved issue views" : "Saved pull request views", [
    {
      title: "Save current view…",
      description: "Save these filters, sort order and project on this environment.",
      run: () =>
        props.ui.form({
          title: "Save current view",
          fields: [{ name: "name", label: "Name", required: true }],
          onSubmit: async ({ name = "" }) => {
            savedViewProject(props, current);
            await store.save(current, name);
            props.ui.notify("View saved.");
          },
        }),
    },
    ...views.map((view) => {
      const project = props
        .state()
        ?.shell?.projects.find((project) => project.id === view.projectId);
      const matches =
        view.projectId === current.projectId &&
        Object.entries(view.filters).every(
          ([key, value]) => Reflect.get(current.filters, key) === value,
        );
      return {
        title: `${matches ? "✓ " : ""}${view.name}`,
        description: `${project?.title ?? "Project unavailable"} · ${view.filters.state} · ${view.filters.involvement}${view.filters.query ? ` · ${view.filters.query}` : ""}`,
        run: () =>
          props.ui.choose(view.name, [
            {
              title: "Apply view",
              run: () => {
                savedViewProject(props, view);
                apply(view);
              },
            },
            {
              title: "Update from current list…",
              description: "Replace its filters, sort order and project.",
              run: () =>
                props.ui.confirm(
                  "Update saved view",
                  `Replace ${view.name} with the list captured when Saved views opened.`,
                  async () => {
                    savedViewProject(props, current);
                    await store.save(current, view.name, view.id);
                  },
                  "Update view",
                ),
            },
            {
              title: "Rename view…",
              run: () =>
                props.ui.form({
                  title: "Rename saved view",
                  fields: [{ name: "name", label: "Name", value: view.name, required: true }],
                  onSubmit: async ({ name = "" }) => {
                    savedViewProject(props, current);
                    await store.rename(view.id, name);
                  },
                }),
            },
            {
              title: "Delete view…",
              run: () =>
                props.ui.confirm(
                  "Delete saved view",
                  `Delete ${view.name}?`,
                  async () => {
                    savedViewProject(props, current);
                    await store.remove(view.id);
                  },
                  "Delete view",
                ),
            },
          ]),
      };
    }),
  ]);
}
