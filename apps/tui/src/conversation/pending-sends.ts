import type { PendingSend } from "../runtime/send-outbox.ts";
import type { FeatureProps } from "../ui/controller.ts";

export function pendingSendActions(
  props: FeatureProps,
  settle: (entry: PendingSend) => Promise<boolean>,
) {
  void props.ui.run(async () => {
    const environment = props.state()?.environmentId;
    const entries = await props.client.refreshPendingSends();
    if (props.state()?.environmentId !== environment) return;
    const invalid = props.client.invalidPendingSends();
    if (!entries.length && !invalid.length) return props.ui.notify("No unconfirmed messages.");
    const choose = (entry: PendingSend) => {
      const main = entry.steps[entry.steps.length - 1]!;
      const guard = () => {
        if (props.state()?.environmentId !== entry.environmentId)
          throw new Error("Switch to the message's original environment to resolve it.");
      };
      const accepted = async (value: PendingSend) => {
        const cleared = await settle(value);
        props.ui.notify(
          cleared
            ? "Message accepted. Its sent draft content was cleared; newer edits were kept."
            : "Message accepted. Review the retained draft before sending another message.",
        );
      };
      const completed = entry.nextStep === entry.steps.length;
      const neverDispatched = entry.nextStep === 0 && entry.attempted === false;
      const status = completed
        ? "Accepted message · draft cleanup pending"
        : neverDispatched
          ? "Prepared message · not dispatched"
          : "Unconfirmed message";
      props.ui.choose(status, [
        {
          title: "Inspect captured message",
          description: `${entry.createdAt} · ${main.modelSelection.instanceId}/${main.modelSelection.model} · ${main.dispatchMode ?? "auto"}`,
          run: () =>
            props.ui.text(
              status,
              `${main.message.text}\n\n${main.message.attachments.length} attachments · ${main.message.context?.records.length ?? 0} context records\nDestination: ${entry.environmentId} / ${entry.threadId}\n${completed ? "The server accepted this message. Retry completes local draft cleanup without dispatching again." : neverDispatched ? "This message was prepared but no dispatch was attempted." : "This message may already be accepted."} Reconcile checks saved server messages; retry uses the same command and message identities.`,
            ),
        },
        {
          title: "Reconcile with server",
          description: "Read only. Checks whether the original message was accepted.",
          run: () =>
            void props.ui.run(async () => {
              guard();
              const result = await props.client.reconcilePendingSend(entry.id);
              if (result) await accepted(result);
              else
                props.ui.notify(
                  "No accepted message found yet. The send remains unconfirmed; retry the original or discard its local record.",
                );
            }),
        },
        {
          title: "Retry original message",
          description:
            "Same destination, model, content and IDs. This can start a turn if it was never accepted.",
          run: () =>
            props.ui.confirm(
              "Retry unconfirmed message?",
              "The original command IDs prevent duplicate acceptance. A previously unaccepted message can start a provider turn.",
              async () => {
                guard();
                await accepted(await props.client.retryPendingSend(entry.id));
              },
              "Retry original",
            ),
        },
        {
          title: "Discard local pending record",
          description: "Keeps the draft. Does not cancel an accepted server message.",
          run: () =>
            props.ui.confirm(
              "Discard unconfirmed message record?",
              "This removes only the local recovery record and unlocks new sends. An accepted message can still run. Sending the retained draft again can create a duplicate.",
              async () => {
                guard();
                await props.client.discardPendingSend(entry.id);
                props.ui.notify(
                  "Local pending record discarded. Review the retained draft before sending.",
                );
              },
              "Discard local record",
            ),
        },
      ]);
    };
    props.ui.choose("Pending sends", [
      ...entries.map((entry) => ({
        title:
          entry.steps[entry.steps.length - 1]!.message.text.slice(0, 100) ||
          "Message with attachments",
        description: `${entry.environmentId === environment ? "Current environment" : "Other environment"} · ${entry.threadId} · ${entry.createdAt}`,
        run: () => choose(entry),
      })),
      ...invalid.map((record) => ({
        title: "Unreadable pending-send record",
        description: record.file,
        run: () =>
          props.ui.choose("Unreadable recovery record", [
            {
              title: "Inspect preserved file",
              description: record.file,
              run: () =>
                void props.ui.run(async () =>
                  props.ui.text(
                    "Unreadable pending send",
                    `${record.file}\n\n${record.error}\n\n${await props.client.inspectInvalidPendingSend(record.file)}`,
                  ),
                ),
            },
            {
              title: "Move aside",
              description:
                "Preserves the bytes in a .invalid file. Does not cancel any server message.",
              run: () =>
                props.ui.confirm(
                  "Move unreadable send record aside?",
                  `The original is preserved at ${record.file}.invalid. Its acceptance is unknown. Review retained drafts before sending again.`,
                  async () => {
                    await props.client.moveInvalidPendingSend(record.file);
                    props.ui.notify(`Recovery file preserved at ${record.file}.invalid.`);
                  },
                  "Move aside",
                ),
            },
          ]),
      })),
    ]);
  });
}
