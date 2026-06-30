import { afterEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceFs, WorkspaceStat } from "@oscharko-dev/keiko-workspace";
import type { KnowledgeCapsuleId, KnowledgeSourceId } from "@oscharko-dev/keiko-contracts";
import {
  addSourceToCapsule,
  createCapsule,
  createDefaultParserRegistry,
  openKnowledgeStore,
  resolveKnowledgeStorePath,
  runIndexingJob,
  searchVectorsForScope,
} from "@oscharko-dev/keiko-local-knowledge";
import type {
  OpenAIEmbeddingAdapter,
  OpenAIEmbeddingOutcome,
  OpenAIEmbeddingRequest,
} from "@oscharko-dev/keiko-model-gateway";
import {
  buildRedactor,
  buildUiHandlerDeps,
  currentGatewayEgressConfig,
  currentRedactionSecrets,
} from "./deps.js";
import { parseGatewayConfig } from "@oscharko-dev/keiko-model-gateway";
import { createInMemoryUiStore } from "./store/index.js";
import { DatabaseSync } from "node:sqlite";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

function tmp(prefix: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tmpDirs.push(d);
  return d;
}

function realWorkspaceFs(): WorkspaceFs {
  return {
    readFileUtf8: (absolutePath): string => readFileSync(absolutePath, "utf8"),
    stat: (absolutePath): WorkspaceStat => {
      const stats = statSync(absolutePath);
      return {
        size: stats.size,
        isFile: stats.isFile(),
        isDirectory: stats.isDirectory(),
        isSymbolicLink: lstatSync(absolutePath).isSymbolicLink(),
        hardLinkCount: stats.nlink,
        mtimeMs: stats.mtimeMs,
      };
    },
    readDir: (absolutePath) =>
      readdirSync(absolutePath, { withFileTypes: true }).map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile(),
        isSymbolicLink: entry.isSymbolicLink(),
      })),
    realPath: (absolutePath): string => realpathSync(absolutePath),
    exists: (absolutePath): boolean => {
      try {
        return statSync(absolutePath, { throwIfNoEntry: false }) !== undefined;
      } catch {
        return false;
      }
    },
    readFileBytes: (absolutePath, maxBytes): Promise<Uint8Array> => {
      const bytes = readFileSync(absolutePath);
      return Promise.resolve(bytes.subarray(0, Math.max(0, Math.floor(maxBytes))));
    },
  };
}

function deterministicVector(input: string, dimensions: number): Float32Array {
  const vector = new Float32Array(dimensions);
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) | 0;
  }
  vector[0] = input.length;
  for (let i = 1; i < dimensions; i += 1) {
    vector[i] = ((hash + i * 7) & 0xffff) / 0xffff;
  }
  return vector;
}

function localKnowledgeAdapter(dimensions = 1536): OpenAIEmbeddingAdapter {
  const responder = (request: OpenAIEmbeddingRequest): OpenAIEmbeddingOutcome => ({
    ok: true,
    value: {
      vector: deterministicVector(request.input, dimensions),
      modelId: request.modelId,
    },
  });
  return {
    endpoint: "https://example.test/v1",
    apiKey: ["sk-", "test"].join(""),
    request: async (request): Promise<OpenAIEmbeddingOutcome> =>
      Promise.resolve(responder(request)),
  };
}

