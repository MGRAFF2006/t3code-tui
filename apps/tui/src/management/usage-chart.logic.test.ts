import { expect, it } from "vite-plus/test";
import {
  USAGE_CONTRACT_VERSION,
  UsageDay,
  type UsageBucket,
  type UsageSummary,
} from "@t3tools/contracts";
import {
  usageChartData,
  usageChartLabel,
  usageChartValue,
  usageChartWindow,
} from "./usage-chart.logic.ts";

function bucket(overrides: Partial<UsageBucket> = {}): UsageBucket {
  return {
    day: UsageDay.make("2026-10-25"),
    provider: "codex",
    model: "fixture",
    totals: {
      uncachedInputTokens: 10,
      cachedInputTokens: 20,
      cacheCreationTokens: 30,
      outputTokens: 40,
      reasoningTokens: 15,
    },
    costUsd: 2,
    cacheSavingsUsd: 0,
    costSource: "modelPriced",
    records: 1,
    unpricedRecords: 0,
    sessions: 1,
    ...overrides,
  };
}
function summary(buckets: UsageBucket[]): UsageSummary {
  return {
    contractVersion: USAGE_CONTRACT_VERSION,
    readAt: "2026-10-25T12:00:00Z",
    timeZone: "Europe/Berlin",
    sinceDay: UsageDay.make("2026-10-24"),
    untilDay: UsageDay.make("2026-10-26"),
    buckets,
    sources: [],
    pricing: { status: "cached", source: "fixture", fetchedAt: null, knownModels: 1 },
    scanDurationMs: 0,
  };
}

it("aggregates provider/model cells without double-counting reasoning and distinguishes unknown, partial and zero cost", () => {
  const value = summary([
    bucket(),
    bucket({ model: "unknown", costUsd: 0, unpricedRecords: 1 }),
    bucket({ provider: "claude", costUsd: 0, unpricedRecords: 1 }),
  ]);
  const data = usageChartData(value, {
    sinceDay: value.sinceDay,
    untilDay: value.untilDay,
    timeZone: value.timeZone,
    resolution: "day",
  });
  expect(data.periods).toEqual(["2026-10-24", "2026-10-25", "2026-10-26"]);
  const codex = data.byPeriod.get("2026-10-25")?.get("codex");
  expect(codex).toEqual({ tokens: 200, cost: 2, records: 2, unpriced: 1 });
  expect(usageChartValue(codex, "tokens")).toBe(200);
  expect(usageChartValue(codex, "cost")).toBe(2);
  expect(usageChartValue(data.byPeriod.get("2026-10-25")?.get("claude"), "cost")).toBeNull();
  expect(usageChartValue(data.byPeriod.get("2026-10-24")?.get("codex"), "cost")).toBe(0);
  expect(usageChartValue({ tokens: 100, cost: 0, records: 1, unpriced: 0 }, "cost")).toBe(0);
});

it("preserves distinct repeated hourly buckets and rejects incompatible or unbounded chart windows", () => {
  const window = usageChartWindow({
    resolution: "hour",
    zone: "Europe/Berlin",
    sinceTime: "2026-10-25T02:00:00+02:00",
    untilTime: "2026-10-25T03:00:00+01:00",
  });
  const value = summary([
    bucket({ hourStart: "2026-10-25T00:00:00.000Z" }),
    bucket({ hourStart: "2026-10-25T01:00:00.000Z", costUsd: 5 }),
  ]);
  const data = usageChartData(value, window);
  expect(data.periods).toEqual(["2026-10-25T00:00:00.000Z", "2026-10-25T01:00:00.000Z"]);
  expect(usageChartLabel(data.periods[0]!, window)).not.toBe(
    usageChartLabel(data.periods[1]!, window),
  );
  expect(data.byPeriod.get(data.periods[1]!)?.get("codex")?.cost).toBe(5);
  expect(
    usageChartData({ ...value, contractVersion: USAGE_CONTRACT_VERSION + 1 }, window).error,
  ).toContain("incompatible");
  expect(
    usageChartData(
      { ...value, sinceDay: UsageDay.make("1900-01-01") },
      { ...window, resolution: "day" },
    ).error,
  ).toContain("4,096");
});

it("sends the server-required exact hourly bounds and validates calendar/filter inputs", () => {
  const window = usageChartWindow({
    resolution: "hour",
    zone: "Europe/Berlin",
    sinceTime: "2026-10-24T23:00:00Z",
    untilTime: "2026-10-25T23:00:00Z",
    model: "fixture",
    provider: "codex",
  });
  expect(window).toMatchObject({
    sinceDay: "2026-10-25",
    untilDay: "2026-10-26",
    sinceTime: "2026-10-24T23:00:00.000Z",
    untilTime: "2026-10-25T23:00:00.000Z",
    modelFilter: { include: [{ model: "fixture", provider: "codex" }] },
  });
  expect(() =>
    usageChartWindow({
      resolution: "hour",
      zone: "Europe/Berlin",
      sinceTime: "2026-10-24T23:00:00Z",
      untilTime: "2026-10-26T00:00:00Z",
    }),
  ).toThrow("at most 24 hours");
  expect(() =>
    usageChartWindow({
      resolution: "hour",
      zone: "Europe/Berlin",
      sinceTime: "2026-10-24T23:00:00",
      untilTime: "2026-10-25T00:00:00",
    }),
  ).toThrow("timezone offset");
  expect(() =>
    usageChartWindow({
      resolution: "day",
      zone: "Europe/Berlin",
      since: "2026-02-31",
      until: "2026-03-02",
    }),
  ).toThrow("valid calendar dates");
  expect(() =>
    usageChartWindow({
      resolution: "day",
      zone: "Europe/Berlin",
      since: "2026-01-01",
      until: "2026-01-02",
      provider: "codex",
    }),
  ).toThrow("requires a model ID");
});
