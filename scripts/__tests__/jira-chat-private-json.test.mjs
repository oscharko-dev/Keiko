import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { privateJson } from "../testing/jira-chat-lab/private-json.mjs";

const control = vi.hoisted(() => ({ fail: "", events: [] }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    writeFileSync: (descriptor, value) => {
      if (control.fail === "write") {
        actual.writeFileSync(descriptor, "{");
        throw new TypeError("Synthetic interrupted write");
      }
      return actual.writeFileSync(descriptor, value);
    },
    fsyncSync: (descriptor) => {
      const phase = actual.fstatSync(descriptor).isDirectory() ? "directory-sync" : "file-sync";
      control.events.push(phase);
      if (control.fail === phase) throw new TypeError(`Synthetic ${phase} failure`);
      return actual.fsyncSync(descriptor);
    },
    renameSync: (from, to) => {
      control.events.push("rename");
      if (control.fail === "rename") throw new TypeError("Synthetic rename failure");
      return actual.renameSync(from, to);
    },
  };
});

let directory;
let path;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "keiko-private-intent-"));
  path = join(directory, "pending.json");
  control.fail = "";
  control.events.length = 0;
});
afterEach(() => rmSync(directory, { force: true, recursive: true }));

it("durably creates a private exclusive intent without replacing an existing one", () => {
  privateJson(path, { phase: "prepared" }, true);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(control.events).toEqual(["file-sync", "directory-sync"]);
  expect(() => privateJson(path, { phase: "different" }, true)).toThrow();
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ phase: "prepared" });
});

it("syncs the complete private replacement before rename and syncs its directory afterward", () => {
  privateJson(path, { phase: "prepared" }, true);
  control.events.length = 0;
  privateJson(path, { phase: "effect-observed" });
  expect(control.events).toEqual(["file-sync", "rename", "directory-sync"]);
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ phase: "effect-observed" });
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(readdirSync(directory)).toEqual(["pending.json"]);
});

it.each(["write", "file-sync", "rename"])(
  "preserves the previous complete intent on %s failure",
  (phase) => {
    privateJson(path, { phase: "prepared", canonicalTurn: "synthetic-turn" }, true);
    control.fail = phase;
    expect(() => privateJson(path, { phase: "effect-observed" })).toThrow();
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      phase: "prepared",
      canonicalTurn: "synthetic-turn",
    });
    expect(readdirSync(directory)).toEqual(["pending.json"]);
  },
);

it("never reports a failed directory sync as durable success and retains complete JSON", () => {
  privateJson(path, { phase: "prepared" }, true);
  control.fail = "directory-sync";
  expect(() => privateJson(path, { phase: "effect-observed" })).toThrow();
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ phase: "effect-observed" });
});
