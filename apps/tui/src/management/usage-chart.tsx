import { createMemo, createSignal, For, Show, type Accessor } from "solid-js";
import type { UsageProviderKind, UsageSummary, UsageSummaryInput } from "@t3tools/contracts";
import { formatTokens, formatCount } from "@t3tools/shared/usageFormat";
import { getProviderClient } from "@t3tools/client-runtime/provider-clients";
import type { Choice, UiController } from "../ui/controller.ts";
import { theme, themeMode } from "../theme/index.ts";
import { Action, Section } from "./common.tsx";
import {
  USAGE_CHART_PAGE_SIZE,
  usageChartData,
  usageChartLabel,
  usageChartValue,
  type UsageChartMetric,
} from "./usage-chart.logic.ts";

const usd = (value: number) =>
  value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 4 });
const providerColor = (provider: UsageProviderKind) =>
  getProviderClient(provider === "claude" ? "claudeAgent" : provider)?.icon?.fill[themeMode()] ??
  (provider === "claude" ? "#d97757" : theme.primary);

export function createUsageChart(props: {
  summary: Accessor<UsageSummary | null>;
  window: Accessor<UsageSummaryInput | null>;
  ui: UiController;
}) {
  const [metric, setMetric] = createSignal<UsageChartMetric>("tokens");
  const [hidden, setHidden] = createSignal<ReadonlySet<UsageProviderKind>>(
    new Set<UsageProviderKind>(),
  );
  const [page, setPage] = createSignal(0);
  const [width, setWidth] = createSignal(40);
  const data = createMemo(() => {
    const summary = props.summary();
    const window = props.window();
    return summary && window ? usageChartData(summary, window) : null;
  });
  const providers = createMemo(
    () => data()?.providers.filter((provider) => !hidden().has(provider)) ?? [],
  );
  const pageCount = () =>
    Math.max(1, Math.ceil((data()?.periods.length ?? 0) / USAGE_CHART_PAGE_SIZE));
  const currentPage = () => Math.max(0, Math.min(page(), pageCount() - 1));
  const shownPeriods = () =>
    data()?.periods.slice(
      currentPage() * USAGE_CHART_PAGE_SIZE,
      (currentPage() + 1) * USAGE_CHART_PAGE_SIZE,
    ) ?? [];
  const peak = createMemo(() => {
    let maximum = 0;
    for (const values of data()?.byPeriod.values() ?? [])
      for (const provider of providers())
        maximum = Math.max(maximum, Math.abs(usageChartValue(values.get(provider), metric()) ?? 0));
    return maximum;
  });
  const format = (value: number | null) =>
    value === null ? "Unknown" : metric() === "tokens" ? formatTokens(value) : usd(value);
  function reset() {
    setMetric("tokens");
    setHidden(new Set<UsageProviderKind>());
    setPage(0);
  }
  function providerMenu() {
    props.ui.choose("Chart providers", [
      {
        title: "Show all providers",
        run: () => {
          setHidden(new Set<UsageProviderKind>());
          providerMenu();
        },
      },
      ...(data()?.providers ?? []).map((provider) => ({
        title: `${hidden().has(provider) ? "Show" : "Hide"} ${provider}`,
        run: () => {
          const next = new Set(hidden());
          if (next.has(provider)) next.delete(provider);
          else next.add(provider);
          setHidden(next);
          providerMenu();
        },
      })),
      { title: "Back to usage", run: () => {} },
    ]);
  }
  function inspect(period: string) {
    const window = props.window();
    if (!window) return;
    const lines = providers().map((provider) => {
      const value = data()?.byPeriod.get(period)?.get(provider);
      return `${provider}: ${formatCount(value?.tokens ?? 0)} processed tokens · ${usageChartValue(value, "cost") === null ? "Unknown cost" : usd(usageChartValue(value, "cost") ?? 0)}\n${value?.records ?? 0} records · ${value?.unpriced ?? 0} without a price`;
    });
    props.ui.text(
      "Usage chart period",
      [
        usageChartLabel(period, window),
        `Time zone: ${window.timeZone}`,
        ...(data()?.hourly ? [`Bucket start: ${period}`] : []),
        "Cost values include known prices only; Unknown means every record lacks a price.",
        ...lines,
      ].join("\n\n"),
    );
  }
  function inspectMenu() {
    const window = props.window();
    if (!window) return;
    props.ui.choose(
      "Inspect chart period",
      (data()?.periods ?? []).map((period) => ({
        title: usageChartLabel(period, window),
        run: () => inspect(period),
      })),
    );
  }
  const choices = (): Choice[] => [
    {
      title: "Usage chart metric",
      description: metric() === "tokens" ? "Processed tokens" : "Known cost (USD)",
      run: () =>
        props.ui.choose("Usage chart metric", [
          { title: "Processed tokens", run: () => setMetric("tokens") },
          { title: "Known cost (USD)", run: () => setMetric("cost") },
        ]),
    },
    {
      title: "Usage chart providers",
      description: `${providers().length} visible providers`,
      run: providerMenu,
    },
    { title: "Inspect usage chart period", run: inspectMenu },
    ...(currentPage() > 0
      ? [{ title: "Previous chart periods", run: () => setPage(currentPage() - 1) }]
      : []),
    ...(currentPage() < pageCount() - 1
      ? [{ title: "Next chart periods", run: () => setPage(currentPage() + 1) }]
      : []),
    {
      title: "Reset usage chart",
      description: "Show all providers, processed tokens and the first page.",
      run: reset,
    },
  ];
  function Details() {
    return (
      <Show when={data()}>
        {(chart) => (
          <Section title="Usage chart">
            <box
              onSizeChange={function () {
                setWidth(Math.floor(this.width));
              }}
            >
              <text fg={theme.textMuted} wrapMode="word">
                {metric() === "tokens"
                  ? "Processed tokens (reasoning is already in output)"
                  : "Known cost in USD; unpriced usage is excluded"}
              </text>
              <box flexDirection="row" gap={2} flexShrink={0} height={1}>
                <Action label="Tokens" onPress={() => setMetric("tokens")} />
                <Action label="Cost" onPress={() => setMetric("cost")} />
                <Action label="Providers" onPress={providerMenu} />
                <Action label="Reset" onPress={reset} />
              </box>
              <Show
                when={chart().error}
                fallback={
                  <>
                    <text
                      fg={theme.textMuted}
                      wrapMode="word"
                    >{`Full bar = ${format(peak())} · same scale across all ${chart().periods.length} periods`}</text>
                    <Show
                      when={chart().providers.length > 0}
                      fallback={<text fg={theme.textMuted}>No recorded usage in this period.</text>}
                    >
                      <Show
                        when={providers().length > 0}
                        fallback={
                          <text fg={theme.warning}>
                            All providers are hidden. Choose Providers or Reset.
                          </text>
                        }
                      >
                        <For each={shownPeriods()}>
                          {(period) => (
                            <box marginTop={1} flexShrink={0}>
                              <text
                                selectable={false}
                                fg={theme.text}
                                onMouseDown={() => inspect(period)}
                              >
                                {usageChartLabel(period, props.window()!)} · inspect
                              </text>
                              <For each={providers()}>
                                {(provider) => {
                                  const value = () => chart().byPeriod.get(period)?.get(provider);
                                  const amount = () => usageChartValue(value(), metric());
                                  const barWidth = () => Math.max(1, width() - 24);
                                  const bar = () =>
                                    amount() === null
                                      ? "?"
                                      : "█".repeat(
                                          peak() > 0 && Math.abs(amount() ?? 0) > 0
                                            ? Math.max(
                                                1,
                                                Math.round(
                                                  (Math.abs(amount() ?? 0) / peak()) * barWidth(),
                                                ),
                                              )
                                            : 0,
                                        );
                                  return (
                                    <box
                                      flexDirection="row"
                                      height={1}
                                      flexShrink={0}
                                      onMouseDown={() => inspect(period)}
                                    >
                                      <text
                                        selectable={false}
                                        width={10}
                                        flexShrink={0}
                                        truncate
                                        fg={providerColor(provider)}
                                      >
                                        {provider}
                                      </text>
                                      <text
                                        selectable={false}
                                        width={barWidth()}
                                        flexShrink={0}
                                        truncate
                                        fg={providerColor(provider)}
                                      >
                                        {bar()}
                                      </text>
                                      <text
                                        selectable={false}
                                        flexGrow={1}
                                        minWidth={0}
                                        truncate
                                        fg={amount() === null ? theme.warning : theme.text}
                                      >{` ${format(amount())}${metric() === "cost" && (value()?.unpriced ?? 0) > 0 && amount() !== null ? "*" : ""}`}</text>
                                    </box>
                                  );
                                }}
                              </For>
                            </box>
                          )}
                        </For>
                      </Show>
                    </Show>
                    <text
                      fg={theme.textMuted}
                      wrapMode="word"
                    >{`Periods ${chart().periods.length ? currentPage() * USAGE_CHART_PAGE_SIZE + 1 : 0}–${Math.min((currentPage() + 1) * USAGE_CHART_PAGE_SIZE, chart().periods.length)} of ${chart().periods.length}; * excludes unpriced records.`}</text>
                    <box flexDirection="row" gap={2} height={1} flexShrink={0}>
                      <Show when={currentPage() > 0}>
                        <Action label="Previous" onPress={() => setPage(currentPage() - 1)} />
                      </Show>
                      <Show when={currentPage() < pageCount() - 1}>
                        <Action label="Next" onPress={() => setPage(currentPage() + 1)} />
                      </Show>
                      <Action label="Inspect period" onPress={inspectMenu} />
                    </box>
                  </>
                }
              >
                <text fg={theme.warning} wrapMode="word">
                  {chart().error}
                </text>
              </Show>
              <text fg={theme.textMuted} wrapMode="word">
                {`Models: ${
                  props
                    .summary()
                    ?.modelFilter?.include?.map(
                      (selector) =>
                        `${selector.provider ? `${selector.provider}/` : ""}${selector.model}`,
                    )
                    .join(", ") || "all returned models"
                }`}
              </text>
              <Show
                when={props
                  .window()
                  ?.modelFilter?.include?.some(
                    (requested) =>
                      !props
                        .summary()
                        ?.modelFilter?.include?.some(
                          (applied) =>
                            applied.model === requested.model &&
                            applied.provider === requested.provider,
                        ),
                  )}
              >
                <text fg={theme.warning} wrapMode="word">
                  The server did not confirm the requested model filter. The chart shows the
                  returned data.
                </text>
              </Show>
              <Show
                when={props
                  .summary()
                  ?.sources.some(
                    (source) =>
                      source.refreshing ||
                      source.status === "partial" ||
                      source.status === "failed" ||
                      source.malformedRecords > 0,
                  )}
              >
                <text fg={theme.warning} wrapMode="word">
                  Source data is incomplete or refreshing. See source notices below; empty periods
                  may be incomplete.
                </text>
              </Show>
              <Show when={props.summary()?.buckets.some((bucket) => bucket.unpricedRecords > 0)}>
                <text fg={theme.warning} wrapMode="word">
                  Some records have no price. Zero known cost does not establish free usage; inspect
                  a period for record counts.
                </text>
              </Show>
            </box>
          </Section>
        )}
      </Show>
    );
  }
  return { choices, Details };
}
