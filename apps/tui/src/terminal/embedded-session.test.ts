import { describe, expect, it, vi } from "vite-plus/test";
import { WS_METHODS } from "@t3tools/contracts";
import type { TuiClient } from "../runtime/client.ts";
import { attachEmbeddedTerminal } from "./embedded-session.ts";

describe("embedded terminal attachment", () => {
  it("retains destination ownership, forwards binary input/query replies, and stops queued writes on detach", async () => {
    let emit!: (event: unknown) => void;
    let release!: () => void;
    let observed!: () => void;
    const writeStarted = new Promise<void>((resolve) => {
      observed = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const invoke = vi.fn(async (method: string, _input: unknown) => {
      if (method === WS_METHODS.terminalWrite) {
        observed();
        await blocked;
      }
    });
    const stop = vi.fn();
    const stream = vi.fn((_method: string, _input: unknown, onEvent: (event: unknown) => void) => {
      emit = onEvent;
      return stop;
    });
    const captureTransport = vi.fn(() => ({ invoke, stream }));
    const onEvent = vi.fn();
    const onError = vi.fn();
    const terminal = attachEmbeddedTerminal({
      client: { captureTransport } as unknown as Pick<TuiClient, "captureTransport">,
      threadId: "owned-thread",
      terminalId: "shell",
      cwd: "/owned/repo",
      cols: 80,
      rows: 24,
      onEvent,
      onError,
    });
    terminal.write(new Uint8Array([0xc3, 0xa4]), true);
    terminal.resize(40, 10);
    expect(invoke).not.toHaveBeenCalled();
    emit({
      type: "snapshot",
      snapshot: {
        threadId: "owned-thread",
        terminalId: "shell",
        cwd: "/owned/repo",
        worktreePath: null,
        pid: 1,
        status: "running",
        history: "",
        cols: 80,
        rows: 24,
        exitCode: null,
        exitSignal: null,
        label: "shell",
        updatedAt: "2026-11-24T12:00:00Z",
      },
    });
    expect(onError).not.toHaveBeenCalled();
    await writeStarted;
    terminal.write(new Uint8Array([66]));
    terminal.resize(40, 10);
    terminal.dispose();
    emit({ type: "output", data: "late" });
    release();
    expect(captureTransport).toHaveBeenCalledTimes(1);
    expect(stream).toHaveBeenCalledWith(
      WS_METHODS.terminalAttach,
      expect.objectContaining({
        threadId: "owned-thread",
        resume: true,
        restartIfNotRunning: false,
      }),
      expect.any(Function),
      expect.any(Function),
    );
    expect(invoke.mock.calls.filter(([method]) => method === WS_METHODS.terminalWrite)).toEqual([
      [
        WS_METHODS.terminalWrite,
        {
          threadId: "owned-thread",
          terminalId: "shell",
          data: "\xc3\xa4",
          binary: true,
          reply: true,
        },
      ],
    ]);
    expect(invoke).toHaveBeenCalledWith(WS_METHODS.terminalResize, {
      threadId: "owned-thread",
      terminalId: "shell",
      cols: 40,
      rows: 10,
    });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledTimes(1);
  });
});
