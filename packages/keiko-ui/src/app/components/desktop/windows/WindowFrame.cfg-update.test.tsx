import { createRef, type Dispatch, type ReactNode, type SetStateAction } from "react";
import type { WorkspaceApi } from "../hooks/useWorkspace.types";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { workspaceApiFixture } from "@/test-utils/workspace-api-fixture";
import { filesChatBindScope, makeMutations } from "../hooks/workspaceActions";
import { registerWindowRender } from "./WindowsRegistry";
import { subText } from "./connectionUtils";
import { WindowFrame } from "./WindowFrame";
import type { AppWindow } from "./types";

const SCALE = "/manuals/Scale";
const DISTINCT = "/manuals/Distinct";

function filesWindow(): AppWindow {
  return {
    id: "files-root-navigation",
    type: "files",
    x: 0,
    y: 0,
    w: 640,
    h: 480,
    z: 1,
    max: false,
    zoom: 1,
    cfg: { root: SCALE, resolvedRoot: SCALE, rootBinding: "coding-repository" },
  };
}

function mutationProbe(initial: AppWindow): {
  readonly api: WorkspaceApi;
  readonly current: () => AppWindow;
} {
  let windows: AppWindow[] | null = [initial];
  const setWins: Dispatch<SetStateAction<AppWindow[] | null>> = (update): void => {
    windows = typeof update === "function" ? update(windows) : update;
  };
  const mutations = makeMutations({ setWins, zc: { current: 1 }, worldVP: () => null });
  return {
    api: workspaceApiFixture({ update: mutations.update }),
    current: (): AppWindow => {
      const current = windows?.[0];
      if (current === undefined) throw new Error("The Files window must remain present.");
      return current;
    },
  };
}

function frame(win: AppWindow, api: WorkspaceApi): ReactNode {
  return (
    <WindowFrame
      win={win}
      top
      connState={null}
      linkRevision={0}
      api={api}
      wsRef={createRef<HTMLElement>()}
    />
  );
}

describe("WindowFrame config callback atomicity", () => {
  it("preserves a new root when resolved-directory metadata arrives before another render", async () => {
    const initial = filesWindow();
    const probe = mutationProbe(initial);
    registerWindowRender("files", (_cfg, ctx) => (
      <button
        type="button"
        onClick={() => {
          ctx.updateCfg({
            root: DISTINCT,
            rootBinding: "coding-repository",
            resolvedRoot: undefined,
            activeFilePath: undefined,
            activeDirectoryPath: undefined,
          });
          ctx.updateCfg({
            resolvedRoot: DISTINCT,
            activeFilePath: undefined,
            activeDirectoryPath: undefined,
          });
        }}
      >
        Open another folder
      </button>
    ));
    render(frame(initial, probe.api));
    await userEvent.click(screen.getByRole("button", { name: "Open another folder" }));
    const current = probe.current();
    const chat: AppWindow = { ...initial, id: "chat-source", type: "chat", cfg: {} };
    expect(subText("files", current.cfg)).toBe(DISTINCT);
    expect(filesChatBindScope(current, chat, 0)?.root).toBe(DISTINCT);
    expect(current.cfg["root"]).toBe(DISTINCT);
  });

  it("keeps the next parent-rendered configuration authoritative", async () => {
    const initial = filesWindow();
    const probe = mutationProbe(initial);
    registerWindowRender("files", (_cfg, ctx) => (
      <button type="button" onClick={() => ctx.updateCfg({ activeFilePath: "readme.txt" })}>
        Select a file
      </button>
    ));
    const { rerender } = render(frame(initial, probe.api));
    const parentConfig = {
      root: "/managed/task",
      resolvedRoot: "/managed/task",
      rootBinding: "coding-repository",
    };
    rerender(frame({ ...initial, cfg: parentConfig }, probe.api));
    await userEvent.click(screen.getByRole("button", { name: "Select a file" }));
    expect(probe.current().cfg["root"]).toBe("/managed/task");
    expect(probe.current().cfg["activeFilePath"]).toBe("readme.txt");
  });
});
