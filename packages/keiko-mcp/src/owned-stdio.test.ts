import { spawnSync } from "node:child_process";
import { PassThrough } from "node:stream";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  assertMcpNativeStdioOwner,
  guardianEnvironment,
  isNativeMcpLocalAbsolutePath,
  ownedStdioLaunch,
  supportsOwnedMcpStdio,
} from "./owned-stdio.js";
import { ownedStdioEnvironment, runOwnedStdio } from "./owned-stdio-process.js";

it("only enables implemented process-group ownership", () => {
  expect(supportsOwnedMcpStdio("darwin")).toBe(true);
  expect(supportsOwnedMcpStdio("linux")).toBe(true);
  expect(supportsOwnedMcpStdio("win32")).toBe(false);
  expect(
    supportsOwnedMcpStdio("win32", { executable: "C:\\Keiko\\owner.exe", sha256: "a".repeat(64) }),
  ).toBe(true);
  expect(supportsOwnedMcpStdio("freebsd")).toBe(false);
});

it.each(["/provider/node", "\\provider\\node", "C:provider\\node", "\\\\host\\share\\node.exe"])(
  "refuses a Windows execution path without a qualified local drive: %s",
  (path) => {
    expect(isNativeMcpLocalAbsolutePath(path, "win32")).toBe(false);
  },
);
it("accepts native local paths and rejects foreign path forms", () => {
  expect(isNativeMcpLocalAbsolutePath("C:\\Provider\\node.exe", "win32")).toBe(true);
  expect(isNativeMcpLocalAbsolutePath("C:\\Provider\\node.exe", "darwin")).toBe(false);
  expect(isNativeMcpLocalAbsolutePath("/provider/node", "linux")).toBe(true);
});

it("uses the private profile and trusted system interpreter for the Windows guardian", () => {
  expect(guardianEnvironment("C:\\private", "win32", "C:\\Windows")).toMatchObject({
    SYSTEMROOT: "C:\\Windows",
    COMSPEC: "C:\\Windows\\System32\\cmd.exe",
    USERPROFILE: "C:\\private",
    TEMP: "C:\\private",
  });
  for (const root of ["relative", "C:Windows", "\\\\host\\Windows"])
    expect(() => guardianEnvironment("C:\\private", "win32", root)).toThrow();
});

