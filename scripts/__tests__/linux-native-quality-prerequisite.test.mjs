import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, delimiter } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { URL } from "node:url";

const roots = [];
const command = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"))
  .scripts["check:native:linux"];

function run(buildExit) {
  const root = mkdtempSync(join(tmpdir(), "keiko-native-prerequisite-"));
  roots.push(root);
  const bin = join(root, "bin"),
    events = join(root, "events.jsonl");
  mkdirSync(bin);
  for (const name of ["npm", "bash"]) {
    writeFileSync(
      join(bin, name),
      `#!${process.execPath}\nimport {appendFileSync} from "node:fs";\nappendFileSync(process.env.SYNTHETIC_EVENTS,JSON.stringify({command:${JSON.stringify(name)},args:process.argv.slice(2)})+"\\n");\nprocess.exitCode=${name === "npm" ? "Number(process.env.SYNTHETIC_BUILD_EXIT)" : "0"};\n`,
      { mode: 0o700 },
    );
  }
  const result = spawnSync("/bin/sh", ["-c", `${command} --kernel`], {
    cwd: root,
    encoding: "utf8",
    env: {
      PATH: `${bin}${delimiter}${dirname(process.execPath)}`,
      SYNTHETIC_EVENTS: events,
      SYNTHETIC_BUILD_EXIT: String(buildExit),
    },
  });
  expect(result.error).toBeUndefined();
  return {
    status: result.status,
    events: readFileSync(events, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")(
  "native Linux gate entry point build prerequisite",
  () => {
    it("runs the existing package build before the native command and forwards its requested scope", () => {
      const result = run(0);
      expect(result.status).toBe(0);
      expect(result.events).toEqual([
        { command: "npm", args: ["run", "build:packages"] },
        { command: "bash", args: ["scripts/check-linux-native-quality.sh", "--kernel"] },
      ]);
    });

    it("refuses the native command after a failed package build", () => {
      const result = run(42);
      expect(result.status).toBe(42);
      expect(result.events).toEqual([{ command: "npm", args: ["run", "build:packages"] }]);
    });
  },
);
