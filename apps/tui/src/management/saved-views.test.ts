// @effect-diagnostics nodeBuiltinImport:off -- Saved-view persistence is verified against isolated private files.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { createSavedViews, savedViewProject, type TuiSavedViewInput } from "./saved-views.ts";
import {
  v2Project,
  v2ShellSnapshot,
} from "../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures.ts";
import type { TuiSnapshot } from "../runtime/client.ts";
import type { FeatureProps } from "../ui/controller.ts";

const input: TuiSavedViewInput = {
  kind: "pull-requests",
  environmentId: EnvironmentId.make("environment-1"),
  projectId: v2Project.id,
  filters: { query: "draft cleanup", involvement: "authored", state: "all", sort: "largest" },
};

describe("private saved list views", () => {
  it("merges another terminal's saved views while updating, renaming and removing a named view", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-tui-views-"));
    try {
      const first = await createSavedViews(directory);
      const second = await createSavedViews(directory);
      await first.save(input, "  My pull requests  ");
      const id = (await first.list())[0]!.id;
      const issues: TuiSavedViewInput = {
        kind: "issues",
        environmentId: input.environmentId,
        projectId: input.projectId,
        filters: {
          state: "closed",
          involvement: "assigned",
          query: "follow up",
          labels: "done",
          assignee: "me",
          sort: "created",
        },
      };
      await second.save(issues, "Follow up");
      await first.rename(id, "Assigned work");
      await second.save(
        { ...input, filters: { ...input.filters, sort: "oldest" } },
        "Assigned work",
        id,
      );
      const reopened = await createSavedViews(directory);
      const views = await reopened.list();
      expect(views).toHaveLength(2);
      expect(views.find((view) => view.id === id)).toEqual({
        ...input,
        id,
        name: "Assigned work",
        filters: { ...input.filters, sort: "oldest" },
      });
      expect(views.find((view) => view.kind === "issues")).toMatchObject({
        ...issues,
        name: "Follow up",
      });
      await first.remove(id);
      expect((await second.list()).map((view) => view.kind)).toEqual(["issues"]);
      expect((await NodeFSP.stat(NodePath.join(directory, "saved-views.json"))).mode & 0o777).toBe(
        0o600,
      );
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects conflicting names and stale updates, and leaves locked or damaged view files unchanged", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-tui-views-"));
    try {
      const store = await createSavedViews(directory);
      await store.save(input, "My work");
      await expect(store.save(input, "  MY WORK ")).rejects.toThrow("already exists");
      await store.save(
        { ...input, environmentId: EnvironmentId.make("another-environment") },
        "My work",
      );
      const id = (await store.list())[0]!.id;
      await store.remove(id);
      await expect(store.save(input, "My work", id)).rejects.toThrow("removed");
      await store.save(input, "My work");
      const filename = NodePath.join(directory, "saved-views.json");
      const saved = await NodeFSP.readFile(filename, "utf8");
      await NodeFSP.writeFile(`${filename}.lock`, "other writer");
      await expect(store.save(input, "New view")).rejects.toThrow("busy");
      expect(await NodeFSP.readFile(filename, "utf8")).toBe(saved);
      await NodeFSP.rm(`${filename}.lock`);
      await NodeFSP.writeFile(filename, "{broken json");
      await expect(store.list()).rejects.toThrow("left unchanged");
      await expect(store.save(input, "New view")).rejects.toThrow("left unchanged");
      expect(await NodeFSP.readFile(filename, "utf8")).toBe("{broken json");
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses to restore a saved project on a different environment even when its project id collides", () => {
    let state = {
      environmentId: input.environmentId,
      shell: v2ShellSnapshot,
    } as TuiSnapshot;
    const props = { state: () => state } as FeatureProps;
    expect(savedViewProject(props, input)).toBe(v2Project);
    state = { ...state, environmentId: EnvironmentId.make("other-environment") };
    expect(() => savedViewProject(props, input)).toThrow("environment changed");
    state = {
      ...state,
      environmentId: input.environmentId,
      shell: { ...v2ShellSnapshot, projects: [] },
    };
    expect(() => savedViewProject(props, input)).toThrow("project is unavailable");
    expect(() =>
      savedViewProject(props, { ...input, projectId: ProjectId.make("other-project") }),
    ).toThrow("project is unavailable");
  });
});
