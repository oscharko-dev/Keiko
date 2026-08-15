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

  it("replaces an empty project scope with the project selected by the initiating shell", (): void => {
    expect(
      prepareNewWindowCfg(
        "chat",
        { title: "Project B", projectPath: "" },
        "request-project-b",
        "/repo-b",
      ),
    ).toMatchObject({ projectPath: "/repo-b" });
  });

  it("removes an empty project scope when no selected project is available", (): void => {
    expect(
      prepareNewWindowCfg("chat", { title: "Unscoped", projectPath: "" }, "request-unscoped"),
    ).toMatchObject({ projectPath: undefined });
  });

  it("rejects whitespace-only configured and selected project scopes", (): void => {
    expect(
      prepareNewWindowCfg(
        "chat",
        { title: "Selected", projectPath: " \t" },
        "request-selected",
        "/repo-b",
      ),
    ).toMatchObject({ projectPath: "/repo-b" });
    expect(
      prepareNewWindowCfg(
        "chat",
        { title: "Unscoped", projectPath: " \t" },
        "request-unscoped",
        " \n",
      ),
    ).toMatchObject({ projectPath: undefined });
  });

  it("removes a malformed project scope when no valid selected project is available", (): void => {
    expect(
      prepareNewWindowCfg(
        "chat",
        { title: "Malformed", projectPath: ["hostile"] },
        "request-malformed",
        "",
      ),
    ).toMatchObject({ projectPath: undefined });
  });

  it("replaces a malformed project scope with the valid selected project", (): void => {
    expect(
      prepareNewWindowCfg(
        "chat",
        { title: "Malformed", projectPath: 42 },
        "request-selected",
        "/selected",
      ),
    ).toMatchObject({ projectPath: "/selected" });
  });
});
