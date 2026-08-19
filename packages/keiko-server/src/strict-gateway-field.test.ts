import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { buildUiHandlerDeps } from "./deps.js";
import type { UiHandlerDeps } from "./deps.js";
import type { RouteContext } from "./routes.js";
import { handleGatewaySetup } from "./gateway-setup.js";
import { handleCreateDesktopChat } from "./chat-handlers.js";
import {
  handleConnectLocalKnowledgeCapsule,
  handleCreateLocalKnowledgeCapsule,
  handleGetLocalKnowledgeCapsule,
  handleStartLocalKnowledgeCapsuleIndexing,
} from "./local-knowledge-handlers.js";

// Field twin of the customer's strict LiteLLM (2026-08 incident): chat completions answer
// normally, but the embeddings route rejects EVERY request carrying optional extras — the
// unconditional `encoding_format` or an array `input` — with an answered HTTP 400, exactly
// like the readiness cards showed ("Embedding endpoint could not be verified (http-error
// 400)"). The journey below is the exact customer path on a FRESH install: save credentials,
// open a chat immediately (no manual readiness click), create a Knowledge Pod, connect a
// folder, index it. It must reach vectors end to end over the REAL production deps and the
// REAL embedding transport — no adapter seam, no mocked fetch.

const VAULT_ENV: Readonly<Record<string, string>> = {
  KEIKO_PROVIDER_CREDENTIALS_KEY: Buffer.alloc(32, 0x21).toString("base64"),
  KEIKO_FIGMA_KEY: Buffer.alloc(32, 0x42).toString("base64"),
};

function json(res: ServerResponse, payload: unknown, status = 200): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

interface FakeGatewayLog {
  embeddingBodies: Record<string, unknown>[];
}

