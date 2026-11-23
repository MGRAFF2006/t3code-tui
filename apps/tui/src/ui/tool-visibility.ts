import type { ToolCallVisibility } from "@t3tools/contracts/settings";
import type { FeatureProps } from "./controller.ts";

export const toolVisibilityLabels: Record<ToolCallVisibility, string> = {
  showAll: "Show all",
  hideSuccessful: "Hide successful",
  hideAll: "Hide all",
  zen: "Zen",
};

export function chooseToolVisibility(props: Pick<FeatureProps, "client" | "ui">) {
  const descriptions: Record<ToolCallVisibility, string> = {
    showAll: "Show all tool calls, with expandable work groups.",
    hideSuccessful: "Keep running and failed calls; hide successful calls.",
    hideAll: "Hide tool calls while keeping messages and reasoning.",
    zen: "Focus on replies, requests and important notices. Find reveals matching messages.",
  };
  props.ui.choose(
    "Tool visibility",
    (Object.keys(toolVisibilityLabels) as ToolCallVisibility[]).map((value) => ({
      title: toolVisibilityLabels[value],
      description: descriptions[value],
      run: () =>
        void props.ui.run(
          () => props.client.updatePreferences({ toolCallVisibility: value }),
          "Tool visibility saved.",
        ),
    })),
  );
}
