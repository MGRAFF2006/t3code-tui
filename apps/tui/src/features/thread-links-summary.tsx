import { For, Show } from "solid-js";
import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";
import type { FeatureProps } from "../ui/controller.ts";
import { theme } from "../theme/index.ts";
import { createThreadLinks, threadLinkedPullRequests } from "./thread-links.ts";

export function ThreadLinksSummary(props: FeatureProps & { target: OrchestrationV2ThreadShell }) {
  return (
    <box flexDirection="column" flexShrink={0}>
      <For each={threadLinkedPullRequests(props.target)}>
        {(link) => (
          <text
            selectable={false}
            fg={theme.primary}
            wrapMode="word"
            onMouseDown={() => createThreadLinks(props, props.target).openPullRequest(link)}
          >{`PR ${link.repository} #${link.number}${link.snapshot ? `: ${link.snapshot.title} · ${link.snapshot.state}${link.snapshot.checksState ? ` · checks ${link.snapshot.checksState}` : ""}` : ""}${link.watch ? " · Watching" : ""}`}</text>
        )}
      </For>
      <For each={props.target.issues ?? []}>
        {(link) => (
          <text
            selectable={false}
            fg={theme.primary}
            wrapMode="word"
            onMouseDown={() => createThreadLinks(props, props.target).openIssue(link)}
          >{`${link.displayKey}: ${link.title}`}</text>
        )}
      </For>
      <Show when={!threadLinkedPullRequests(props.target).length && !props.target.issues?.length}>
        <text fg={theme.textMuted}>No linked pull requests or issues.</text>
      </Show>
      <text
        selectable={false}
        fg={theme.primary}
        onMouseDown={() => createThreadLinks(props, props.target).open()}
      >
        Manage thread links…
      </text>
    </box>
  );
}