async function drain<T>(stream: AsyncIterable<T>): Promise<readonly T[]> {
  const out: T[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

function readAllStoreBytes(dbPath: string): Buffer {
  const chunks: Buffer[] = [];
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (existsSync(path)) chunks.push(readFileSync(path));
  }
  return Buffer.concat(chunks);
}

describe("buildRedactor", () => {
  it("scrubs non-pattern secret values from sensitive environment variables", () => {
    const secret = ["CORPSECRET_", "123456789"].join("");
    const redactor = buildRedactor({ KEIKO_DEFAULT_API_KEY: secret });
    expect(redactor({ message: `token=${secret}` })).toEqual({ message: "token=[REDACTED]" });
  });

  it("scrubs Figma access tokens from env and local gateway config", () => {
    const envToken = "figd_env-redaction-token";
    const configToken = "figd_config-redaction-token";
    const config = parseGatewayConfig({
      providers: [
        {
          modelId: "example-chat-model",
          baseUrl: "https://models.example.invalid/openai/v1",
          apiKey: "fake-test-key",
          timeoutMs: 30000,
          maxRetries: 2,
          retryBaseDelayMs: 500,
        },
      ],
      circuitBreaker: { failureThreshold: 5, cooldownMs: 30000, halfOpenProbes: 2 },
      figma: { accessToken: configToken },
    });
    const redactor = buildRedactor({ FIGMA_ACCESS_TOKEN: envToken }, config);

    expect(redactor({ env: envToken, config: configToken })).toEqual({
      env: "[REDACTED]",
      config: "[REDACTED]",
    });
  });
});

describe("buildUiHandlerDeps — UiStore wiring (ADR-0013)", () => {
  it("uses the injected store unchanged when supplied", () => {
    const store = createInMemoryUiStore();
    const evidenceDir = tmp("ev-");
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir,
      env: {},
      store,
    });
    expect(deps.store).toBe(store);
  }, 15000);

  it("creates a node store at uiDbPath when no store is injected", () => {
    const uiDir = tmp("ui-");
    const evidenceDir = tmp("ev-");
    const dbPath = join(uiDir, "keiko-ui.db");
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir,
      env: {},
      uiDbPath: dbPath,
    });
    expect(deps.store).toBeDefined();
    expect(deps.store.listProjects()).toEqual([]);
    deps.store.close();
  });

  it("wires production Local Knowledge encryption for heading metadata and retrieval citations", async () => {
    const uiDir = tmp("ui-lk-");
    const evidenceDir = tmp("ev-lk-");
    const sourceDir = tmp("lk-src-");
    const uiDbPath = join(uiDir, "keiko-ui.db");
    const heading = "Server Heading ZGRZZY-SERVER-1322";
    const html = `<html><body><h1>${heading}</h1><p>retrieval needle for encrypted heading citations</p></body></html>`;
    writeFileSync(join(sourceDir, "guide.html"), html, "utf8");

    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir,
      env: { KEIKO_LOCAL_KNOWLEDGE_KEY: Buffer.alloc(32, 13).toString("base64") },
      uiDbPath,
    });
    const keyProvider = deps.localKnowledgeKeyProvider;
    expect(keyProvider).toBeDefined();
    if (keyProvider === undefined) throw new Error("expected Local Knowledge key provider");

    const knowledgeDbPath = resolveKnowledgeStorePath({ runtimeStateDir: uiDir });
    const knowledgeStore = openKnowledgeStore({
      dbPath: knowledgeDbPath,
      protection: { mode: "encrypted-key-provider", keyProvider },
    });
    try {
      const capsuleId = "cap-server-lk" as KnowledgeCapsuleId;
      const sourceId = "src-server-lk" as KnowledgeSourceId;
      const identity = {
        provider: "openai",
        modelId: "text-embedding-3-small",
        vectorDimensions: 1536,
        vectorMetric: "cosine",
      } as const;
      createCapsule(knowledgeStore, {
        id: capsuleId,
        displayName: "Server encrypted Local Knowledge",
        tags: [],
        retrievalEffort: "default",
        outputMode: "answers",
        answerGroundingPolicy: "require-citations",
        embeddingModelIdentity: identity,
        lifecycleState: "draft",
        storageReference: "server/local-knowledge",
      });
      addSourceToCapsule(knowledgeStore, capsuleId, {
        id: sourceId,
        displayName: "HTML guide",
        tags: [],
        scope: { kind: "folder", rootPath: sourceDir, recursive: true },
      });
      const adapter = localKnowledgeAdapter(identity.vectorDimensions);
      const events = await drain(
        runIndexingJob({
          capsuleId,
          parserRegistry: createDefaultParserRegistry(),
          workspaceFs: realWorkspaceFs(),
          embeddingAdapter: adapter,
          store: knowledgeStore,
          chunkingOptions: { maxTokens: 48, minTokens: 0, overlapTokens: 0 },
        }),
      );
      expect(events.some((event) => event.kind === "job-completed")).toBe(true);

      const outcome = await searchVectorsForScope(
        knowledgeStore,
        adapter,
        { capsuleIds: [capsuleId] },
        "encrypted heading citations",
        { topK: 3 },
      );
      expect(outcome.references.some((ref) => ref.citation.sectionPath?.[0] === heading)).toBe(
        true,
      );
    } finally {
      knowledgeStore.close();
      deps.store.close();
      deps.memoryVault?.close();
    }

    const bytes = readAllStoreBytes(knowledgeDbPath);
    expect(bytes.includes(Buffer.from(heading, "utf8"))).toBe(false);
    const raw = new DatabaseSync(knowledgeDbPath);
    try {
      const row = raw
        .prepare("SELECT heading_path_json FROM parsed_units WHERE heading_path_json IS NOT NULL")
        .get() as { readonly heading_path_json: string };
      expect(row.heading_path_json.startsWith("kv1.")).toBe(true);
    } finally {
      raw.close();
    }
  });

  it("seeds the launch project into the UI store as the preferred project", () => {
    const projectDir = tmp("launch-project-");
    const evidenceDir = tmp("ev-launch-");
    const dbPath = join(projectDir, ".keiko", "ui", "keiko-ui.db");
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir,
      env: {},
      uiDbPath: dbPath,
      initialProjectPath: projectDir,
    });

    expect(deps.preferredProjectPath).toBe(projectDir);
    expect(deps.store.listProjects().map((project) => project.path)).toEqual([projectDir]);
    deps.store.close();
    deps.memoryVault?.close();
  });

  it("resolves the DB path via KEIKO_UI_DATA_DIR when no explicit path is supplied", () => {
    const uiDir = tmp("ui-env-");
    const evidenceDir = tmp("ev-");
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir,
      env: { KEIKO_UI_DATA_DIR: uiDir },
    });
    expect(deps.store).toBeDefined();
    expect(deps.store.listProjects()).toEqual([]);
    deps.store.close();
  });

  it("passes the injected env to the memory vault path resolver", () => {
    const memoryDir = tmp("mem-env-");
    const evidenceDir = tmp("ev-mem-env-");
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir,
      env: { KEIKO_MEMORY_DIR: memoryDir },
      store: createInMemoryUiStore(),
    });
    expect(existsSync(join(memoryDir, "keiko-memory.db"))).toBe(true);
    expect(
      deps.memoryVault?.listMemoriesAcrossScopes(deps.memoryVault.listMemoryScopes(), {
        includeExpired: true,
      }),
    ).toEqual([]);
    deps.store.close();
    deps.memoryVault?.close();
  });
});

