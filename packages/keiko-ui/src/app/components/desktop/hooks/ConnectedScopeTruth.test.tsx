import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Chat, ChatConnectedScope } from "@/lib/types";
import { ConnectedScopePill } from "../ConnectedScopePill";
import { ConnectionsLayer } from "../windows/ConnectionsLayer";
import { registerChatWindowRuntime } from "../windows/chatWindowActivity";
import type { AppWindow } from "../windows/types";
import { workspaceApiFixture } from "@/test-utils/workspace-api-fixture";

const root = "/repo";
const cases: readonly [ChatConnectedScope["kind"], string[], string, string, string][] = [
  ["workspace-root", [], "Folder: repo", "uses repo/", "/repo"],
  ["directory", ["src/feature"], "Folder: repo/src/feature", "uses feature/", "/repo/src/feature"],
  [
    "files",
    ["src/feature/validation.ts"],
    "File: validation.ts",
    "uses validation.ts",
    "/repo/src/feature/validation.ts",
  ],
];
describe("one acknowledged scope", () => {
  it.each(cases)(
    "renders agreeing pill, edge, and complete path for %s",
    (kind, relativePaths, label, edge, fullPath) => {
      const scope: ChatConnectedScope = { kind, root, relativePaths, connectedAtMs: 1 };
      const chat: Chat = {
        id: "a",
        projectPath: root,
        title: "Chat",
        selectedModel: "model",
        branchLabel: undefined,
        status: undefined,
        localKnowledgeScope: undefined,
        connectedScope: scope,
        createdAt: 1,
        updatedAt: 1,
      };
      const wins: AppWindow[] = [
        { id: "chat", type: "chat", x: 0, y: 0, w: 100, h: 100, z: 1, max: false, cfg: {} },
        {
          id: "files",
          type: "files",
          x: 1000,
          y: 0,
          w: 100,
          h: 100,
          z: 1,
          max: false,
          cfg: { root, activeFilePath: "unacknowledged.ts" },
        },
      ];
      const unregister = registerChatWindowRuntime("chat", {
        conversationId: chat.id,
        projectPath: root,
        connectedScopes: [scope],
      });
      try {
        render(
          <>
            <ConnectedScopePill chat={chat} />
            <ConnectionsLayer
              wins={wins}
              conns={[{ id: "edge", a: "chat", b: "files", boundRoot: root }]}
              connecting={null}
              api={workspaceApiFixture()}
            />
          </>,
        );
        expect(screen.getByText(label)).toBeInTheDocument();
        expect(screen.getByRole("button", { name: `Remove connection: ${edge}` })).toHaveAttribute(
          "title",
          expect.stringContaining(relativePaths[0] ?? root),
        );
        expect(screen.getByText(label)).toHaveAttribute("title", fullPath);
        expect(screen.getByText(label)).toHaveAttribute("aria-label", `${label} (${fullPath})`);
        expect(screen.queryByText(/Keiko may inspect only/)).toBeNull();
      } finally {
        unregister();
      }
    },
  );
});
