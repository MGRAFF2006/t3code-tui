import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "@t3tools/contracts";
import { expandAssistantCitationsForProvider } from "@t3tools/shared/assistantCitations";

export function getComposerPromptLengthFeedback(text: string) {
  const prompt = text.trim();
  const length = Math.max(prompt.length, expandAssistantCitationsForProvider(prompt).length);
  const excess = Math.max(0, length - PROVIDER_SEND_TURN_MAX_INPUT_CHARS);
  return {
    length,
    limit: PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
    excess,
    message: excess
      ? `Prompt is ${excess.toLocaleString()} character${excess === 1 ? "" : "s"} over the ${PROVIDER_SEND_TURN_MAX_INPUT_CHARS.toLocaleString()}-character limit. Shorten or split it before sending.`
      : null,
  };
}
