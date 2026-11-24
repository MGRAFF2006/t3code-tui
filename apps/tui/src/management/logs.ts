import { WS_METHODS, type ServerTraceDiagnosticsResult } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { request } from "../rpc/request.ts";
import type { FeatureProps } from "../ui/controller.ts";

export async function serverLogActions(props: FeatureProps) {
  const environmentId = props.state()?.environmentId;
  const guard = () => {
    if (!environmentId || props.state()?.environmentId !== environmentId)
      throw new Error("The environment changed. Open server span logs again.");
  };
  let snapshot: ServerTraceDiagnosticsResult;
  let query = "";
  let level = "all";
  async function refresh() {
    guard();
    const next = await request(props.client, WS_METHODS.serverGetTraceDiagnostics, {});
    guard();
    snapshot = next;
    show();
  }
  function show() {
    guard();
    const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    const events = snapshot.latestWarningAndErrorLogs.filter((event) => {
      const haystack =
        `${event.level} ${event.spanName} ${event.message} ${event.traceId} ${event.spanId}`.toLowerCase();
      return (
        (level === "all" || event.level === level) && terms.every((term) => haystack.includes(term))
      );
    });
    props.ui.choose(
      `Server span logs · ${events.length}/${snapshot.latestWarningAndErrorLogs.length}`,
      [
        {
          title: "Refresh logs",
          description: `Read at ${DateTime.formatIso(snapshot.readAt)} · recent warnings and errors from retained trace files`,
          run: () => void props.ui.run(refresh),
        },
        {
          title: "Search logs…",
          description: query || "Message, span, trace or severity",
          run: () =>
            props.ui.form({
              title: "Search server span logs",
              fields: [
                { name: "query", label: "Search", value: query },
                {
                  name: "level",
                  label: "Severity",
                  type: "select",
                  value: level,
                  options: [
                    { label: "All", value: "all" },
                    ...[
                      ...new Set(snapshot.latestWarningAndErrorLogs.map((event) => event.level)),
                    ].map((value) => ({ label: value, value })),
                  ],
                },
              ],
              submitLabel: "Search",
              onSubmit: async (values) => {
                guard();
                query = values.query ?? "";
                level = values.level ?? "all";
                show();
              },
            }),
        },
        {
          title: "Coverage and read errors",
          description: `${snapshot.scannedFilePaths.length} trace files · ${snapshot.parseErrorCount} malformed records`,
          run: () =>
            props.ui.text(
              "Server span-log coverage",
              [
                "Recent warning and error events retained by the server, matching desktop Span Logs. This is not a full stdout/stderr log tail.",
                `Read at: ${DateTime.formatIso(snapshot.readAt)}`,
                `Files scanned: ${snapshot.scannedFilePaths.length}`,
                `Trace records: ${snapshot.recordCount}`,
                `Malformed records: ${snapshot.parseErrorCount}`,
                ...Object.entries(snapshot.logLevelCounts).map(
                  ([name, count]) => `${name}: ${count}`,
                ),
                ...(Option.getOrNull(snapshot.error)
                  ? [Option.getOrNull(snapshot.error)!.message]
                  : []),
                ...(Option.getOrNull(snapshot.partialFailure)
                  ? ["Some files could not be read; results are incomplete."]
                  : []),
              ].join("\n"),
            ),
        },
        ...(events.length
          ? events.map((event) => ({
              title: `${event.level} · ${event.spanName}`,
              description: event.message,
              run: () =>
                props.ui.text(
                  `${event.level} · ${event.spanName}`,
                  [
                    DateTime.formatIso(event.seenAt),
                    "",
                    event.message,
                    "",
                    `Trace: ${event.traceId}`,
                    `Span: ${event.spanId}`,
                  ].join("\n"),
                ),
            }))
          : [
              {
                title: "No matching warning or error events",
                description: query || "The server has no retained warning or error events.",
                run: () => {},
              },
            ]),
      ],
    );
  }
  await refresh();
}
