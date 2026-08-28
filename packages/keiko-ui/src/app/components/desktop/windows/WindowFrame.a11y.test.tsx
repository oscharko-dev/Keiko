import { createRef } from "react";
import { render } from "@testing-library/react";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceApi } from "../hooks/useWorkspace.types";
import { WindowFrame } from "./WindowFrame";
import type { AppWindow } from "./types";
import { workspaceApiFixture } from "../../../../test-utils/workspace-api-fixture";

// GEN-UI-TEST-GAP-002 — a default-state WindowFrame must expose no axe violations.
// This locks in the named-region labelling (aria-label + aria-roledescription), the
// scoped window-control labels, the connection-port labels, and the aria-hidden
// pointer-only resize handles (GEN-UI-INTERACTION-007).

function appWindow(patch: Partial<AppWindow> = {}): AppWindow {
  return {
    id: "agents-1",
    type: "agents",
    x: 40,
    y: 40,
    w: 480,
    h: 360,
    z: 1,
    cfg: {},
    max: false,
    zoom: 1,
    ...patch,
  };
}

const api = workspaceApiFixture;

describe("WindowFrame accessibility (GEN-UI-TEST-GAP-002)", () => {
  it("has no axe violations in the default window state", async () => {
    const { container } = render(
      <WindowFrame
        win={appWindow()}
        top
        connState={null}
        linkRevision={0}
        api={api()}
        wsRef={createRef<HTMLElement>()}
      />,
    );

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("has no axe violations in the selected window state", async () => {
    const { container } = render(
      <WindowFrame
        win={appWindow()}
        top
        selected
        selectedWindowCount={1}
        connState={null}
        linkRevision={0}
        api={api()}
        wsRef={createRef<HTMLElement>()}
      />,
    );

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
