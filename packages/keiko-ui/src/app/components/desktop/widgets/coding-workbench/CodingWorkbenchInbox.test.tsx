import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";
import type { CodingWorkbenchRuntimeInboxItem } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-api";

import type { CodingWorkbenchInboxStatus } from "@/lib/useCodingWorkbenchInbox";
import { translateCodingWorkbench } from "./coding-workbench-i18n";
import { DE_CODING_WORKBENCH_MESSAGES } from "./coding-workbench-i18n.de";
import { EN_CODING_WORKBENCH_MESSAGES } from "./coding-workbench-i18n.en";
import { CodingWorkbenchInbox } from "./CodingWorkbenchInbox";

const STEERED: CodingWorkbenchRuntimeInboxItem = {
  itemId: "msg_16b08469d001DaT0xxHG2PAKe6",
  delivery: "steer",
  preview: "Use the new logger",
};
const QUEUED: CodingWorkbenchRuntimeInboxItem = {
  itemId: "msg_16b08469d002DaT0xxHG2PAKe6",
  delivery: "queue",
  preview: "Then update the docs",
};

interface Handlers {
  readonly onCancel: ReturnType<typeof vi.fn>;
  readonly onSendNow: ReturnType<typeof vi.fn>;
  readonly onRetry: ReturnType<typeof vi.fn>;
  readonly view: ReturnType<typeof render>;
}

function renderInbox(
  items: readonly CodingWorkbenchRuntimeInboxItem[],
  options: { readonly status?: CodingWorkbenchInboxStatus; readonly busy?: boolean } = {},
): Handlers {
  const onCancel = vi.fn();
  const onSendNow = vi.fn();
  const onRetry = vi.fn();
  const view = render(
    <CodingWorkbenchInbox
      status={options.status ?? "ready"}
      items={items}
      busy={options.busy ?? false}
      onCancel={onCancel}
      onSendNow={onSendNow}
      onRetry={onRetry}
    />,
  );
  return { onCancel, onSendNow, onRetry, view };
}