describe("buildUiHandlerDeps — Gateway env fallback", () => {
  it("builds a safe gateway config from KEIKO_MODEL_* env when the config file is missing", () => {
    const store = createInMemoryUiStore();
    const evidenceDir = tmp("ev-env-");
    const deps = buildUiHandlerDeps({
      configPath: join(evidenceDir, "missing-keiko.config.json"),
      evidenceDir,
      env: {
        KEIKO_MODEL_EXAMPLE_CHAT_MODEL_BASE_URL: "https://models.example.invalid/openai/v1",
        KEIKO_MODEL_EXAMPLE_CHAT_MODEL_API_KEY: "fake-test-key",
      },
      store,
    });

    expect(deps.configPresent).toBe(true);
    expect(deps.config?.providers.map((provider) => provider.modelId)).toEqual([
      "example-chat-model",
    ]);
    expect(deps.config?.providers[0]?.baseUrl).toBe("https://models.example.invalid/openai/v1");
    expect(deps.config?.providers[0]?.apiKey).toBe("fake-test-key");
    store.close();
  });

  it("applies KEIKO_MODEL_* custom API key headers in env-only mode", () => {
    const store = createInMemoryUiStore();
    const evidenceDir = tmp("ev-env-header-");
    const deps = buildUiHandlerDeps({
      configPath: join(evidenceDir, "missing-keiko.config.json"),
      evidenceDir,
      env: {
        KEIKO_MODEL_EXAMPLE_CHAT_MODEL_BASE_URL: "https://models.example.invalid/openai/v1",
        KEIKO_MODEL_EXAMPLE_CHAT_MODEL_API_KEY: "fake-test-key",
        KEIKO_MODEL_EXAMPLE_CHAT_MODEL_API_KEY_HEADER_NAME: "X-Litellm-Key",
      },
      store,
    });

    expect(deps.configPresent).toBe(true);
    expect(deps.config?.providers[0]?.apiKeyHeaderName).toBe("x-litellm-key");
    store.close();
  });

  it("does not publish every registry model from KEIKO_DEFAULT_* alone", () => {
    const store = createInMemoryUiStore();
    const evidenceDir = tmp("ev-env-default-only-");
    const deps = buildUiHandlerDeps({
      configPath: join(evidenceDir, "missing-keiko.config.json"),
      evidenceDir,
      env: {
        KEIKO_DEFAULT_BASE_URL: "https://models.example.invalid/openai/v1",
        KEIKO_DEFAULT_API_KEY: "fake-default-key",
      },
      store,
    });

    expect(deps.configPresent).toBe(false);
    expect(deps.config).toBeUndefined();
    store.close();
  });

  it("exposes env-only egress for Figma even when no model provider is configured", () => {
    const store = createInMemoryUiStore();
    const evidenceDir = tmp("ev-env-egress-only-");
    const deps = buildUiHandlerDeps({
      configPath: join(evidenceDir, "missing-keiko.config.json"),
      evidenceDir,
      env: {
        KEIKO_HTTP_PROXY: "http://proxy.example.invalid:8080",
        KEIKO_CA_BUNDLE_PATH: "/tmp/corp-root-ca.pem",
      },
      store,
    });

    expect(deps.configPresent).toBe(false);
    expect(deps.config).toBeUndefined();
    expect(currentGatewayEgressConfig(deps)).toEqual({
      httpProxy: "http://proxy.example.invalid:8080/",
      caBundlePath: "/tmp/corp-root-ca.pem",
    });
    expect(currentRedactionSecrets(deps)).toContain("http://proxy.example.invalid:8080/");
    expect(currentRedactionSecrets(deps)).toContain("/tmp/corp-root-ca.pem");
    store.close();
  });

  it("exposes config-file egress for Figma even when no model provider is configured", () => {
    const store = createInMemoryUiStore();
    const evidenceDir = tmp("ev-file-egress-only-");
    const configPath = join(evidenceDir, "keiko.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        egress: {
          httpsProxy: "http://proxy.config.invalid:8443",
          noProxy: "localhost,127.0.0.1",
          caBundlePath: "/etc/keiko/corp-root-ca.pem",
        },
      }),
      "utf8",
    );
    const deps = buildUiHandlerDeps({
      configPath,
      evidenceDir,
      env: {},
      store,
    });

    expect(deps.configPresent).toBe(false);
    expect(deps.config).toBeUndefined();
    expect(deps.egress).toEqual({
      httpsProxy: "http://proxy.config.invalid:8443/",
      noProxy: ["localhost", "127.0.0.1"],
      caBundlePath: "/etc/keiko/corp-root-ca.pem",
    });
    expect(currentGatewayEgressConfig(deps)).toEqual(deps.egress);
    expect(currentRedactionSecrets(deps)).toContain("http://proxy.config.invalid:8443/");
    expect(currentRedactionSecrets(deps)).toContain("/etc/keiko/corp-root-ca.pem");
    expect(
      deps.redactor({
        proxy: "http://proxy.config.invalid:8443/",
        ca: "/etc/keiko/corp-root-ca.pem",
      }),
    ).toEqual({ proxy: "[REDACTED]", ca: "[REDACTED]" });
    store.close();
  });

  it("includes Figma env tokens and migrates config tokens out of current redaction secrets", () => {
    const store = createInMemoryUiStore();
    const evidenceDir = tmp("ev-figma-redaction-");
    const configPath = join(evidenceDir, "keiko.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        providers: [
          {
            modelId: "example-chat-model",
            baseUrl: "https://models.example.invalid/openai/v1",
            apiKey: "fake-test-key",
            timeoutMs: 30000,
            maxRetries: 2,
            retryBaseDelayMs: 500,
          },
        ],
        circuitBreaker: { failureThreshold: 5, cooldownMs: 30000, halfOpenProbes: 2 },
        figma: { accessToken: "figd_config-redaction-token" },
      }),
      "utf8",
    );
    const deps = buildUiHandlerDeps({
      configPath,
      evidenceDir,
      env: { FIGMA_ACCESS_TOKEN: "figd_env-redaction-token" },
      store,
    });

    expect(currentRedactionSecrets(deps)).toContain("figd_env-redaction-token");
    expect(currentRedactionSecrets(deps)).not.toContain("figd_config-redaction-token");
    expect(readFileSync(configPath, "utf8")).not.toContain("figd_config-redaction-token");
    store.close();
  });
});

