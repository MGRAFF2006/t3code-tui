import { describe, expect, it } from "vite-plus/test";
import { createNavigationHistory } from "./navigation-history.ts";

describe("native navigation history", () => {
  it("revisits threads and global views across environments without losing the forward route", () => {
    const history = createNavigationHistory();
    const first = { environmentId: "a", threadId: "one", area: "chat" } as const;
    const settings = { ...first, area: "settings" } as const;
    const other = { environmentId: "b", threadId: "one", area: "chat" } as const;
    expect(history.target("back")).toBeNull();
    history.record(first);
    history.record(first);
    history.record(settings);
    history.record(other);
    const back = history.target("back")!;
    expect(back.entry).toEqual(settings);
    history.visit(back);
    history.record(settings);
    expect(history.target("forward")?.entry).toEqual(other);
    history.visit(history.target("forward")!);
    expect(history.target("forward")).toBeNull();
    history.visit(history.target("back")!);
    history.visit(history.target("back")!);
    expect(history.target("back")).toBeNull();
    history.record({ ...first, threadId: "two" });
    expect(history.target("forward")).toBeNull();
    expect(history.target("back")?.entry).toEqual(first);
    expect(history.visit(back)).toBe(false);
  });
});
