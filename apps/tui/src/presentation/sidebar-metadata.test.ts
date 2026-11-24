import { expect, it } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  type ServerProvider,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import { v2ThreadShell } from "../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures.ts";
import {
  threadFolderIndicator,
  threadProviderIdentity,
  threadPullRequestIndicator,
} from "./sidebar-metadata.ts";
import * as DateTime from "effect/DateTime";
import { EnvironmentId } from "@t3tools/contracts";
import { theme } from "../theme/index.ts";

it("keeps the selected provider instance distinct from other accounts of the same driver", () => {
  const provider = {
    instanceId: ProviderInstanceId.make("claude-work"),
    driver: ProviderDriverKind.make("claudeAgent"),
    displayName: "Claude Work",
    accentColor: "#12ab34",
  } as ServerProvider;
  const thread = {
    ...v2ThreadShell,
    providerInstanceId: provider.instanceId,
    latestRunId: RunId.make("active-run"),
  };
  const identity = threadProviderIdentity(thread, [
    provider,
    {
      ...provider,
      instanceId: ProviderInstanceId.make("claude-personal"),
      displayName: "Claude Personal",
    },
  ]);
  expect(identity).toEqual({ symbol: "CL:CW", label: "Claude Work", color: "#12ab34" });
  expect(threadProviderIdentity(thread, [{ ...provider, accentColor: "invalid" }]).color).toBe(
    "#d97757",
  );
  expect(
    threadProviderIdentity(
      { ...thread, providerInstanceId: ProviderInstanceId.make("removed-provider") },
      [provider],
    ).label,
  ).toBe("removed-provider");
  expect(threadProviderIdentity({ ...thread, latestRunId: null }, [provider]).label).toBe(
    v2ThreadShell.modelSelection.instanceId,
  );
});

it("uses the current visible PR snapshot without inventing passing checks for missing data", () => {
  const link: ThreadPullRequestLink = {
    host: "github.com",
    repository: "acme/app",
    number: 12,
    url: "https://github.com/acme/app/pull/12",
    source: "manual",
    linkedAt: "2026-11-24T10:00:00.000Z",
    snapshot: {
      state: "open",
      title: "Active work",
      headBranch: "feature",
      baseBranch: "main",
      isDraft: false,
      updatedAt: null,
      syncedAt: "2026-11-24T10:00:00.000Z",
      checksState: "failing",
    },
    stack: null,
  };
  const dismissed = { ...link, number: 13, source: "stack-dismissed" as const };
  const closed = { ...link, number: 10, snapshot: { ...link.snapshot!, state: "closed" as const } };
  expect(
    threadPullRequestIndicator({ ...v2ThreadShell, pullRequests: [closed, link, dismissed] }),
  ).toEqual({ label: "#12+1 checks failing", color: theme.error });
  expect(
    threadPullRequestIndicator({ ...v2ThreadShell, pullRequests: [{ ...link, snapshot: null }] })
      ?.label,
  ).toBe("#12 status unknown");
  expect(threadPullRequestIndicator({ ...v2ThreadShell, pullRequests: [dismissed] })).toBeNull();
  expect(
    threadPullRequestIndicator({
      ...v2ThreadShell,
      pullRequests: [{ ...link, snapshot: { ...link.snapshot!, state: "closed" } }],
    }),
  ).toEqual({ label: "#12 closed", color: theme.textMuted });
});

it("follows desktop collapsed-folder urgency while keeping waiting, seen and wake-only rows quiet", () => {
  const now = "2026-11-24T12:00:00.000Z";
  const environmentId = EnvironmentId.make("fixture");
  const working = { ...v2ThreadShell, latestRunId: RunId.make("run"), status: "running" as const };
  const waiting = { ...working, blockedOnThreadWait: true };
  const done = {
    ...working,
    status: "completed" as const,
    latestRunCompletedAt: DateTime.makeUnsafe("2026-11-24T11:00:00.000Z"),
    lastVisitedAt: DateTime.makeUnsafe("2026-11-24T10:00:00.000Z"),
  };
  const input = {
    ...v2ThreadShell,
    pendingRuntimeRequest: {
      id: RuntimeRequestId.make("input"),
      kind: "user_input" as const,
      createdAt: v2ThreadShell.createdAt,
    },
  };
  const failed = { ...done, status: "failed" as const, lastError: "Fixture error" };
  expect(threadFolderIndicator([waiting], environmentId, now)).toBeNull();
  expect(threadFolderIndicator([working], environmentId, now)?.label).toBe("Working");
  expect(threadFolderIndicator([working, done], environmentId, now)?.label).toBe("Done");
  expect(threadFolderIndicator([working, done, failed], environmentId, now)?.label).toBe("Failed");
  expect(threadFolderIndicator([failed, input], environmentId, now)?.label).toBe("Needs you");
  expect(threadFolderIndicator([working, done, input], environmentId, now)?.label).toBe(
    "Needs you",
  );
  expect(
    threadFolderIndicator(
      [{ ...done, lastVisitedAt: DateTime.makeUnsafe(now) }],
      environmentId,
      now,
    ),
  ).toBeNull();
  expect(
    threadFolderIndicator(
      [{ ...failed, lastVisitedAt: DateTime.makeUnsafe(now) }],
      environmentId,
      now,
    ),
  ).toBeNull();
  expect(
    threadFolderIndicator(
      [
        {
          ...v2ThreadShell,
          snoozedUntil: DateTime.makeUnsafe("2026-11-24T11:00:00.000Z"),
          lastVisitedAt: DateTime.makeUnsafe("2026-11-24T10:00:00.000Z"),
        },
      ],
      environmentId,
      now,
    ),
  ).toBeNull();
});
