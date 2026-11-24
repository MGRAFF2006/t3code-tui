import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, type ServerTraceDiagnosticsResult } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import type { TuiClient, TuiSnapshot } from "../runtime/client.ts";
import type { Choice, FeatureProps, FieldFormOptions, UiController } from "../ui/controller.ts";
import { serverLogActions } from "./logs.ts";

describe("native server span-log browsing", () => {
  it("filters retained events, expands full trace details and rejects results after the selected environment changes", async () => {
    let state = { environmentId: EnvironmentId.make("host") } as TuiSnapshot;
    const result: ServerTraceDiagnosticsResult = {
      traceFilePath: "trace.jsonl",
      readAt: DateTime.makeUnsafe("2026-06-20T12:00:00Z"),
      scannedFilePaths: ["trace.jsonl"],
      parseErrorCount: 0,
      recordCount: 2,
      firstSpanAt: Option.none(),
      lastSpanAt: Option.none(),
      failureCount: 0,
      interruptionCount: 0,
      slowSpanThresholdMs: 0,
      slowSpanCount: 0,
      topSpansByCount: [],
      slowestSpans: [],
      commonFailures: [],
      latestFailures: [],
      logLevelCounts: { WARN: 1, ERROR: 1 },
      error: Option.none(),
      partialFailure: Option.none(),
      latestWarningAndErrorLogs: [
        {
          level: "WARN",
          spanName: "Server.connect",
          message: "Connection delayed",
          traceId: "trace-1",
          spanId: "span-1",
          seenAt: DateTime.makeUnsafe("2026-06-20T12:00:00Z"),
        },
        {
          level: "ERROR",
          spanName: "Server.read",
          message: "Read failed",
          traceId: "trace-2",
          spanId: "span-2",
          seenAt: DateTime.makeUnsafe("2026-06-20T12:00:01Z"),
        },
      ],
    };
    let menu: Choice[] = [];
    let form: FieldFormOptions | undefined;
    let text = "";
    let read: () => Promise<ServerTraceDiagnosticsResult> = async () => result;
    const props: FeatureProps = {
      client: { invoke: () => read() } as unknown as TuiClient,
      state: () => state,
      ui: {
        choose: (_title: string, entries: Choice[]) => {
          menu = entries;
        },
        form: (options: FieldFormOptions) => {
          form = options;
        },
        text: (_title: string, content: string) => {
          text = content;
        },
      } as unknown as UiController,
      focused: true,
      onFocus: () => {},
    };
    await serverLogActions(props);
    menu.find((entry) => entry.title === "Search logs…")!.run();
    await form!.onSubmit({ query: "trace-2", level: "ERROR" });
    expect(menu.some((entry) => entry.title.startsWith("WARN"))).toBe(false);
    menu.find((entry) => entry.title === "ERROR · Server.read")!.run();
    expect(text).toContain("Read failed");
    expect(text).toContain("Trace: trace-2");
    let finish: (value: ServerTraceDiagnosticsResult) => void = () => {};
    read = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const pending = serverLogActions(props);
    state = { ...state, environmentId: EnvironmentId.make("other") };
    finish(result);
    await expect(pending).rejects.toThrow("environment changed");
  });
});