describe("buildUiHandlerDeps — H1 production redactor wired into UiStore", () => {
  it("redacts API-key-shaped env value from persisted shortResult (H1)", () => {
    // Build deps with a real env containing a synthetic API-key-shaped secret.
    // The secret MUST NOT appear verbatim in the on-disk DB after a message is persisted.
    const SECRET = ["sk-", "keiko-test-h1-NOT-A-REAL-SECRET"].join("");
    const uiDir = tmp("h1-");
    const evidenceDir = tmp("h1-ev-");
    const dbPath = join(uiDir, "keiko-ui.db");

    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir,
      env: { KEIKO_DEFAULT_API_KEY: SECRET },
      uiDbPath: dbPath,
    });

    // Create the minimum store entities to reach createMessage.
    const proj = deps.store.createProject(uiDir);
    const chat = deps.store.createChat(proj.path, "t", "m");
    deps.store.createMessage({
      chatId: chat.id,
      role: "system",
      content: "content",
      timestamp: Date.now(),
      runId: "run-redacted",
      workflowId: undefined,
      workflowStatus: "running",
      shortResult: `leak ${SECRET} tail`,
      taskType: "verify",
    });

    // shortResult returned by listMessages must not contain the literal secret.
    const messages = deps.store.listMessages(chat.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.shortResult).not.toContain(SECRET);
    expect(messages[0]?.shortResult).toContain("[REDACTED]");

    deps.store.close();

    // On-disk raw row must also not contain the literal secret.
    const db = new DatabaseSync(dbPath);
    const row = db.prepare("SELECT short_result FROM chat_messages LIMIT 1").get() as {
      short_result: string | null;
    };
    db.close();
    expect(row.short_result).not.toContain(SECRET);
    expect(row.short_result).toContain("[REDACTED]");
  });

  // Issue #66 — the PATCH route's updateMessage seam must hit the same production redactor as
  // createMessage. The bug we are guarding against (memory #62 H1) is shipping a default-identity
  // redactor through createNodeUiStore for updateMessage while createMessage uses the real one.
  // The test uses the REAL buildUiHandlerDeps (no injection) and reads the raw row off disk.
  it("redacts API-key-shaped env value through updateMessage (#66 PATCH H1)", () => {
    const SECRET = ["sk-", "keiko-test-h1-patch-NOT-A-REAL-SECRET"].join("");
    const uiDir = tmp("h1p-");
    const evidenceDir = tmp("h1p-ev-");
    const dbPath = join(uiDir, "keiko-ui.db");

    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir,
      env: { KEIKO_DEFAULT_API_KEY: SECRET },
      uiDbPath: dbPath,
    });

    const proj = deps.store.createProject(uiDir);
    const chat = deps.store.createChat(proj.path, "t", "m");
    const created = deps.store.createMessage({
      chatId: chat.id,
      role: "system",
      content: "running",
      timestamp: Date.now(),
      runId: "r-66",
      workflowId: undefined,
      workflowStatus: "running",
      shortResult: undefined,
      taskType: "verify",
    });

    deps.store.updateMessage(created.id, {
      workflowStatus: "completed",
      shortResult: `leak ${SECRET} tail`,
    });

    const reread = deps.store.listMessages(chat.id);
    expect(reread).toHaveLength(1);
    expect(reread[0]?.shortResult).not.toContain(SECRET);
    expect(reread[0]?.shortResult).toContain("[REDACTED]");
    expect(reread[0]?.workflowStatus).toBe("completed");

    deps.store.close();

    const db = new DatabaseSync(dbPath);
    const row = db
      .prepare("SELECT short_result FROM chat_messages WHERE id = ?")
      .get(created.id) as { short_result: string | null };
    db.close();
    expect(row.short_result).not.toContain(SECRET);
    expect(row.short_result).toContain("[REDACTED]");
  });
});

