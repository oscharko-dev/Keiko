import { CODING_WORKBENCH_AGENTS } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-api";
import { OPENCODE_TOOL_PROFILES } from "@oscharko-dev/keiko-contracts/runtime/opencode-service-host";
import { describe, expect, it } from "vitest";

import { isAgentAdmitted, openCodeSelectableAgents } from "./opencodeAgents.js";

describe("OpenCode selectable primary agents (#3897)", () => {
  it("offers plan only on the native service, whose own policy makes it read-only", () => {
    expect(openCodeSelectableAgents("native")).toEqual(CODING_WORKBENCH_AGENTS);
    expect(openCodeSelectableAgents("native")).toContain("plan");
  });

  it.each(OPENCODE_TOOL_PROFILES.filter((profile) => profile !== "native"))(
    "keeps the governed %s profile on the default agent: its mapped tools bypass OpenCode's plan policy",
    (profile) => {
      expect(openCodeSelectableAgents(profile)).toEqual(["build"]);
    },
  );

  it("never offers an agent outside the closed Workbench vocabulary", () => {
    for (const profile of OPENCODE_TOOL_PROFILES) {
      for (const agent of openCodeSelectableAgents(profile)) {
        expect(CODING_WORKBENCH_AGENTS).toContain(agent);
      }
    }
  });
});

describe("isAgentAdmitted", () => {
  it("admits an absent request and the default agent without any capability", () => {
    expect(isAgentAdmitted(undefined, undefined)).toBe(true);
    expect(isAgentAdmitted([], undefined)).toBe(true);
    expect(isAgentAdmitted(undefined, "build")).toBe(true);
    expect(isAgentAdmitted([], "build")).toBe(true);
  });

  it("admits any other agent only when the run offers it", () => {
    expect(isAgentAdmitted(undefined, "plan")).toBe(false);
    expect(isAgentAdmitted(["build"], "plan")).toBe(false);
    expect(isAgentAdmitted(["build", "plan"], "plan")).toBe(true);
  });
});
