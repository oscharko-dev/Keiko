import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createInMemoryUiStore, createNodeUiStore } from "./index.js";
import { workspaceLayoutStorageId } from "../workspace-state-handlers.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("workspace layout identity", () => {
  it("belongs to the durable database, survives reopening and changes when it is replaced", () => {
    const directory = mkdtempSync(join(realpathSync(tmpdir()), "keiko-layout-identity-"));
    directories.push(directory);
    const path = join(directory, "keiko-ui.db");
    const project = join(directory, "project");
    mkdirSync(project);
    const first = createNodeUiStore(path);
    first.createProject(project);
    const chat = first.createChat(project, "Saved conversation", "local-chat-model");
    first.createMessage({
      chatId: chat.id,
      role: "user",
      content: "Saved before the restart.",
      timestamp: 1,
      runId: undefined,
      workflowId: undefined,
      workflowStatus: undefined,
      shortResult: undefined,
      taskType: undefined,
    });
    const identity = workspaceLayoutStorageId(first);
    first.close();
    expect(identity).toMatch(/^[0-9a-f]{64}$/u);

    const reopened = createNodeUiStore(path);
    expect(workspaceLayoutStorageId(reopened)).toBe(identity);
    expect(reopened.findChatById(chat.id)?.title).toBe("Saved conversation");
    expect(reopened.listMessages(chat.id).map((message) => message.content)).toEqual([
      "Saved before the restart.",
    ]);
    reopened.close();

    rmSync(path);
    const replacement = createNodeUiStore(path);
    try {
      expect(workspaceLayoutStorageId(replacement)).toMatch(/^[0-9a-f]{64}$/u);
      expect(workspaceLayoutStorageId(replacement)).not.toBe(identity);
    } finally {
      replacement.close();
    }
  });

  it("keeps independent stores distinct", () => {
    const first = createInMemoryUiStore();
    const second = createInMemoryUiStore();
    try {
      expect(workspaceLayoutStorageId(first)).toMatch(/^[0-9a-f]{64}$/u);
      expect(workspaceLayoutStorageId(second)).not.toBe(workspaceLayoutStorageId(first));
    } finally {
      first.close();
      second.close();
    }
  });
});
