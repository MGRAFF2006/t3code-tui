import { expect, it } from "vite-plus/test";
import { formatTerminalTitle } from "./terminal-title.ts";

it("keeps connection and work status scoped to the displayed environment", () => {
  const context = { environment: "Remote", project: "Server", thread: "Fix login" };
  expect(
    formatTerminalTitle({
      ...context,
      connection: "connected",
      status: "approval",
      runningTerminals: 2,
    }),
  ).toBe("[Approval needed · Terminal running] Fix login · Server · Remote · T3 Code");
  expect(
    formatTerminalTitle({
      ...context,
      connection: "reconnecting",
      status: "working",
      runningTerminals: 2,
    }),
  ).toBe("[reconnecting] Fix login · Server · Remote · T3 Code");
  expect(formatTerminalTitle({ connection: "connected", status: "ready", view: "Settings" })).toBe(
    "[Ready] Settings · T3 Code",
  );
});

it("does not allow remote labels to inject terminal controls or hide the status and app name", () => {
  const title = formatTerminalTitle({
    connection: "connected",
    status: "failed",
    thread: `Injected\x1b]52;c;secret\x07\u009c\u202e\u2066${"📌".repeat(300)}`,
    project: "Project\nname",
    environment: "Remote\r\tname",
  });
  expect(title.startsWith("[Failed] Injected]52;c;secret")).toBe(true);
  expect(title.endsWith(" · T3 Code")).toBe(true);
  expect(Array.from(title).length).toBeLessThanOrEqual(240);
  expect([...title].every((character) => character.codePointAt(0)! >= 32)).toBe(true);
  expect(title).not.toContain("\u009c");
  expect(title).not.toContain("\u202e");
  expect(title).not.toContain("\u2066");
  const connectionTitle = formatTerminalTitle({
    connection: `\x1b]0;${"Disconnected".repeat(100)}`,
    status: "working",
    thread: "Thread",
  });
  expect(Array.from(connectionTitle).length).toBeLessThanOrEqual(240);
  expect(connectionTitle).not.toContain("\x1b");
  expect(connectionTitle.endsWith(" · T3 Code")).toBe(true);
});
