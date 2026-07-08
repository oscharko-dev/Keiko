import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCloneRepositoryHandler } from "./gitRepositoryRoutes.js";
import type { RouteContext } from "./routes.js";
import { createRunRegistry, type UiHandlerDeps } from "./index.js";
import { createInMemoryUiStore, type UiStore } from "./store/index.js";

let tmp: string;
let store: UiStore;

function deps(): UiHandlerDeps {
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env: {},
    redactor: (value: unknown) => value,
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store,
  };
}

function ctx(body: unknown): RouteContext {
  return {
    req: Readable.from([Buffer.from(JSON.stringify(body), "utf8")]) as IncomingMessage,
    res: {} as ServerResponse,
    params: {},
    url: new URL("http://127.0.0.1/api/repositories/clone"),
  };
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "keiko-repo-route-"));
  store = createInMemoryUiStore();
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("git repository routes", () => {
  it("clones a repository into a destination folder and registers it", async () => {
    const destination = join(tmp, "app");
    const cloneRunner = vi.fn((_repositoryUrl: string, destinationPath: string) => {
      mkdirSync(destinationPath);
      return Promise.resolve(null);
    });
    const handler = createCloneRepositoryHandler(cloneRunner);

    const result = await handler(
      ctx({
        repositoryUrl: "https://github.com/acme/app.git",
        destinationPath: destination,
        name: "Customer App",
      }),
      deps(),
    );

    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({
      project: { path: destination, name: "Customer App", available: true },
    });
    expect(cloneRunner).toHaveBeenCalledWith("https://github.com/acme/app.git", destination);
    expect(store.listProjects()).toContainEqual(
      expect.objectContaining({ path: destination, name: "Customer App" }),
    );
  });

  it("uses the shared hardened network git env for the clone spawn boundary", async () => {
    const destination = join(tmp, "app");
    const capturePath = join(tmp, "clone-env.json");
    const fakeGit = join(tmp, "git");
    writeFileSync(
      fakeGit,
      [
        "#!/usr/bin/env node",
        'const fs = require("node:fs");',
        `fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ args: process.argv.slice(2), env: process.env }));`,
        "fs.mkdirSync(process.argv.at(-1), { recursive: true });",
        "process.exit(0);",
      ].join("\n"),
      "utf8",
    );
    chmodSync(fakeGit, 0o755);
    vi.stubEnv("PATH", `${tmp}${delimiter}${process.env.PATH ?? ""}`);
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "aws-secret-that-must-not-reach-git");
    vi.stubEnv("GIT_CONFIG_GLOBAL", "/tmp/attacker.gitconfig");
    vi.stubEnv("GIT_ASKPASS", "/tmp/unsafe-askpass");
    vi.stubEnv("SSH_ASKPASS", "/tmp/unsafe-ssh-askpass");
    try {
      const result = await createCloneRepositoryHandler()(
        ctx({
          repositoryUrl: "https://github.com/acme/app.git",
          destinationPath: destination,
        }),
        deps(),
      );

      expect(result.status).toBe(201);
      const capture = JSON.parse(readFileSync(capturePath, "utf8")) as {
        readonly args: readonly string[];
        readonly env: NodeJS.ProcessEnv;
      };
      expect(capture.args).toEqual(["clone", "--", "https://github.com/acme/app.git", destination]);
      expect(capture.env.GIT_TERMINAL_PROMPT).toBe("0");
      expect(capture.env.GIT_SSH_COMMAND).toContain("StrictHostKeyChecking=yes");
      expect(capture.env.GIT_SSH_COMMAND).toContain("NumberOfPasswordPrompts=0");
      expect(capture.env.GIT_ASKPASS).not.toBe("/tmp/unsafe-askpass");
      expect(capture.env.SSH_ASKPASS).not.toBe("/tmp/unsafe-ssh-askpass");
      expect(capture.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      expect(capture.env.GIT_CONFIG_GLOBAL).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("the default clone path never spawns git for an option-like repository URL", async () => {
    // The injected-runner tests bypass the real cloneRepository. This drives the DEFAULT clone
    // path end to end with an option-like URL and proves git is never spawned: a fake git on PATH
    // writes a marker file if invoked, and the marker must never appear.
    const capturePath = join(tmp, "should-not-spawn.marker");
    const fakeGit = join(tmp, "git");
    writeFileSync(
      fakeGit,
      [
        "#!/usr/bin/env node",
        `require("node:fs").writeFileSync(${JSON.stringify(capturePath)}, "spawned");`,
        "process.exit(0);",
      ].join("\n"),
      "utf8",
    );
    chmodSync(fakeGit, 0o755);
    vi.stubEnv("PATH", `${tmp}${delimiter}${process.env.PATH ?? ""}`);
    try {
      const result = await createCloneRepositoryHandler()(
        ctx({
          repositoryUrl: "--upload-pack=touch /tmp/pwned",
          destinationPath: join(tmp, "app"),
        }),
        deps(),
      );
      expect(result.status).toBe(400);
      expect(existsSync(capturePath)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("rejects repository URLs that embed credentials", async () => {
    const cloneRunner = vi.fn(() => Promise.resolve(null));
    const handler = createCloneRepositoryHandler(cloneRunner);

    const result = await handler(
      ctx({
        repositoryUrl: "https://token@example.test/acme/app.git",
        destinationPath: join(tmp, "app"),
      }),
      deps(),
    );

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({
      error: { code: "BAD_REQUEST" },
    });
    expect(cloneRunner).not.toHaveBeenCalled();
  });

  it.each([
    "--upload-pack=touch /tmp/pwned",
    "-oProxyCommand=evil",
    "--config=core.fsmonitor=evil",
  ])("rejects an option-like repository URL that git could execute (%s)", async (repositoryUrl) => {
    const cloneRunner = vi.fn(() => Promise.resolve(null));
    const handler = createCloneRepositoryHandler(cloneRunner);

    const result = await handler(ctx({ repositoryUrl, destinationPath: join(tmp, "app") }), deps());

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: { code: "BAD_REQUEST" } });
    expect(cloneRunner).not.toHaveBeenCalled();
  });

  it.each([
    "https://169.254.169.254/acme/app.git",
    "https://10.0.0.5/acme/app.git",
    "ssh://git@192.168.1.10/acme/app.git",
    "git@172.16.0.9:acme/app.git",
    "https://localhost/acme/app.git",
  ])("rejects private or local repository clone target %s", async (repositoryUrl) => {
    const cloneRunner = vi.fn(() => Promise.resolve(null));
    const handler = createCloneRepositoryHandler(cloneRunner);

    const result = await handler(
      ctx({
        repositoryUrl,
        destinationPath: join(tmp, "app"),
      }),
      deps(),
    );

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({
      error: { code: "BAD_REQUEST" },
    });
    expect(cloneRunner).not.toHaveBeenCalled();
  });

  it("rejects an already existing destination before invoking git", async () => {
    const destination = join(tmp, "app");
    mkdirSync(destination);
    const cloneRunner = vi.fn(() => Promise.resolve(null));
    const handler = createCloneRepositoryHandler(cloneRunner);

    const result = await handler(
      ctx({
        repositoryUrl: "git@example.test:acme/app.git",
        destinationPath: destination,
      }),
      deps(),
    );

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({
      error: { code: "BAD_REQUEST" },
    });
    expect(cloneRunner).not.toHaveBeenCalled();
  });
});
