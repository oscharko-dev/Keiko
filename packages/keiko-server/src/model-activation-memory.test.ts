import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelProviderConfig } from "@oscharko-dev/keiko-model-gateway";
import type { ServerLogEvent } from "@oscharko-dev/keiko-activity-log";
import {
  MODEL_ACTIVATION_FILE,
  createModelActivationMemory,
  activatedModelsOf,
  type ModelActivationMemory,
} from "./model-activation-memory.js";

// A write the disk refuses, injected at the private-JSON writer the memory saves through.
const writer = vi.hoisted(() => ({ failures: 0 }));
vi.mock("./private-json.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./private-json.js")>();
  return {
    ...actual,
    savePrivateJson: (...args: Parameters<typeof actual.savePrivateJson>): void => {
      if (writer.failures > 0) {
        writer.failures -= 1;
        throw new Error("disk refused the write");
      }
      actual.savePrivateJson(...args);
    },
  };
});

const SECRET = "sk-test-secret-value-0001";

function provider(overrides: Partial<ModelProviderConfig> = {}): ModelProviderConfig {
  return {
    modelId: "chat-a",
    baseUrl: "http://127.0.0.1:4000/v1",
    apiKey: SECRET,
    timeoutMs: 1000,
    maxRetries: 0,
    retryBaseDelayMs: 1,
    ...overrides,
  };
}

const ACTIVATED_AT = "2026-11-28T10:00:00.000Z";

