import { EventEmitter } from "node:events";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MODEL, startRuntime } from "../testing/chat-skills-lab/runtime.mjs";

const ports = vi.hoisted(() => ({ fork: vi.fn(), session: vi.fn() }));
vi.mock("node:child_process", async (original) => ({ ...(await original()), fork: ports.fork }));
vi.mock("../testing/coding-workbench-lab/lab-common.mjs", async (original) => ({
  ...(await original()),
  openApiSession: ports.session,
}));
let directory, upstream, runtime, proxyUrl;

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "keiko-physical-retention-"));
  upstream = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify(
        request.url === "/model/info"
          ? {
              data: [
                {
                  model_name: MODEL,
                  model_info: { context_window: 131072, max_output_tokens: 8192 },
                },
              ],
            }
          : { choices: [{ message: { content: "synthetic" }, finish_reason: "stop" }] },
      ),
    );
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  vi.stubEnv("KEIKO_SKILL_LAB_API_KEY", "synthetic");
  vi.stubEnv("KEIKO_SKILL_LAB_BASE_URL", `http://127.0.0.1:${upstream.address().port}`);
  ports.fork.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      pid: 12345,
      exitCode: null,
      signalCode: null,
    });
    child.kill = () => {
      globalThis.queueMicrotask(() => {
        child.exitCode = 0;
        child.emit("exit", 0, null);
      });
      return true;
    };
    globalThis.queueMicrotask(() => child.emit("message", { kind: "ready", port: 1 }));
    return child;
  });
});

afterEach(async () => {
  try {
    await runtime?.close();
  } finally {
    runtime = undefined;
    await new Promise((resolve) => {
      upstream.close(resolve);
      upstream.closeAllConnections();
    });
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("caller-owned physical observations survive construction", () => {
  it.each([false, true])(
    "retains the actual contained HTTP exchange when constructor refuses: %s",
    async (refuse) => {
      const failure = new Error("synthetic-session-refusal"),
        physical = [];
      ports.session.mockImplementation(async (_url, env) => {
        const config = JSON.parse(readFileSync(env.KEIKO_CONFIG_FILE, "utf8"));
        proxyUrl = `${config.providers[0].baseUrl}/chat/completions`;
        const response = await globalThis.fetch(proxyUrl, {
          method: "POST",
          body: JSON.stringify({ messages: [{ role: "user", content: "synthetic" }] }),
        });
        expect(response.status).toBe(200);
        await response.text();
        if (refuse) throw failure;
        return { request: vi.fn() };
      });
      const [result] = await Promise.allSettled([
        startRuntime(directory, { physicalRecorder: physical }),
      ]);
      if (refuse) {
        expect(result).toEqual({ status: "rejected", reason: failure });
        await expect(globalThis.fetch(proxyUrl)).rejects.toThrow();
      } else {
        expect(result.status).toBe("fulfilled");
        runtime = result.value;
        expect(runtime.physical).toBe(physical);
      }
      expect(physical).toHaveLength(1);
      expect(physical[0]).toMatchObject({
        status: 200,
        responseKind: "complete",
        operation: "conversation",
        caseRequest: false,
      });
      expect(physical[0].requestDigest).toMatch(/^[a-f0-9]{64}$/u);
    },
  );

  it("rejects a malformed recorder before setup or a child can begin", async () => {
    await expect(startRuntime(directory, { physicalRecorder: {} })).rejects.toThrow(
      "caller-owned-physical-recorder-required",
    );
    expect(ports.fork).not.toHaveBeenCalled();
    expect(ports.session).not.toHaveBeenCalled();
  });
});
