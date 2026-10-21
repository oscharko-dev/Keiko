import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import {
  applyBackgroundModalLock,
  focusedModalOpener,
  persistedChatProjectPath,
  prepareNewWindowCfg,
  LeftRailLoading,
} from "./AppShell";
import type { AppWindow } from "./windows/types";
import { sanitizePersistedWindows } from "./hooks/workspace-persistence";
import { resetClientDiagnosticWriter, setClientDiagnosticWriter } from "@/lib/client-diagnostics";

describe("LeftRailLoading", () => {
  it("keeps the stable layout slot out of navigation and the keyboard order", async () => {
    const { container } = render(LeftRailLoading({}));
    expect(container.firstElementChild).toHaveClass("rail", "rail-left");
    expect(container.firstElementChild).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("preserves the failure for the shell's existing recovery boundary", () => {
    const failure = new Error("Navigation chunk unavailable");
    expect(() => LeftRailLoading({ error: failure })).toThrow(failure);
  });
});

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
  it.each([
    [{ kind: "automatic" } as const, { newChatModelSelection: "automatic" }],
    [
      { kind: "explicit", modelId: "model-original" } as const,
      { newChatModelSelection: "explicit", newChatModelId: "model-original" },
    ],
  ])("captures the original creation model choice (%j)", (choice, expected): void => {
    const cfg = prepareNewWindowCfg("chat", {}, "shared-creation", "/repo", choice);
    expect(cfg).toMatchObject(expected);
    const saved = sanitizePersistedWindows([{ ...chatWindow("/repo"), cfg }]);
    expect(saved[0]?.cfg).toMatchObject(expected);
  });

  it("refuses a secret-shaped explicit model snapshot before accepting a window", (): void => {
    const diagnostic = vi.fn();
    setClientDiagnosticWriter(diagnostic);
    try {
      expect(() =>
        prepareNewWindowCfg("chat", {}, "shared-creation", "/repo", {
          kind: "explicit",
          modelId: `ghp_${"A".repeat(36)}`,
        }),
      ).toThrow(TypeError);
      expect(diagnostic).toHaveBeenCalledWith(
        "Chat creation model selection cannot be persisted.",
        expect.objectContaining({ errorKind: "unavailable", errorEvidence: expect.any(Object) }),
      );
      expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("ghp_");
    } finally {
      resetClientDiagnosticWriter();
    }
  });

  it("clears a prior explicit snapshot before accepting a fresh automatic choice", (): void => {
    const cfg = prepareNewWindowCfg(
      "chat",
      { newChatModelSelection: "explicit", newChatModelId: "previous-model" },
      "fresh-creation",
      "/repo",
      { kind: "automatic" },
    );
    expect(cfg["newChatModelSelection"]).toBe("automatic");
    expect(cfg["newChatModelId"]).toBeUndefined();
  });

  it("redraws a generated intent that the unchanged persistence heuristic rejects", (): void => {
    const draw = vi
      .spyOn(crypto, "randomUUID")
      .mockReturnValueOnce("1404206d-9ab6-4bca-8853-813867352087")
      .mockReturnValueOnce("12345678-1234-4123-8123-123456789abc");
    try {
      const cfg = prepareNewWindowCfg("chat", { title: "Shared conversation" });
      const saved = sanitizePersistedWindows([{ ...chatWindow("/repo"), cfg }]);
      expect(saved[0]?.cfg["newChatRequestId"]).toBe("12345678-1234-4123-8123-123456789abc");
      expect(draw).toHaveBeenCalledTimes(2);
    } finally {
      draw.mockRestore();
    }
  });

  it("fails before creating a window when every generated intent is rejected", (): void => {
    const diagnostic = vi.fn();
    setClientDiagnosticWriter(diagnostic);
    const draw = vi
      .spyOn(crypto, "randomUUID")
      .mockReturnValue("12345678-1234-4123-8123-123456789abc");
    for (let rejected = 0; rejected < 32; rejected += 1) {
      draw.mockReturnValueOnce("1404206d-9ab6-4bca-8853-813867352087");
    }
    try {
      expect(() => prepareNewWindowCfg("chat", {})).toThrow(TypeError);
      // One additional id correlates the existing body-free failure diagnostic.
      expect(draw).toHaveBeenCalledTimes(33);
      expect(diagnostic).toHaveBeenCalledWith(
        "Chat creation identity allocation failed.",
        expect.objectContaining({
          correlationId: expect.any(String),
          kind: "other",
          errorKind: "internal",
          errorEvidence: expect.any(Object),
        }),
      );
      expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("1404206d");
    } finally {
      draw.mockRestore();
      resetClientDiagnosticWriter();
    }
  });

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
