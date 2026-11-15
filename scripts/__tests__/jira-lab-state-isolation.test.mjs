// The lab is hermetic (#4369): beside KEIKO_MEMORY_DIR it sets KEIKO_STATE_DIR, so the process-wide
// diagnostics writers never fall back to `<cwd>/.keiko`.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chatReadLogDirectory, isolateRuntimeState } from "../testing/jira-chat-lab/chat-read.mjs";

const session = { directory: "/private/lab-session" };

describe("isolateRuntimeState", () => {
  it("points KEIKO_STATE_DIR into the private session and restores the previous value", () => {
    const env = { KEIKO_STATE_DIR: "/operator/state" };
    const restore = isolateRuntimeState(session, env);
    expect(env.KEIKO_STATE_DIR).toBe(chatReadLogDirectory(session));
    expect(env.KEIKO_STATE_DIR.startsWith(join(session.directory, "/"))).toBe(true);
    restore();
    expect(env.KEIKO_STATE_DIR).toBe("/operator/state");
  });

  it("removes the variable again when it was unset", () => {
    const env = {};
    isolateRuntimeState(session, env)();
    expect(Object.hasOwn(env, "KEIKO_STATE_DIR")).toBe(false);
  });

  it("matches the directory the lab's Activity Log reader uses", () => {
    expect(chatReadLogDirectory(session)).toBe(join(session.directory, "chat-read-logs"));
  });
});