function startStrictLiteLlm(log: FakeGatewayLog): Server {
  return createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on("end", () => {
      // Decode once after ALL chunks arrived: a multi-byte umlaut straddling a chunk
      // boundary must not corrupt the JSON body.
      const raw = Buffer.concat(chunks).toString("utf8");
      const url = req.url ?? "";
      if (url.endsWith("/model/info")) {
        json(res, {
          data: [
            { model_name: "qwen-chat", model_info: { mode: "chat" } },
            { model_name: "multilingual-e5-large", model_info: { mode: "embedding" } },
          ],
        });
        return;
      }
      if (url.endsWith("/chat/completions")) {
        json(res, {
          choices: [{ message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 1 },
        });
        return;
      }
      if (url.endsWith("/embeddings")) {
        const body = JSON.parse(raw === "" ? "{}" : raw) as Record<string, unknown>;
        log.embeddingBodies.push(body);
        if ("encoding_format" in body || Array.isArray(body.input)) {
          json(res, { error: { message: "unsupported request shape" } }, 400);
          return;
        }
        json(res, {
          data: [{ embedding: Array.from({ length: 1024 }, (_, i) => Math.sin(i + 1)) }],
          model: "multilingual-e5-large",
        });
        return;
      }
      json(res, { error: { message: `unknown route ${url}` } }, 404);
    });
  });
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("no port"));
        return;
      }
      resolve(address.port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

function ctx(
  method: string,
  body: Record<string, unknown>,
  params: Record<string, string> = {},
  path = "/api",
): RouteContext {
  const req = Readable.from([
    Buffer.from(JSON.stringify(body), "utf8"),
  ]) as unknown as IncomingMessage;
  (req as unknown as { method: string }).method = method;
  (req as unknown as { headers: Record<string, string> }).headers = {
    "content-type": "application/json",
  };
  return {
    req,
    res: {
      destroyed: false,
      closed: false,
      writableEnded: false,
      once(): void {
        // deterministic stub
      },
      off(): void {
        // deterministic stub
      },
    } as unknown as ServerResponse,
    params,
    url: new URL(`http://127.0.0.1${path}`),
  };
}

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("strict LiteLLM field twin", () => {
  it("carries the full fresh-install customer journey to indexed vectors", async () => {
    const log: FakeGatewayLog = { embeddingBodies: [] };
    const gateway = startStrictLiteLlm(log);
    const port = await listen(gateway);
    const tmp = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "keiko-field-")));
    tempDirs.push(tmp);
    const projectDir = join(tmp, "repo");
    const docsDir = join(tmp, "handbuch");
    const evidenceDir = join(tmp, "evidence");
    mkdirSync(projectDir);
    mkdirSync(docsDir);
    mkdirSync(evidenceDir);
    writeFileSync(
      join(docsDir, "index.html"),
      "<html><body><h1>Handbuch</h1><p>KFZ Kapitel eins.</p></body></html>",
      "utf8",
    );
    writeFileSync(
      join(docsDir, "kapitel-zwei.md"),
      "# Kapitel zwei\n\nVersicherung und Zahlungsverkehr.\n",
      "utf8",
    );

    let deps: UiHandlerDeps | undefined;
    try {
      deps = buildUiHandlerDeps({
        configPath: undefined,
        evidenceDir,
        uiDbPath: join(tmp, "keiko-ui.db"),
        env: { ...VAULT_ENV, KEIKO_ALLOW_PRIVATE_EGRESS: "true" },
      });
      deps.store.createProject(projectDir, "repo");

      // 1. Save credentials — the only manual step the customer performs.
      const setup = await handleGatewaySetup(
        ctx("POST", {
          baseUrl: `http://127.0.0.1:${String(port)}/v1`,
          apiKey: "field-token",
        }),
        deps,
      );
      expect(setup.status).toBe(200);

      // 2. Open a chat IMMEDIATELY — no manual readiness click. The on-demand probe must
      // verify the model inline instead of rejecting the fresh install.
      const chat = await handleCreateDesktopChat(
        ctx("POST", { projectPath: projectDir, title: "Erster Chat" }),
        deps,
      );
      expect(chat.status).toBe(201);

      // 3. Knowledge Pod: create, connect the manual folder, index.
      const created = await handleCreateLocalKnowledgeCapsule(
        ctx("POST", { displayName: "Handbuch" }),
        deps,
      );
      expect(created.status).toBe(201);
      const capsuleId = (created.body as { capsule: { id: string } }).capsule.id;

      const connected = await handleConnectLocalKnowledgeCapsule(
        ctx(
          "POST",
          { scope: { kind: "folder", rootPath: docsDir, recursive: true } },
          { capsuleId },
        ),
        deps,
      );
      expect(connected.status).toBe(201);

      const indexed = await handleStartLocalKnowledgeCapsuleIndexing(
        ctx("POST", {}, { capsuleId }),
        deps,
      );
      expect(indexed.status).toBe(200);

      const detail = await handleGetLocalKnowledgeCapsule(ctx("GET", {}, { capsuleId }), deps);
      const body = detail.body as {
        readonly capsule: { readonly lifecycleState: string };
        readonly health: { readonly documentCount: number; readonly vectorCount: number };
        readonly indexingJobs: readonly { readonly status: string }[];
      };
      expect(body.capsule.lifecycleState).toBe("ready");
      expect(body.health.documentCount).toBeGreaterThan(0);
      expect(body.health.vectorCount).toBeGreaterThan(0);
      expect(body.indexingJobs.at(0)?.status).toBe("succeeded");

      // The strict gateway rejected every extras-carrying request; the ladder must have
      // landed on minimal scalar requests — and at least one 400 was actually answered.
      expect(log.embeddingBodies.some((entry) => "encoding_format" in entry)).toBe(true);
      // The batch-to-scalar degradation actually exercised the array rung: an array body was
      // attempted (and rejected), and minimal scalar bodies carried the run.
      expect(log.embeddingBodies.some((entry) => Array.isArray(entry.input))).toBe(true);
      expect(
        log.embeddingBodies.some(
          (entry) => !("encoding_format" in entry) && !Array.isArray(entry.input),
        ),
      ).toBe(true);
    } finally {
      await deps?.dispose?.();
      await closeServer(gateway);
    }
  });
});