it("requires a regular bounded artifact with the admitted digest immediately before execution", () => {
  const root = mkdtempSync(join(tmpdir(), "keiko-mcp-native-owner-"));
  const path = join(root, "owner");
  const content = "synthetic first-party artifact";
  const owner = { executable: path, sha256: createHash("sha256").update(content).digest("hex") };
  try {
    writeFileSync(path, content, { mode: 0o600 });
    expect(() => {
      assertMcpNativeStdioOwner(owner);
    }).not.toThrow();
    expect(() => {
      assertMcpNativeStdioOwner({ ...owner, executable: "relative" });
    }).toThrow();
    expect(() => {
      assertMcpNativeStdioOwner({ ...owner, sha256: "invalid" });
    }).toThrow();
    expect(() => {
      assertMcpNativeStdioOwner({ ...owner, executable: root });
    }).toThrow();
    if (process.platform !== "win32") {
      symlinkSync(path, join(root, "link"));
      expect(() => {
        assertMcpNativeStdioOwner({ ...owner, executable: join(root, "link") });
      }).toThrow();
    }
    writeFileSync(path, "changed");
    expect(() => {
      assertMcpNativeStdioOwner(owner);
    }).toThrow();
    truncateSync(path, 4 * 1024 * 1024 + 1);
    expect(() => {
      assertMcpNativeStdioOwner(owner);
    }).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it.skipIf(!supportsOwnedMcpStdio())(
  "isolates loader variables while preserving the provider environment",
  () => {
    const environment = {
      NODE_OPTIONS: "--max-old-space-size=64",
      LD_PRELOAD: "synthetic-loader",
      KEIKO_MCP_STDIO_ENV_9999: "synthetic-provider-value",
      SECRET: "synthetic-secret",
      PATH: "/synthetic/bin",
    };
    const launch = ownedStdioLaunch(
      ["/synthetic/provider", "one argument"],
      environment,
      "/private/provider",
    );
    expect(launch.command).toBe(process.execPath);
    expect(launch.args.at(0)).toMatch(/owned-stdio-worker\.js$/u);
    expect(launch.args.slice(1)).toEqual(["/synthetic/provider", "one argument"]);
    expect(launch.env.NODE_OPTIONS).toBe("");
    expect(launch.env.LD_PRELOAD).toBe("");
    expect(launch.env.SECRET).toBe("");
    expect(ownedStdioEnvironment(launch.env)).toEqual(environment);
  },
);

it.each([undefined, "not-json", "null", "[]", '["x",1]', '["x","y","z"]'])(
  "refuses malformed owner environment %s",
  (value) => {
    expect(() => ownedStdioEnvironment({ KEIKO_MCP_STDIO_ENV_0: value })).toThrow();
  },
);

function streams(): {
  input: PassThrough;
  output: PassThrough;
  errors: PassThrough;
  signal: AbortSignal;
  lifetime: AbortController;
} {
  const lifetime = new AbortController();
  return {
    input: new PassThrough(),
    output: new PassThrough(),
    errors: new PassThrough(),
    signal: lifetime.signal,
    lifetime,
  };
}

it.skipIf(!supportsOwnedMcpStdio())(
  "does not launch after lifetime expiry and handles a missing executable",
  async () => {
    const io = streams();
    io.lifetime.abort();
    expect(
      await runOwnedStdio({ ...io, command: "/absent-mcp-program", args: [], environment: {} }),
    ).toBe(1);
    expect(
      await runOwnedStdio({
        ...streams(),
        command: "/absent-mcp-program",
        args: [],
        environment: {},
      }),
    ).toBe(1);
  },
);

it("refuses an already-ended input and duplicate encoded environment entries", async () => {
  const io = streams();
  io.input.end();
  io.input.resume();
  await new Promise<void>((resolve) => {
    io.input.once("end", resolve);
  });
  expect(
    await runOwnedStdio({ ...io, command: "/absent-mcp-program", args: [], environment: {} }),
  ).toBe(1);
  expect(() =>
    ownedStdioEnvironment({
      KEIKO_MCP_STDIO_ENV_0: '["x","one"]',
      KEIKO_MCP_STDIO_ENV_1: '["x","two"]',
    }),
  ).toThrow();
});

it.skipIf(!supportsOwnedMcpStdio())(
  "forwards bytes and the provider exit without parsing MCP",
  async () => {
    const io = streams();
    let output = "";
    io.output.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    const completed = runOwnedStdio({
      ...io,
      command: process.execPath,
      args: [
        "--eval",
        "process.stdin.once('data', b => { process.stdout.write(b); process.exitCode=0; process.stdin.destroy(); });",
      ],
      environment: {},
    });
    io.input.write("synthetic-wire\n");
    expect(await completed).toBe(0);
    expect(output).toBe("synthetic-wire\n");
    expect(io.input.listenerCount("end")).toBe(0);
    expect(io.output.listenerCount("error")).toBe(0);
  },
);

it
  .skipIf(!supportsOwnedMcpStdio())
  .each(["abort", "input-end", "provider-exit", "output-error"] as const)(
  "removes a provider's ordinary descendants on %s",
  async (event) => {
    const io = streams();
    let line = "";
    io.output.on("data", (chunk: Buffer) => {
      line += chunk.toString();
    });
    const descendant = "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);";
    const program = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['--eval',${JSON.stringify(descendant)}],{stdio:'ignore'});process.stdout.write(JSON.stringify([process.pid,child.pid])+'\\n');${event === "provider-exit" ? "setTimeout(()=>process.exit(0),50);" : "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);"}`;
    const completed = runOwnedStdio({
      ...io,
      command: process.execPath,
      args: ["--eval", program],
      environment: {},
    });
    try {
      await expect.poll(() => line.includes("\n")).toBe(true);
      const pids = JSON.parse(line) as number[];
      if (event === "abort") io.lifetime.abort();
      if (event === "input-end") io.input.end();
      if (event === "output-error") io.output.destroy(new Error("synthetic output closed"));
      await completed;
      for (const pid of pids) {
        await expect
          .poll(
            () =>
              spawnSync("/bin/ps", ["-p", String(pid), "-o", "pid="], {
                encoding: "utf8",
              }).stdout.trim(),
            { timeout: 2000 },
          )
          .toBe("");
      }
      expect(io.input.listenerCount("end")).toBe(0);
    } finally {
      io.lifetime.abort();
      await completed;
    }
  },
);