describe("CodingWorkbenchInbox", () => {
  it("lists the waiting messages in the given order, each with its delivery and the operator's words", () => {
    renderInbox([STEERED, QUEUED]);

    expect(screen.getByRole("region", { name: "Messages waiting for this task" })).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent(
      "2 messages are waiting for the running task.",
    );
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText("Send now", { selector: "span" })).toBeVisible();
    expect(within(rows[0]!).getByText("Use the new logger")).toBeVisible();
    expect(within(rows[1]!).getByText("Queued")).toBeVisible();
    expect(within(rows[1]!).getByText("Then update the docs")).toBeVisible();
  });

  it("names a single waiting message in the singular", () => {
    renderInbox([QUEUED]);

    expect(screen.getByRole("status")).toHaveTextContent(
      "1 message is waiting for the running task.",
    );
  });

  it("offers Cancel on every row and Send now only on a queued one", () => {
    renderInbox([STEERED, QUEUED]);

    const [steered, queued] = screen.getAllByRole("listitem");
    expect(within(steered!).getByRole("button", { name: /^Cancel message:/u })).toBeVisible();
    expect(within(steered!).queryByRole("button", { name: /Send now/u })).toBeNull();
    expect(within(queued!).getByRole("button", { name: /^Cancel message:/u })).toBeVisible();
    expect(
      within(queued!).getByRole("button", { name: "Send now: Then update the docs" }),
    ).toBeVisible();
  });

  it("cancels the message of the row that was clicked, and no other", async () => {
    const { onCancel, onSendNow } = renderInbox([STEERED, QUEUED]);

    await userEvent.click(
      screen.getByRole("button", { name: "Cancel message: Then update the docs" }),
    );

    expect(onCancel).toHaveBeenCalledExactlyOnceWith(QUEUED.itemId);
    expect(onSendNow).not.toHaveBeenCalled();
  });

  it("changes a queued message to Send now, naming it", async () => {
    const { onCancel, onSendNow } = renderInbox([STEERED, QUEUED]);

    await userEvent.click(screen.getByRole("button", { name: "Send now: Then update the docs" }));

    expect(onSendNow).toHaveBeenCalledExactlyOnceWith(QUEUED.itemId);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("can be operated from the keyboard", async () => {
    const { onSendNow, onCancel } = renderInbox([QUEUED]);

    await userEvent.tab();
    expect(screen.getByRole("button", { name: /^Send now:/u })).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await userEvent.tab();
    expect(screen.getByRole("button", { name: /^Cancel message:/u })).toHaveFocus();
    await userEvent.keyboard(" ");

    expect(onSendNow).toHaveBeenCalledExactlyOnceWith(QUEUED.itemId);
    expect(onCancel).toHaveBeenCalledExactlyOnceWith(QUEUED.itemId);
  });

  it("shows a message without text by a label of its own, not an empty row", () => {
    renderInbox([{ ...QUEUED, preview: "" }]);

    expect(screen.getByText("Message without text")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Cancel message: Message without text" }),
    ).toBeVisible();
  });

  it("renders the operator's text as text, never as markup", () => {
    renderInbox([{ ...QUEUED, preview: "<img src=x onerror=alert(1)> {count} **bold**" }]);

    expect(screen.getByText("<img src=x onerror=alert(1)> {count} **bold**")).toBeVisible();
    expect(document.querySelector("img")).toBeNull();
  });

  it("waits while a runtime mutation is in flight", async () => {
    const { onCancel, onSendNow } = renderInbox([STEERED, QUEUED], { busy: true });

    expect(screen.getByRole("status")).toHaveTextContent("Applying…");
    for (const button of screen.getAllByRole("button")) {
      expect(button).toBeDisabled();
      await userEvent.click(button);
    }
    expect(onCancel).not.toHaveBeenCalled();
    expect(onSendNow).not.toHaveBeenCalled();
  });

  it.each(["idle", "loading", "ready"] as const)(
    "renders nothing when nothing waits (%s)",
    (status) => {
      const { view } = renderInbox([], { status });

      expect(view.container).toBeEmptyDOMElement();
    },
  );

  it.each(["idle", "loading"] as const)(
    "renders nothing while the list is not read (%s)",
    (status) => {
      const { view } = renderInbox([STEERED], { status });

      expect(view.container).toBeEmptyDOMElement();
    },
  );

  it("reports a failed read as a retryable error and shows no row from before", async () => {
    const { onRetry, view } = renderInbox([STEERED], { status: "error" });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "The waiting messages could not be read. They may still reach the running task.",
    );
    expect(screen.queryByRole("listitem")).toBeNull();
    expect(view.container).not.toHaveTextContent("Use the new logger");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(onRetry).toHaveBeenCalledOnce();
  });

  it.each([
    ["steered and queued messages", [STEERED, QUEUED]],
    ["a message without text", [{ ...QUEUED, preview: "" }]],
    ["a single message", [STEERED]],
  ])("has no accessibility violations for %s", async (_name, items) => {
    const { view } = renderInbox(items);

    expect(await axe(view.container)).toHaveNoViolations();
  });

  it("has no accessibility violations while busy or after a failed read", async () => {
    const busy = renderInbox([STEERED, QUEUED], { busy: true });
    expect(await axe(busy.view.container)).toHaveNoViolations();
    busy.view.unmount();

    const failed = renderInbox([], { status: "error" });
    expect(await axe(failed.view.container)).toHaveNoViolations();
  });
});

describe("pending message strings", () => {
  const KEYS = Object.keys(EN_CODING_WORKBENCH_MESSAGES).filter((key) =>
    key.startsWith("codingWorkbench.inbox."),
  ) as (keyof typeof EN_CODING_WORKBENCH_MESSAGES)[];

  it("are defined in German beside English, with the same placeholders", () => {
    expect(KEYS.length).toBeGreaterThan(10);
    for (const key of KEYS) {
      const english = EN_CODING_WORKBENCH_MESSAGES[key];
      const german = DE_CODING_WORKBENCH_MESSAGES[key];
      expect(german, key).not.toBe(english);
      expect(german.match(/\{\w+\}/gu)?.toSorted(), key).toEqual(
        english.match(/\{\w+\}/gu)?.toSorted(),
      );
    }
  });

  it("render the count and the message into the German sentences, singular and plural", () => {
    expect(translateCodingWorkbench("de", "codingWorkbench.inbox.summary", { count: 3 })).toBe(
      "3 Nachrichten warten auf die laufende Aufgabe.",
    );
    expect(translateCodingWorkbench("de", "codingWorkbench.inbox.summary.one", { count: 1 })).toBe(
      "1 Nachricht wartet auf die laufende Aufgabe.",
    );
    expect(
      translateCodingWorkbench("de", "codingWorkbench.inbox.cancel.item", { text: "Mehr Tests" }),
    ).toBe("Nachricht abbrechen: Mehr Tests");
    expect(
      translateCodingWorkbench("de", "codingWorkbench.inbox.sendNow.item", { text: "Mehr Tests" }),
    ).toBe("Jetzt senden: Mehr Tests");
  });
});
