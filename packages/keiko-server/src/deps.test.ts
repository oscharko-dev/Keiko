import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildRedactor,
  buildUiHandlerDeps,
  currentGatewayEgressConfig,
  currentRedactionSecrets,
} from "./deps.js";
import { createInMemoryUiStore } from "./store/index.js";
import { DatabaseSync } from "node:sqlite";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

describe("buildRedactor", () => {
  it("scrubs non-pattern secret values from sensitive environment variables", () => {
    const secret = ["CORPSECRET_", "123456789"].join("");
    const redactor = buildRedactor({ KEIKO_DEFAULT_API_KEY: secret });
    expect(redactor({ message: `token=${secret}` })).toEqual({ message: "token=[REDACTED]" });
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
  });

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
