import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { FigmaSnapshotScreenJsonResponse } from "@/lib/figma-snapshot-api";
import { FigmaJsonSourceWindow } from "./FigmaJsonSourceWindow";
import type { FigmaJsonSourceWindowProps } from "./FigmaJsonSourceWindow";

type LoadScreenJsonFn = Required<FigmaJsonSourceWindowProps>["loadScreenJsonImpl"];

const MOCK_SCREEN_JSON: FigmaSnapshotScreenJsonResponse = {
  runId: "fs-test",
  fileKey: "fig-file",
  nodeId: "1:1",
  version: undefined,
  fetchedAt: "2026-06-17T10:00:00.000Z",
  source: {
    kind: "figma-snapshot",
    snapshotRunId: "fs-test",
    screenIds: ["screen-1"],
  },
  snapshot: {
    screenCount: 1,
    skippedCount: 0,
    structuralOnlyCount: 0,
    integrityHash: "hash",
    redactionSummary: {
      totalStringsScanned: 8,
      stringsRedacted: 0,
      patternsMatched: {},
    },
  },
  screen: {
    kind: "rendered",
    screenId: "screen-1",
    name: "Login mask",
    irSummary: "1 control",
    integrityHash: "screen-hash",
    irJson: {
      id: "screen-1",
      name: "Login mask",
      root: { id: "submit", interactionHint: "button", text: "Submit" },
    },
    image: {
      mimeType: "image/png",
      relativePath: "screen.png",
      sha256: "png-hash",
      byteLength: 128,
    },
  },
  relatedLinks: [],
};

describe("FigmaJsonSourceWindow", () => {
  it("loads and renders scoped JSON with syntax highlighting", async () => {
    const loadSpy = vi.fn(async () => MOCK_SCREEN_JSON);
    render(
      <FigmaJsonSourceWindow
        snapshotRunId="fs-test"
        screenId="screen-1"
        screenName="Login mask"
        loadScreenJsonImpl={loadSpy as unknown as LoadScreenJsonFn}
      />,
    );

    await waitFor(() =>
      expect(loadSpy).toHaveBeenCalledWith("fs-test", "screen-1", expect.any(AbortSignal)),
    );
    expect(
      await screen.findByRole("region", { name: /figma json source login mask/iu }),
    ).toBeInTheDocument();
    const codeBlock = document.querySelector(".figma-json-code");
    expect(codeBlock).toHaveTextContent('"interactionHint": "button"');
    expect(document.querySelector(".json-token-key")).not.toBeNull();
  });

  it("copies the loaded JSON when clipboard access is available", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const loadSpy = vi.fn(async () => MOCK_SCREEN_JSON);
    render(
      <FigmaJsonSourceWindow
        snapshotRunId="fs-test"
        screenId="screen-1"
        screenName="Login mask"
        loadScreenJsonImpl={loadSpy as unknown as LoadScreenJsonFn}
      />,
    );

    await waitFor(() =>
      expect(document.querySelector(".figma-json-code")).toHaveTextContent(
        '"interactionHint": "button"',
      ),
    );
    await user.click(screen.getByRole("button", { name: "Copy JSON" }));

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(expect.stringContaining('"screenId": "screen-1"')),
    );
    expect(await screen.findByRole("status")).toHaveTextContent("Copied");
    if (clipboardDescriptor !== undefined) {
      Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
    }
  });
});
