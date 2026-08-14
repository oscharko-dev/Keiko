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

  it("leaves non-Chat creation configuration byte-identical", (): void => {
    const cfg = { title: "Files", root: "/workspace" };
    expect(prepareNewWindowCfg("files", cfg, "unused-request")).toBe(cfg);
  });

  it("binds a new Chat request to the project selected by the initiating shell", (): void => {
    expect(
      prepareNewWindowCfg("chat", { title: "Project B" }, "request-project-b", "/repo-b"),
    ).toStrictEqual({
      title: "Project B",
      projectPath: "/repo-b",
      chatId: undefined,
      selectionHandoffId: undefined,
      newChatRequestId: "request-project-b",
    });
  });

  it("does not overwrite an explicitly scoped Chat request", (): void => {
    expect(
      prepareNewWindowCfg(
        "chat",
        { title: "Explicit", projectPath: "/explicit" },
        "request-explicit",
        "/selected",
      ),
    ).toMatchObject({ projectPath: "/explicit" });
  });
});
