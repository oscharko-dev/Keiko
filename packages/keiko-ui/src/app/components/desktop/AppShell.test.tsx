import { describe, expect, it, vi } from "vitest";
import {
  applyBackgroundModalLock,
  focusedModalOpener,
  persistedChatProjectPath,
  prepareNewWindowCfg,
} from "./AppShell";
import type { AppWindow } from "./windows/types";

function chatWindow(projectPath: string): AppWindow {
  return {
    id: "chat-window",
    type: "chat",
    x: 0,
    y: 0,
    w: 400,
    h: 400,
    z: 1,
    cfg: { projectPath },
    max: false,
    zoom: 1,
  };
}

describe("applyBackgroundModalLock", (): void => {
  it("moves focus out of the background before hiding it from assistive technology", (): void => {
    const background = document.createElement("div");
    const trigger = document.createElement("button");
    background.appendChild(trigger);
    document.body.appendChild(background);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    // The Chrome violation this pins fires AT THE MOMENT aria-hidden lands on an ancestor of
    // the focused element, so the assertion must observe focus at each attribute WRITE — a
    // final-state check would also pass for the broken hide-then-blur order.
    const writes: { attribute: string; triggerStillFocused: boolean }[] = [];
    const spy = vi.spyOn(background, "setAttribute").mockImplementation(function (
      this: HTMLElement,
      name: string,
      value: string,
    ) {
      writes.push({ attribute: name, triggerStillFocused: document.activeElement === trigger });
      Element.prototype.setAttribute.call(this, name, value);
    });

    applyBackgroundModalLock(background, true);
    spy.mockRestore();

    expect(writes.map((write) => write.attribute).sort()).toEqual(["aria-hidden", "inert"]);
    expect(writes.every((write) => !write.triggerStillFocused)).toBe(true);
    expect(document.activeElement).not.toBe(trigger);
    expect(background.getAttribute("aria-hidden")).toBe("true");
    expect(background.hasAttribute("inert")).toBe(true);
    background.remove();
  });

  it("unlocks both attributes and never touches focus outside the background", (): void => {
    const background = document.createElement("div");
    const outside = document.createElement("button");
    document.body.appendChild(background);
    document.body.appendChild(outside);
    outside.focus();

    applyBackgroundModalLock(background, true);
    expect(document.activeElement).toBe(outside);

    applyBackgroundModalLock(background, false);
    expect(background.hasAttribute("aria-hidden")).toBe(false);
    expect(background.hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe(outside);
    background.remove();
    outside.remove();
  });
});

describe("focusedModalOpener", (): void => {
  it("rejects document.body so modal cleanup reaches its deterministic fallback", (): void => {
    document.body.focus();

    expect(focusedModalOpener()).toBeNull();
  });
});

describe("persistedChatProjectPath", (): void => {
  it("preserves valid path identity and rejects whitespace-only values", (): void => {
    expect(persistedChatProjectPath(chatWindow("/repo/private "))).toBe("/repo/private ");
    expect(persistedChatProjectPath(chatWindow("/repo/ private"))).toBe("/repo/ private");
    expect(persistedChatProjectPath(chatWindow(" \t\n "))).toBeUndefined();
  });
});

describe("prepareNewWindowCfg", (): void => {
  it("isolates mutable array configuration between chat window requests", (): void => {
    const sourceIds = ["source-a"];
    const cfg = prepareNewWindowCfg("chat", { title: "Isolated", sourceIds }, "request-isolated");

    sourceIds.push("source-b");

    expect(cfg["sourceIds"]).toEqual(["source-a"]);
    expect(cfg["sourceIds"]).not.toBe(sourceIds);
  });

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

  it("preserves configured and selected project path identity when storing them", (): void => {
    expect(
      prepareNewWindowCfg(
        "chat",
        { title: "Explicit", projectPath: "/explicit " },
        "request-explicit",
        "/selected",
      ),
    ).toMatchObject({ projectPath: "/explicit " });
    expect(
      prepareNewWindowCfg("chat", { title: "Selected" }, "request-selected", "/selected "),
    ).toMatchObject({ projectPath: "/selected " });
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
    const cfg = prepareNewWindowCfg(
      "chat",
      { title: "Unscoped", projectPath: "" },
      "request-unscoped",
    );
    expect(cfg).not.toHaveProperty("projectPath");
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
    const unscoped = prepareNewWindowCfg(
      "chat",
      { title: "Unscoped", projectPath: " \t" },
      "request-unscoped",
      " \n",
    );
    expect(unscoped).not.toHaveProperty("projectPath");
  });

  it("removes a malformed project scope when no valid selected project is available", (): void => {
    const cfg = prepareNewWindowCfg(
      "chat",
      { title: "Malformed", projectPath: ["hostile"] },
      "request-malformed",
      "",
    );
    expect(cfg).not.toHaveProperty("projectPath");
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
