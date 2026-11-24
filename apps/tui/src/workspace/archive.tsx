import type { ScrollBoxRenderable } from "@opentui/core";
import { createMemo, createSignal, For, Show } from "solid-js";
import { theme } from "../theme/index.ts";
import { useActiveKeyboard } from "../ui/keyboard.ts";
import { scrollbarOptions } from "../ui/scroll.ts";
import { zipEntryPreview, zipRows, type ZipPreview } from "./archive.logic.ts";

export function ArchivePreview(props: {
  archive: ZipPreview;
  focused: boolean;
  onFocus: () => void;
  onClose: () => void;
  onActions: () => void;
}) {
  const [directory, setDirectory] = createSignal("");
  const [query, setQuery] = createSignal("");
  const [searching, setSearching] = createSignal(false);
  const [selected, setSelected] = createSignal(0);
  const [entryPath, setEntryPath] = createSignal<string | null>(null);
  const [hex, setHex] = createSignal(false);
  const rows = createMemo(() => zipRows(props.archive, directory(), query()));
  const entry = createMemo(() => props.archive.get(entryPath() ?? ""));
  const contents = createMemo(() => {
    const file = entry();
    return file ? zipEntryPreview(file.bytes, hex()) : null;
  });
  let scroll: ScrollBoxRenderable | undefined;
  function reset() {
    setSelected(0);
    scroll?.scrollTo(0);
  }
  function back() {
    if (searching()) setSearching(false);
    else if (entryPath() !== null) {
      setEntryPath(null);
      scroll?.scrollChildIntoView(`archive-row-${selected()}`);
    } else if (query()) {
      setQuery("");
      reset();
    } else if (directory()) {
      setDirectory((path) => path.slice(0, path.slice(0, -1).lastIndexOf("/") + 1));
      reset();
    } else props.onClose();
  }
  function activate(index: number) {
    const row = rows()[index];
    if (!row) return;
    setSelected(index);
    if (row.directory) {
      setDirectory(row.path);
      setQuery("");
      reset();
    } else {
      setEntryPath(row.path);
      setHex(false);
      scroll?.scrollTo(0);
    }
  }
  useActiveKeyboard(
    () => props.focused && !searching(),
    (event) => {
      if (event.ctrl || event.meta) return;
      if (event.name === "o") props.onActions();
      else if (event.name === "escape" || event.name === "left" || event.name === "backspace")
        back();
      else if (entryPath() !== null) {
        if (event.name === "h") setHex((value) => !value);
        else if (event.name === "up") scroll?.scrollBy(-1);
        else if (event.name === "down") scroll?.scrollBy(1);
        else if (event.name === "pageup") scroll?.scrollBy(-1, "viewport");
        else if (event.name === "pagedown") scroll?.scrollBy(1, "viewport");
        else if (event.name === "home") scroll?.scrollTo(0);
        else if (event.name === "end") scroll?.scrollTo(Infinity);
        else return;
      } else if (event.name === "/") setSearching(true);
      else if (event.name === "return" || event.name === "right") activate(selected());
      else if (event.name === "up" || event.name === "down") {
        const index = Math.max(
          0,
          Math.min(rows().length - 1, selected() + (event.name === "up" ? -1 : 1)),
        );
        setSelected(index);
        scroll?.scrollChildIntoView(`archive-row-${index}`);
      } else return;
      event.preventDefault();
      event.stopPropagation();
    },
  );
  return (
    <box flexGrow={1} minHeight={0} onMouseDown={props.onFocus}>
      <box flexDirection="row" height={1} flexShrink={0} gap={2}>
        <text selectable={false} fg={theme.primary} onMouseDown={back}>
          Back
        </text>
        <text fg={theme.textMuted} truncate flexGrow={1}>
          {entryPath() ?? `/${directory()}`}
        </text>
        <Show when={entryPath() !== null}>
          <text selectable={false} fg={theme.primary} onMouseDown={() => setHex((value) => !value)}>
            {hex() ? "Text" : "Hex"}
          </text>
        </Show>
      </box>
      <Show when={searching()}>
        <input
          placeholder="Find archive entry…"
          value={query()}
          focused={props.focused}
          onInput={(value) => {
            setQuery(value);
            reset();
          }}
          onSubmit={() => setSearching(false)}
          onKeyDown={(event) => {
            if (event.name !== "escape") return;
            event.preventDefault();
            event.stopPropagation();
            setSearching(false);
          }}
        />
      </Show>
      <scrollbox
        scrollbarOptions={scrollbarOptions()}
        ref={(value) => {
          scroll = value;
        }}
        flexGrow={1}
        minHeight={0}
        scrollX
        scrollY
      >
        <Show
          when={entryPath() !== null}
          fallback={
            <>
              <For each={rows()}>
                {(row, index) => (
                  <text
                    id={`archive-row-${index()}`}
                    height={1}
                    selectable={false}
                    truncate
                    fg={row.directory ? theme.primary : theme.text}
                    bg={selected() === index() ? theme.backgroundElement : theme.background}
                    onMouseDown={() => activate(index())}
                  >{`${row.directory ? "+" : " "} ${row.path.slice(directory().length)}${row.directory ? "" : `  ${row.size} B`}`}</text>
                )}
              </For>
              <Show when={rows().length === 0}>
                <text fg={theme.textMuted}>
                  {query() ? "No matching entries." : "This folder is empty."}
                </text>
              </Show>
            </>
          }
        >
          <Show when={entry()}>
            {(file) => (
              <>
                <text
                  fg={theme.textMuted}
                >{`${file().bytes.length} bytes · ${Number.isNaN(file().date.getTime()) ? "Unknown date" : file().date.toISOString()}`}</text>
                <text fg={theme.text} wrapMode="word">
                  {contents() ?? "Binary or non-UTF-8 entry. Choose Hex to inspect its bytes."}
                </text>
              </>
            )}
          </Show>
        </Show>
      </scrollbox>
      <text fg={theme.textMuted} flexShrink={0} wrapMode="word">
        {entryPath() !== null
          ? "↑↓ scroll · h text/hex · esc back"
          : `${rows().length} entries · ↑↓ select · enter open · / find · esc back`}
      </text>
    </box>
  );
}