describe("model activation memory (owner decision 2026-11-28)", () => {
  let dir: string;
  let events: ServerLogEvent[];

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "keiko-activation-")));
    events = [];
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function memory(
    overrides: { installationId?: string; productVersion?: string } = {},
  ): ModelActivationMemory {
    return createModelActivationMemory({
      path: join(dir, MODEL_ACTIVATION_FILE),
      installationId: overrides.installationId ?? "installation-1",
      productVersion: overrides.productVersion ?? "1.5.10",
      log: { write: (event): void => void events.push(event) },
    });
  }

  function activate(target: ModelActivationMemory, ...providers: ModelProviderConfig[]): void {
    target.sync(
      providers.map((entry) => ({ provider: entry, activatedAt: ACTIVATED_AT })),
      "invalidated",
      "corr-activate",
    );
  }

  function restoredIds(
    target: ModelActivationMemory,
    ...providers: ModelProviderConfig[]
  ): readonly string[] {
    return target.restore(providers, "corr-restore").map((entry) => entry.modelId);
  }

  function changeLines(): readonly Record<string, unknown>[] {
    return events
      .filter((event) => event.op === "gateway.activation.persistence")
      .map((event) => ({ ...event, ...(event.extra as Record<string, unknown>) }));
  }

  it("restores an activation after a restart when the whole binding still matches", () => {
    activate(memory(), provider());
    expect(restoredIds(memory(), provider())).toEqual(["chat-a"]);
    const restored = changeLines().find((line) => line.change === "restored");
    expect(restored).toMatchObject({ count: 1, correlationId: "corr-restore" });
  });

  it("keeps the activation time it stored", () => {
    activate(memory(), provider());
    expect(memory().restore([provider()], "corr-restore")[0]?.activatedAt).toBe(ACTIVATED_AT);
  });

  it("never writes the credential, endpoint or model id to the file or the log", () => {
    activate(memory(), provider());
    restoredIds(memory(), provider());
    const text = readFileSync(join(dir, MODEL_ACTIVATION_FILE), "utf8");
    const logged = JSON.stringify(events);
    for (const body of [text, logged]) {
      expect(body).not.toContain(SECRET);
      expect(body).not.toContain("127.0.0.1");
      // The model id is as private as the endpoint: only a salted digest of it is stored.
      expect(body).not.toContain("chat-a");
    }
  });

  it("discards every record when the product changed (update)", () => {
    activate(memory(), provider());
    expect(restoredIds(memory({ productVersion: "1.5.11" }), provider())).toEqual([]);
    expect(changeLines()).toContainEqual(
      expect.objectContaining({ change: "discarded", reason: "product-changed", count: 1 }),
    );
    // The discard is final: the old build's record does not come back after a downgrade.
    expect(restoredIds(memory({ productVersion: "1.5.10" }), provider())).toEqual([]);
  });

  it("discards the record when the endpoint changed", () => {
    activate(memory(), provider());
    const changed = provider({ baseUrl: "http://127.0.0.1:4001/v1" });
    expect(restoredIds(memory(), changed)).toEqual([]);
    expect(changeLines()).toContainEqual(
      expect.objectContaining({ change: "discarded", reason: "configuration-changed", count: 1 }),
    );
  });

  it("discards the record when the model left the configuration", () => {
    activate(memory(), provider());
    expect(restoredIds(memory(), provider({ modelId: "chat-b" }))).toEqual([]);
    expect(changeLines()).toContainEqual(
      expect.objectContaining({ reason: "configuration-changed" }),
    );
  });

  it("discards the record when the credential digest changed", () => {
    activate(memory(), provider());
    expect(restoredIds(memory(), provider({ apiKey: "sk-test-other-credential" }))).toEqual([]);
    expect(changeLines()).toContainEqual(
      expect.objectContaining({ change: "discarded", reason: "credential-changed", count: 1 }),
    );
  });

  it("restores only the models whose own binding matches", () => {
    activate(memory(), provider(), provider({ modelId: "chat-b" }));
    const restored = restoredIds(
      memory(),
      provider(),
      provider({ modelId: "chat-b", baseUrl: "http://127.0.0.1:9/v1" }),
    );
    expect(restored).toEqual(["chat-a"]);
  });

  it("treats a missing file as a first start", () => {
    expect(restoredIds(memory(), provider())).toEqual([]);
    expect(changeLines()).toContainEqual(
      expect.objectContaining({ change: "discarded", reason: "first-start", count: 0 }),
    );
  });

  it("names a record of another installation foreign, not a first start", () => {
    activate(memory(), provider());
    events.length = 0;
    expect(restoredIds(memory({ installationId: "installation-2" }), provider())).toEqual([]);
    const reasons = changeLines().map((line) => line.reason);
    expect(reasons).toContain("foreign-installation");
    expect(reasons).not.toContain("first-start");
  });

  it("names a malformed record unreadable, not a first start", () => {
    writeFileSync(join(dir, MODEL_ACTIVATION_FILE), "{not json", { mode: 0o600 });
    expect(restoredIds(memory(), provider())).toEqual([]);
    const reasons = changeLines().map((line) => line.reason);
    expect(reasons).toContain("unreadable");
    expect(reasons).not.toContain("first-start");
  });

  it("names a record of an unknown schema unreadable", () => {
    writeFileSync(join(dir, MODEL_ACTIVATION_FILE), JSON.stringify({ schemaVersion: 99 }), {
      mode: 0o600,
    });
    expect(restoredIds(memory(), provider())).toEqual([]);
    expect(changeLines().map((line) => line.reason)).toContain("unreadable");
  });

  it.skipIf(process.platform === "win32")(
    "names a record that is not owner-private unreadable and restores nothing from it",
    () => {
      activate(memory(), provider());
      chmodSync(join(dir, MODEL_ACTIVATION_FILE), 0o666);
      events.length = 0;
      expect(restoredIds(memory(), provider())).toEqual([]);
      expect(changeLines().map((line) => line.reason)).toContain("unreadable");
    },
  );

  it("removes the record on an explicit deactivation", () => {
    activate(memory(), provider());
    const running = memory();
    running.restore([provider()], "corr-restore");
    running.sync([], "deactivated", "corr-deactivate");
    expect(changeLines()).toContainEqual(
      expect.objectContaining({
        change: "discarded",
        reason: "deactivated",
        count: 1,
        correlationId: "corr-deactivate",
      }),
    );
    expect(restoredIds(memory(), provider())).toEqual([]);
  });

  it("removes the record when a failure invalidated the observation", () => {
    activate(memory(), provider());
    const running = memory();
    running.restore([provider()], "corr-restore");
    running.sync([], "invalidated", "corr-failure");
    expect(changeLines()).toContainEqual(
      expect.objectContaining({ reason: "invalidated", count: 1 }),
    );
    expect(restoredIds(memory(), provider())).toEqual([]);
  });

  describe("a write the disk refuses", () => {
    afterEach(() => {
      writer.failures = 0;
    });

    it("keeps a failed activation outstanding and writes it with the next sync", () => {
      const running = memory();
      writer.failures = 1;
      activate(running, provider());
      expect(running.recorded()).toBe(false);
      expect(existsSync(join(dir, MODEL_ACTIVATION_FILE))).toBe(false);
      // The same set again is not "nothing to persist": the durable record still lacks it.
      activate(running, provider());
      expect(running.recorded()).toBe(true);
      expect(restoredIds(memory(), provider())).toEqual(["chat-a"]);
    });

    it("never lets a deactivation whose write failed come back after a restart", () => {
      activate(memory(), provider());
      const running = memory();
      running.restore([provider()], "corr-restore");
      writer.failures = 1;
      running.sync([], "deactivated", "corr-deactivate");
      // The old record could not be rewritten, so it is withdrawn whole: unusable, never restored.
      expect(existsSync(join(dir, MODEL_ACTIVATION_FILE))).toBe(false);
      expect(running.recorded()).toBe(true);
      expect(changeLines()).toContainEqual(
        expect.objectContaining({ change: "discarded", reason: "deactivated", count: 1 }),
      );
      // The retry of the same inactive set neither fails nor resurrects the model.
      running.sync([], "deactivated", "corr-retry");
      expect(restoredIds(memory(), provider())).toEqual([]);
    });

    it("reports a removal that neither the write nor the withdrawal could record, then settles it", () => {
      activate(memory(), provider());
      const running = memory();
      running.restore([provider()], "corr-restore");
      // A directory where the record belongs refuses both the rewrite and the removal.
      const record = join(dir, MODEL_ACTIVATION_FILE);
      rmSync(record);
      mkdirSync(join(record, "blocker"), { recursive: true });
      running.sync([], "deactivated", "corr-deactivate");
      expect(running.recorded()).toBe(false);
      expect(running.settle("deactivated", "corr-retry-blocked")).toBe(false);
      rmSync(record, { recursive: true });
      expect(running.settle("deactivated", "corr-retry")).toBe(true);
      expect(running.recorded()).toBe(true);
      expect(restoredIds(memory(), provider())).toEqual([]);
    });
  });

  it("writes nothing when the activated set did not change", () => {
    const running = memory();
    activate(running, provider());
    const before = events.length;
    activate(running, provider());
    expect(events).toHaveLength(before);
  });

  it("does not create a file when nothing was ever activated", () => {
    memory().sync([], "invalidated", "corr-none");
    expect(existsSync(join(dir, MODEL_ACTIVATION_FILE))).toBe(false);
  });
});

describe("activatedModelsOf", () => {
  const observation = (
    ready: boolean | undefined,
    generation = 3,
  ): {
    modelId: string;
    generation: number;
    checkedAt: string;
    fields: { conversationReady?: boolean };
  } => ({
    modelId: "chat-a",
    generation,
    checkedAt: ACTIVATED_AT,
    fields: ready === undefined ? {} : { conversationReady: ready },
  });

  it("lists only current-generation, ready, still configured models", () => {
    const observations = new Map([
      ["chat-a", observation(true)],
      ["chat-b", { ...observation(true), modelId: "chat-b" }],
      ["chat-c", { ...observation(false), modelId: "chat-c" }],
      ["chat-d", { ...observation(true, 2), modelId: "chat-d" }],
    ]);
    const providers = ["chat-a", "chat-c", "chat-d"].map((modelId) => provider({ modelId }));
    expect(activatedModelsOf(observations, 3, providers).map((m) => m.provider.modelId)).toEqual([
      "chat-a",
    ]);
  });
});
