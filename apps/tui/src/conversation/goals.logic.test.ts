import { expect, it } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { v2Projection } from "../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures.ts";
import { conversationGoalState, goalObjectiveCommand, providerGoalSupport } from "./goals.logic.ts";

const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-24T00:00:00Z",
  models: [],
  skills: [],
  slashCommands: [],
};

it("gates native controls by provider support without sending unsupported commands as ordinary prompts", () => {
  expect(providerGoalSupport(provider, undefined)).toMatchObject({ canSet: true, canPause: true });
  expect(providerGoalSupport(provider, false).canSet).toBe(false);
  expect(providerGoalSupport({ ...provider, enabled: false }, true).canSet).toBe(false);
  expect(providerGoalSupport({ ...provider, installed: false }, true).canSet).toBe(false);
  expect(
    providerGoalSupport({ ...provider, driver: ProviderDriverKind.make("cursor") }, true).canSet,
  ).toBe(false);
  expect(providerGoalSupport(undefined, undefined).canSet).toBe(false);
  const claude = providerGoalSupport(
    { ...provider, driver: ProviderDriverKind.make("claudeAgent") },
    undefined,
  );
  expect(claude).toMatchObject({ canSet: true, canManage: true, canPause: false });
  expect(claude.limitedControls).toContain("cannot pause or resume");
});

it("honours OpenCode capability reports and version gates and limits Antigravity to objective submission", () => {
  const opencode = { ...provider, driver: ProviderDriverKind.make("opencode"), version: "2.2.4" };
  expect(providerGoalSupport(opencode, undefined).canSet).toBe(false);
  expect(providerGoalSupport({ ...opencode, version: "2.2.5" }, undefined)).toMatchObject({
    canSet: true,
    canPause: true,
  });
  expect(providerGoalSupport({ ...opencode, version: null }, undefined).canSet).toBe(false);
  expect(providerGoalSupport({ ...opencode, version: null }, true).canSet).toBe(true);
  expect(providerGoalSupport({ ...opencode, version: "2.2.9" }, false).canSet).toBe(false);
  const antigravity = { ...provider, driver: ProviderDriverKind.make("antigravity") };
  expect(providerGoalSupport(antigravity, undefined).canSet).toBe(false);
  expect(
    providerGoalSupport({ ...antigravity, slashCommands: [{ name: "/goal" }] }, undefined),
  ).toMatchObject({ canSet: true, canManage: false, canPause: false });
  expect(providerGoalSupport(antigravity, true)).toMatchObject({
    canSet: true,
    canManage: false,
    canPause: false,
  });
});

it("offers the reverse action for paused goals and retains explicit cleared state", () => {
  const state = (
    status: "active" | "paused" | "blocked" | "usage_limited" | "budget_limited" | "complete",
  ) => conversationGoalState(v2Projection, provider, { objective: "All tests pass", status });
  expect(state("active")).toMatchObject({ canPause: true, canResume: false, canClear: true });
  for (const status of ["paused", "blocked", "usage_limited", "budget_limited"] as const)
    expect(state(status)).toMatchObject({ canPause: false, canResume: true, canClear: true });
  expect(state("complete")).toMatchObject({ canPause: false, canResume: false, canClear: true });
  expect(conversationGoalState(v2Projection, provider, null)).toMatchObject({
    goal: null,
    canPause: false,
    canResume: false,
    canClear: false,
  });
  expect(
    conversationGoalState(
      v2Projection,
      { ...provider, driver: ProviderDriverKind.make("claudeAgent") },
      { objective: "Ship", status: "paused" },
    ),
  ).toMatchObject({ canPause: false, canResume: false, canClear: true });
});

it("keeps objectives distinct from reserved goal controls and preserves multiline Unicode text", () => {
  expect(goalObjectiveCommand("  Resolve α and β\nthen run the suite.  ")).toBe(
    "/goal Resolve α and β\nthen run the suite.",
  );
  for (const text of ["", " \n ", "edit", "clear", "pause", "resume", "CLEAR"])
    expect(() => goalObjectiveCommand(text)).toThrow();
});
