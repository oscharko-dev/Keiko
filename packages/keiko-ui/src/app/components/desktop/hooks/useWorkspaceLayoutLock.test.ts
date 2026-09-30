import { describe, expect, it, vi } from "vitest";
import { workspaceApiFixture } from "../../../../test-utils/workspace-api-fixture";
import { protectWorkspaceLayout } from "./useWorkspaceLayoutLock";

describe("workspace layout lock at the owning API", () => {
  it("guards command paths and pointer gestures that started before locking", () => {
    let locked = false;
    const source = workspaceApiFixture();
    const api = protectWorkspaceLayout(source, () => locked);
    api.update("chat-1", { x: 50 });
    expect(source.update).toHaveBeenCalledWith("chat-1", { x: 50 });
    vi.mocked(source.update).mockClear();
    locked = true;
    api.update("chat-1", { x: 80, y: 40, w: 600, h: 500, max: true });
    api.maximize("chat-1");
    api.tileAll();
    api.splitFront();
    api.cascade();
    api.setSnap("left");
    api.commitSnap("chat-1");
    expect(api.moveSelectedWindowsBy(20, 40)).toEqual({ dx: 0, dy: 0 });
    for (const action of [
      source.update,
      source.maximize,
      source.tileAll,
      source.splitFront,
      source.cascade,
      source.setSnap,
      source.commitSnap,
      source.moveSelectedWindowsBy,
    ]) {
      expect(action).not.toHaveBeenCalled();
    }
    locked = false;
    api.tileAll();
    expect(source.tileAll).toHaveBeenCalledOnce();
  });

  it("keeps content updates and focus usable without selecting the window", () => {
    const source = workspaceApiFixture();
    const api = protectWorkspaceLayout(source, () => true);
    api.update("chat-1", { x: 90, cfg: { title: "Updated" }, zoom: 1.2 });
    expect(source.update).toHaveBeenCalledWith("chat-1", { cfg: { title: "Updated" }, zoom: 1.2 });
    api.activateWindow("chat-1");
    api.replaceSelection(["chat-1"]);
    api.toggleWindowSelection("chat-1");
    expect(source.focus).toHaveBeenCalledWith("chat-1");
    expect(source.activateWindow).not.toHaveBeenCalled();
    expect(source.replaceSelection).not.toHaveBeenCalled();
    expect(source.toggleWindowSelection).not.toHaveBeenCalled();
  });
});
