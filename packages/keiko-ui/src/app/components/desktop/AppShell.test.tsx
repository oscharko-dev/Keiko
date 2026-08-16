import { describe, expect, it } from "vitest";
import { prepareNewWindowCfg } from "./AppShell";

describe("prepareNewWindowCfg", (): void => {
  it("gives every confirmed Chat creation a fresh observable request identity", (): void => {
    const cfg = prepareNewWindowCfg(
      "chat",
      {
        title: "Release grounding review",
        chatId: "chat-existing",
        selectionHandoffId: "selection-existing",
      },
      "new-chat-request-2",
    );

    expect(cfg).toStrictEqual({
      title: "Release grounding review",
      chatId: undefined,
      selectionHandoffId: undefined,
      newChatRequestId: "new-chat-request-2",
    });
  });

  it("clears a singleton Chat's retained title when the default title is omitted", (): void => {
    const cfg = prepareNewWindowCfg("chat", {}, "new-chat-request-3");

    expect(cfg).toStrictEqual({
      title: undefined,
      chatId: undefined,
      selectionHandoffId: undefined,
      newChatRequestId: "new-chat-request-3",
    });
    expect(Object.hasOwn(cfg, "title")).toBe(true);
  });

  it("leaves non-Chat creation configuration byte-identical", (): void => {
    const cfg = { title: "Files", root: "/workspace" };
    expect(prepareNewWindowCfg("files", cfg, "unused-request")).toBe(cfg);
  });
});