// ---------------------------------------------------------------------------
// currentGatewayEgressConfig — fail-open env parse fix (item 1)
// ---------------------------------------------------------------------------

describe("currentGatewayEgressConfig — fault-tolerant env egress parsing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a credentialed HTTPS_PROXY does not silently produce undefined egress — caBundlePath survives", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const store = createInMemoryUiStore();
    const evidenceDir = tmp("ev-egress-ft-");
    const deps = buildUiHandlerDeps({
      configPath: join(evidenceDir, "missing-keiko.config.json"),
      evidenceDir,
      env: {
        HTTPS_PROXY: "http://user:pass@corp-proxy.invalid:8080",
        KEIKO_CA_BUNDLE_PATH: "/etc/keiko/corp-ca.pem",
      },
      store,
    });
    const egress = currentGatewayEgressConfig(deps);
    // Bad HTTPS_PROXY must NOT cause caBundlePath to be silently dropped.
    expect(egress?.caBundlePath).toBe("/etc/keiko/corp-ca.pem");
    expect(egress?.httpsProxy).toBeUndefined();
    // A warning must have been logged naming the env var, never the value.
    expect(warn).toHaveBeenCalled();
    const warningText = (warn.mock.calls[0] as string[])[0] ?? "";
    expect(warningText).toContain("HTTPS_PROXY");
    expect(warningText).not.toContain("pass");
    store.close();
  });

  it("a malformed HTTP_PROXY does not discard a valid noProxy setting", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const store = createInMemoryUiStore();
    const evidenceDir = tmp("ev-egress-noproxy-");
    const deps = buildUiHandlerDeps({
      configPath: join(evidenceDir, "missing-keiko.config.json"),
      evidenceDir,
      env: {
        HTTP_PROXY: "ftp://invalid-scheme.invalid",
        NO_PROXY: "localhost,127.0.0.1",
      },
      store,
    });
    const egress = currentGatewayEgressConfig(deps);
    expect(egress?.httpProxy).toBeUndefined();
    expect(egress?.noProxy).toEqual(["localhost", "127.0.0.1"]);
    expect(warn).toHaveBeenCalled();
    store.close();
  });
});
