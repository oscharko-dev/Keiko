import { fork } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const RUNNER = fileURLToPath(new URL("../testing/memory-lab/run.mjs", import.meta.url));
function scenario(id) {
  return {
    schemaVersion: 1,
    id,
    language: "en",
    class: "preference",
    difficulty: "plain",
    description: "Synthetic output ownership proof.",
    truth: [{ key: "k", seed: "I like plain text.", must: true, terms: [["plain text"]] }],
    turns: [{ user: "I like plain text." }],
    probes: [{ id: "p", question: "Format?", expect: { kind: "answer", terms: [["plain text"]] } }],
  };
}

describe("exclusive lab output ownership (#4247)", () => {
  let root;
  let children;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "memory-lab-output-"));
    children = [];
    mkdirSync(join(root, "scenarios"));
    const runtime = join(root, "subject", "scripts", "testing", "chat-skills-lab");
    mkdirSync(runtime, { recursive: true });
    writeFileSync(
      join(runtime, "runtime.mjs"),
      `export async function startObservedBff() {
      await new Promise(resolve => { process.once("message", resolve); process.send("ready"); });
      throw new Error("synthetic start failure");
    }`,
    );
    writeFileSync(
      join(root, "child.mjs"),
      `import {runLab, normalizeOptions} from ${JSON.stringify(RUNNER)};
      try {
        const summary = await runLab(normalizeOptions(JSON.parse(process.argv[2])), () => undefined);
        process.send({done: true, runs: summary.runs, failed: summary.failedUnits});
      } catch (error) { process.send({error: error.message}); }
      process.disconnect();`,
    );
  });
  afterEach(async () => {
    for (const state of children) if (state.child.exitCode === null) state.child.kill("SIGKILL");
    await Promise.all(children.map((state) => state.exited));
    rmSync(root, { recursive: true, force: true });
  });
  function start(extra = {}) {
    const options = {
      out: join(root, "out"),
      scenarios: join(root, "scenarios"),
      "subject-root": join(root, "subject"),
      arms: "off",
      "memory-mode": "governed-assist",
      ...extra,
    };
    const child = fork(join(root, "child.mjs"), [JSON.stringify(options)], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const state = { child, message: once(child, "message"), exited: once(child, "exit") };
    children.push(state);
    return state;
  }
  it.each([false, true])("refuses a second live writer, including resume=%s", async (resume) => {
    writeFileSync(join(root, "scenarios", "one.json"), JSON.stringify(scenario("one")));
    const first = start();
    expect((await first.message)[0]).toBe("ready");
    const second = start({ resume, "memory-mode": "autonomous-delivery" });
    expect((await second.message)[0]).toEqual({
      error: "another lab process owns the output directory",
    });
    await second.exited;
    first.child.send("go");
    await first.exited;
    const manifest = JSON.parse(readFileSync(join(root, "out", "manifest.json"), "utf8"));
    expect(manifest.metadata.memoryMode).toBe("governed-assist");
  });
  it("resumes after a killed owner and keeps the completed unit", async () => {
    for (const id of ["one", "two"])
      writeFileSync(join(root, "scenarios", `${id}.json`), JSON.stringify(scenario(id)));
    const first = start();
    expect((await first.message)[0]).toBe("ready");
    const secondUnit = once(first.child, "message");
    first.child.send("go");
    expect((await secondUnit)[0]).toBe("ready");
    expect(existsSync(join(root, "out", ".progress", "00000000.json"))).toBe(true);
    first.child.kill("SIGKILL");
    await first.exited;
    const resumed = start({ resume: true });
    expect((await resumed.message)[0]).toBe("ready");
    const result = once(resumed.child, "message");
    resumed.child.send("go");
    expect((await result)[0]).toEqual({ done: true, runs: 2, failed: 2 });
    await resumed.exited;
    expect(existsSync(join(root, "out", ".progress"))).toBe(false);
  });
});
