import { chunkTerminalWrite, TerminalAttachStreamEvent, WS_METHODS } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type { TuiClient } from "../runtime/client.ts";

const decodeEvent = Schema.decodeUnknownSync(TerminalAttachStreamEvent);

export function attachEmbeddedTerminal(options: {
  client: Pick<TuiClient, "captureTransport">;
  threadId: string;
  terminalId: string;
  cwd: string;
  cols: number;
  rows: number;
  onEvent: (event: TerminalAttachStreamEvent) => void;
  onError: (error: Error) => void;
}) {
  const transport = options.client.captureTransport();
  const session = { threadId: options.threadId, terminalId: options.terminalId };
  let active = true;
  let ready = false;
  let failed = false;
  let generation = 0;
  let initialized = false;
  let pendingBytes = 0;
  const pending: { data: string; reply: boolean }[] = [];
  let grid = { cols: options.cols, rows: options.rows };
  let writes = Promise.resolve();
  const fail = (cause: unknown) => {
    if (!active) return;
    generation++;
    ready = false;
    failed = true;
    pending.length = 0;
    pendingBytes = 0;
    options.onError(cause instanceof Error ? cause : new Error(String(cause)));
  };
  const stop = transport.stream(
    WS_METHODS.terminalAttach,
    {
      ...session,
      cwd: options.cwd,
      cols: options.cols,
      rows: options.rows,
      resume: true,
      restartIfNotRunning: false,
      maxHistoryBytes: 256 * 1024,
    },
    (value) => {
      if (!active) return;
      try {
        const event = decodeEvent(value);
        if (event.type === "snapshot" || event.type === "restarted") {
          if (initialized) {
            generation++;
            pending.length = 0;
            pendingBytes = 0;
          }
          initialized = true;
          ready = event.snapshot.status === "running";
          if (ready) {
            failed = false;
            resize();
            for (const value of pending.splice(0)) send(value.data, value.reply);
            pendingBytes = 0;
          }
        } else if (event.type === "exited" || event.type === "closed" || event.type === "error") {
          generation++;
          ready = false;
          failed = true;
          pending.length = 0;
          pendingBytes = 0;
        }
        options.onEvent(event);
      } catch (error) {
        fail(error);
      }
    },
    fail,
  );
  function resize() {
    const owner = generation;
    void transport.invoke(WS_METHODS.terminalResize, { ...session, ...grid }).catch((cause) => {
      if (owner === generation) fail(cause);
    });
  }
  function send(data: string, reply: boolean) {
    const owner = generation;
    writes = writes
      .then(async () => {
        if (active && ready && owner === generation)
          await transport.invoke(WS_METHODS.terminalWrite, {
            ...session,
            data,
            binary: true,
            ...(reply ? { reply: true } : {}),
          });
      })
      .catch((cause) => {
        if (owner === generation) fail(cause);
      });
  }
  return {
    write(bytes: Uint8Array, reply = false) {
      if (!active || failed) return;
      for (const data of chunkTerminalWrite(Buffer.from(bytes).toString("latin1"))) {
        if (ready) send(data, reply);
        else {
          pendingBytes += data.length;
          if (pendingBytes > 65_536)
            return fail(
              new Error(
                "The shell has not connected; input buffer is full. Reconnect before typing again.",
              ),
            );
          pending.push({ data, reply });
        }
      }
    },
    resize(cols: number, rows: number) {
      grid = { cols, rows };
      if (active && ready) resize();
    },
    dispose() {
      if (!active) return;
      active = false;
      generation++;
      ready = false;
      pending.length = 0;
      stop();
    },
  };
}
