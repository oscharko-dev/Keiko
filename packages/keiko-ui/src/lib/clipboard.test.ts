import { afterEach, describe, expect, it, vi } from "vitest";

import { copyTextToClipboard } from "./clipboard";

const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
const execCommandDescriptor = Object.getOwnPropertyDescriptor(document, "execCommand");

function setClipboard(writeText: ((text: string) => Promise<void>) | undefined): void {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: writeText === undefined ? undefined : { writeText },
  });
}

function setExecCommand(
  impl: ((command: string) => boolean) | undefined,
): ReturnType<typeof vi.fn<(command: string) => boolean>> | undefined {
  if (impl === undefined) {
    Reflect.deleteProperty(document, "execCommand");
    return undefined;
  }
  const execCommand = vi.fn(impl);
  Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
  return execCommand;
}

afterEach(() => {
  if (clipboardDescriptor === undefined) {
    Reflect.deleteProperty(navigator, "clipboard");
  } else {
    Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
  }
  if (execCommandDescriptor === undefined) {
    Reflect.deleteProperty(document, "execCommand");
  } else {
    Object.defineProperty(document, "execCommand", execCommandDescriptor);
  }
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("copyTextToClipboard", () => {
  it("uses navigator.clipboard.writeText when it succeeds, without touching the DOM fallback", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    setClipboard(writeText);
    const execCommand = setExecCommand(() => true);

    await copyTextToClipboard("hello world");

    expect(writeText).toHaveBeenCalledWith("hello world");
    expect(execCommand).not.toHaveBeenCalled();
  });

  it("falls back to the hidden-textarea path when writeText throws", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockRejectedValue(new Error("nope"));
    setClipboard(writeText);
    const execCommand = setExecCommand(() => true);

    await copyTextToClipboard("fallback text");

    expect(execCommand).toHaveBeenCalledWith("copy");
    // The temporary textarea must not linger in the DOM after the copy resolves.
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("falls back to the hidden-textarea path when navigator.clipboard is unavailable", async () => {
    setClipboard(undefined);
    const execCommand = setExecCommand(() => true);

    await copyTextToClipboard("no clipboard api");

    expect(execCommand).toHaveBeenCalledWith("copy");
  });

  it("passes the exact text into the hidden textarea", async () => {
    setClipboard(undefined);
    let capturedValue = "";
    const execCommand = setExecCommand(() => {
      const textarea = document.querySelector("textarea");
      capturedValue = textarea?.value ?? "";
      return true;
    });

    await copyTextToClipboard("exact payload 123");

    expect(execCommand).toHaveBeenCalled();
    expect(capturedValue).toBe("exact payload 123");
  });

  it("throws clipboard-fallback-failed when execCommand returns false", async () => {
    setClipboard(undefined);
    setExecCommand(() => false);

    await expect(copyTextToClipboard("x")).rejects.toThrow("clipboard-fallback-failed");
    // Even on failure the temporary textarea must be cleaned up.
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("throws clipboard-fallback-failed when execCommand is unsupported", async () => {
    setClipboard(undefined);
    setExecCommand(undefined);

    await expect(copyTextToClipboard("x")).rejects.toThrow("clipboard-fallback-failed");
  });

  it("throws clipboard-unavailable when document.body is unavailable", async () => {
    setClipboard(undefined);
    const originalBody = document.body;
    Object.defineProperty(document, "body", { configurable: true, value: null });
    try {
      await expect(copyTextToClipboard("x")).rejects.toThrow("clipboard-unavailable");
    } finally {
      Object.defineProperty(document, "body", { configurable: true, value: originalBody });
    }
  });

  describe("restoreFocus (default true)", () => {
    it("restores the previously focused element after a successful fallback copy", async () => {
      setClipboard(undefined);
      setExecCommand(() => true);
      const button = document.createElement("button");
      document.body.appendChild(button);
      button.focus();
      expect(document.activeElement).toBe(button);

      await copyTextToClipboard("restore me");

      expect(document.activeElement).toBe(button);
    });

    it("restores the previously focused element even when the fallback throws", async () => {
      setClipboard(undefined);
      setExecCommand(() => false);
      const button = document.createElement("button");
      document.body.appendChild(button);
      button.focus();

      await expect(copyTextToClipboard("x")).rejects.toThrow();

      expect(document.activeElement).toBe(button);
    });

    it("does not touch prior focus when restoreFocus is false", async () => {
      setClipboard(undefined);
      setExecCommand(() => true);
      const button = document.createElement("button");
      document.body.appendChild(button);
      const focusSpy = vi.spyOn(button, "focus");
      button.focus();
      focusSpy.mockClear();

      await copyTextToClipboard("no restore", { restoreFocus: false });

      // The helper must not re-focus the previously active element on this path.
      expect(focusSpy).not.toHaveBeenCalled();
    });

    it("still focuses the hidden textarea itself when restoreFocus is false", async () => {
      setClipboard(undefined);
      let wasFocused = false;
      setExecCommand(() => {
        wasFocused = document.activeElement instanceof HTMLTextAreaElement;
        return true;
      });

      await copyTextToClipboard("focus me anyway", { restoreFocus: false });

      // execCommand("copy") needs the textarea itself focused (not merely selected) to
      // copy reliably across browsers, independent of whether prior focus is restored.
      expect(wasFocused).toBe(true);
    });
  });
});
