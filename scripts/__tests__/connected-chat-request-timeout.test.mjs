// Exercises the operator-facing driver without starting a runtime or contacting a provider.
import { spawnSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import { describe, expect, it } from "vitest";
import { CONNECTED_CHAT_CAMPAIGNS } from "../testing/coding-workbench-lab/connected-chat-cases.mjs";

const DRIVER = fileURLToPath(
  new URL("../testing/coding-workbench-lab/connected-chat-run.mjs", import.meta.url),
);

function prepare(timeout) {
  const args = [DRIVER, "--campaign", "knowledge", "--prepare"];
  if (timeout !== undefined) args.push("--request-timeout-ms", timeout);
  return spawnSync(process.execPath, args, { encoding: "utf8" });
}

describe("connected-chat qualification request deadline", () => {
  it("allows an explicit quality-first deadline without replacing original questions", () => {
    const result = prepare("360000");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      disposition: "preparation-only",
      campaign: "knowledge",
      caseIds: CONNECTED_CHAT_CAMPAIGNS.knowledge.map((row) => row.id),
      setupSynthesisTurns: 0,
      requestTimeoutMs: 360000,
    });
  });

  it("defaults to a deadline that includes retrieval before the native provider call", () => {
    const result = prepare();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).requestTimeoutMs).toBe(240000);
  });

  it.each(["0", "-1", "1.5", "NaN", "2147483648", "4294967296"])(
    "rejects an invalid platform deadline %s before runtime access",
    (value) => {
      const result = prepare(value);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).not.toContain(value);
    },
  );
});
