import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import {
  sortActiveThreadsByOrderKey,
  sortPinnedThreadsByOrderKey,
} from "@t3tools/client-runtime/state/thread-sort";
import { v2ThreadShell } from "../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures.ts";
import { planThreadReorder } from "./thread-organization.logic.ts";

const environmentId = EnvironmentId.make("environment-1");
const now = "2026-06-20T12:00:00.000Z";
const thread = (
  id: string,
  patch: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell => ({
  ...v2ThreadShell,
  id: ThreadId.make(id),
  projectId: ProjectId.make(id),
  latestUserMessageAt: null,
  ...patch,
});
const presented = (threads: readonly OrchestrationV2ThreadShell[]) =>
  threads.map((row) => ({
    ...row,
    createdAt: DateTime.formatIso(row.createdAt),
    unsettledAt: row.unsettledAt ? DateTime.formatIso(row.unsettledAt) : null,
  }));

describe("terminal persistent thread order", () => {
  it("persists active moves across projects from keyless rows without changing pinned, snoozed or archived placements", () => {
    const active = [thread("a"), thread("b"), thread("c")];
    const hidden = [
      thread("pinned", { pinnedAt: v2ThreadShell.createdAt, pinOrderKey: "V" }),
      thread("snoozed", {
        snoozedAt: v2ThreadShell.createdAt,
        snoozedUntil: DateTime.makeUnsafe("2026-06-21T12:00:00Z"),
        activeOrderKey: "V",
      }),
      thread("archived", { archivedAt: v2ThreadShell.createdAt, activeOrderKey: "j" }),
      thread("settled", { settledOverride: "settled", activeOrderKey: "r" }),
    ];
    const input = [...active, ...hidden];
    const changes = planThreadReorder({
      threads: input,
      targetId: active[2]!.id,
      environmentId,
      now,
      move: "first",
    });
    expect(changes.map((change) => change.id).sort()).toEqual(["a", "b", "c"]);
    expect(
      changes.every(
        (change) => change.orderKey !== "V" && change.orderKey !== "j" && change.orderKey !== "r",
      ),
    ).toBe(true);
    const keys = new Map(changes.map((change) => [change.id, change.orderKey]));
    const saved = active.map((row) => ({
      ...row,
      activeOrderKey: keys.get(row.id) ?? row.activeOrderKey,
    }));
    expect(sortActiveThreadsByOrderKey(presented(saved)).map((row) => row.id)).toEqual([
      "c",
      "a",
      "b",
    ]);
    const second = planThreadReorder({
      threads: [...saved, ...hidden],
      targetId: active[2]!.id,
      environmentId,
      now,
      move: "down",
    });
    const secondKeys = new Map(second.map((change) => [change.id, change.orderKey]));
    const moved = saved.map((row) => ({
      ...row,
      activeOrderKey: secondKeys.get(row.id) ?? row.activeOrderKey,
    }));
    expect(sortActiveThreadsByOrderKey(presented(moved)).map((row) => row.id)).toEqual([
      "a",
      "c",
      "b",
    ]);
    expect(hidden.map((row) => [row.id, row.activeOrderKey])).toEqual([
      ["pinned", undefined],
      ["snoozed", "V"],
      ["archived", "j"],
      ["settled", "r"],
    ]);
  });

  it("reorders the pinned shelf independently and safely no-ops on boundaries or unavailable targets", () => {
    const pinned = [
      thread("a", { pinnedAt: v2ThreadShell.createdAt, pinOrderKey: "F" }),
      thread("b", { pinnedAt: v2ThreadShell.createdAt, pinOrderKey: "U" }),
      thread("c", { pinnedAt: v2ThreadShell.createdAt, pinOrderKey: "j" }),
    ];
    const other = thread("active", { activeOrderKey: "1" });
    const changes = planThreadReorder({
      threads: [...pinned, other],
      targetId: pinned[0]!.id,
      environmentId,
      now,
      move: "last",
    });
    expect(changes).toHaveLength(1);
    const saved = pinned.map((row) => ({
      ...row,
      pinOrderKey: changes.find((change) => change.id === row.id)?.orderKey ?? row.pinOrderKey,
    }));
    expect(sortPinnedThreadsByOrderKey(presented(saved)).map((row) => row.id)).toEqual([
      "b",
      "c",
      "a",
    ]);
    expect(
      planThreadReorder({
        threads: saved,
        targetId: pinned[0]!.id,
        environmentId,
        now,
        move: "down",
      }),
    ).toEqual([]);
    expect(
      planThreadReorder({
        threads: saved,
        targetId: ThreadId.make("deleted"),
        environmentId,
        now,
        move: "first",
      }),
    ).toEqual([]);
    expect(
      planThreadReorder({
        threads: [
          thread("sleep", {
            snoozedAt: v2ThreadShell.createdAt,
            snoozedUntil: DateTime.makeUnsafe("2026-06-21T12:00:00Z"),
          }),
        ],
        targetId: ThreadId.make("sleep"),
        environmentId,
        now,
        move: "first",
      }),
    ).toEqual([]);
  });
});
