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

// Counts the memory-hard derivations; `fake` swaps in a cheap stand-in for tests of volume.
const kdf = vi.hoisted(() => ({ calls: 0, fake: false }));
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    scryptSync: (...args: Parameters<typeof actual.scryptSync>): Buffer => {
      kdf.calls += 1;
      if (!kdf.fake) return actual.scryptSync(...args);
      const password = args[0] as string;
      const salt = args[1] as string;
      return actual.createHash("sha256").update(password).update(salt).digest();
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

  it("discards a record of the previous format whose credential was a plain hash", () => {
    activate(memory(), provider());
    const file = join(dir, MODEL_ACTIVATION_FILE);
    const stored = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    writeFileSync(file, JSON.stringify({ ...stored, schemaVersion: 1 }), { mode: 0o600 });
    expect(restoredIds(memory(), provider())).toEqual([]);
    // The reason is the exact, closed one: an older format is not an unreadable file.
    expect(changeLines()).toContainEqual(
      expect.objectContaining({ change: "discarded", reason: "format-changed", count: 1 }),
    );
    expect(changeLines().map((line) => line.reason)).not.toContain("unreadable");
  });

  it("derives a stable credential value that differs per installation and per key", () => {
    const valueOf = (installationId: string, apiKey: string): string => {
      const file = join(dir, `${installationId}-${apiKey}.json`);
      createModelActivationMemory({
        path: file,
        installationId,
        productVersion: "1.5.10",
        log: { write: (): void => undefined },
      }).sync([{ provider: provider({ apiKey }), activatedAt: ACTIVATED_AT }], "invalidated", "c");
      const stored = JSON.parse(readFileSync(file, "utf8")) as {
        entries: { credentialDigest: string }[];
      };
      return stored.entries[0]?.credentialDigest ?? "";
    };
    const base = valueOf("installation-1", "sk-1234");
    expect(base).toMatch(/^[a-f0-9]{64}$/u);
    expect(valueOf("installation-1", "sk-1234")).toBe(base);
    expect(valueOf("installation-2", "sk-1234")).not.toBe(base);
    expect(valueOf("installation-1", "sk-12345")).not.toBe(base);
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
    // The discarded count is the number of entries the record held, not an unknown 0.
    expect(changeLines()).toContainEqual(
      expect.objectContaining({ change: "discarded", reason: "foreign-installation", count: 1 }),
    );
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

    it("writes the models that stay activated right after withdrawing the record", () => {
      const second = provider({ modelId: "chat-b" });
      activate(memory(), provider(), second);
      const running = memory();
      running.restore([provider(), second], "corr-restore");
      writer.failures = 1;
      running.sync([{ provider: second, activatedAt: ACTIVATED_AT }], "deactivated", "corr-deact");
      expect(running.recorded()).toBe(true);
      // The withdrawn record is rewritten with the remaining model at once, not at the next change.
      expect(restoredIds(memory(), provider(), second)).toEqual(["chat-b"]);
    });

    it("retries a removal of a withheld sync through settle", () => {
      const second = provider({ modelId: "chat-b" });
      activate(memory(), provider(), second);
      const running = memory();
      running.restore([provider(), second], "corr-restore");
      // A directory where the record belongs refuses the rewrite and the withdrawal alike.
      const record = join(dir, MODEL_ACTIVATION_FILE);
      rmSync(record);
      mkdirSync(join(record, "blocker"), { recursive: true });
      running.sync(
        [{ provider: second, activatedAt: ACTIVATED_AT }],
        "invalidated",
        "corr-failed-change",
        undefined,
        "withheld",
      );
      expect(running.recorded()).toBe(false);
      rmSync(record, { recursive: true });
      // The settle replays what the failed change left, not the models it had removed.
      expect(running.settle("invalidated", "corr-settle")).toBe(true);
      expect(restoredIds(memory(), provider(), second)).toEqual(["chat-b"]);
    });

    it("keeps a live model whose binding changed inside a failed change", () => {
      const running = memory();
      activate(running, provider());
      events.length = 0;
      const rotated = provider({ apiKey: "sk-test-rotated-in-failed-change" });
      running.sync(
        [{ provider: rotated, activatedAt: ACTIVATED_AT }],
        "invalidated",
        "corr-failed-change",
        undefined,
        "withheld",
      );
      expect(changeLines().filter((line) => line.change === "discarded")).toEqual([]);
      expect(running.recorded()).toBe(true);
    });

    it("keeps the bindings of restored models when the startup rewrite had to withdraw", () => {
      const keyed = (modelId: string): ModelProviderConfig =>
        provider({ modelId, apiKey: `sk-test-bound-${modelId}` });
      const models = [keyed("chat-a"), keyed("chat-b")];
      activate(memory(), ...models);
      writer.failures = 1;
      const running = memory();
      expect(restoredIds(running, ...models)).toEqual(["chat-a", "chat-b"]);
      events.length = 0;
      running.sync(
        models.map((entry) => ({ provider: entry, activatedAt: ACTIVATED_AT })),
        "invalidated",
        "corr-after",
      );
      expect(changeLines()).toEqual([]);
      expect(restoredIds(memory(), ...models)).toEqual(["chat-a", "chat-b"]);
    });

    it("keeps a changed binding outstanding after its write failed", () => {
      const running = memory();
      activate(running, provider());
      const rotated = provider({ apiKey: "sk-test-rotated-credential" });
      writer.failures = 1;
      activate(running, rotated);
      expect(running.recorded()).toBe(false);
      // The same set again is still a change: the file holds the old binding.
      activate(running, rotated);
      expect(running.recorded()).toBe(true);
      expect(restoredIds(memory(), rotated)).toEqual(["chat-a"]);
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

  it("keeps the restored activations when it settles before any sync", () => {
    const second = provider({ modelId: "chat-b" });
    activate(memory(), provider(), second);
    const running = memory();
    expect(restoredIds(running, provider(), second)).toEqual(["chat-a", "chat-b"]);
    expect(running.settle("deactivated", "corr-settle")).toBe(true);
    expect(restoredIds(memory(), provider(), second)).toEqual(["chat-a", "chat-b"]);
  });

  it("logs each removal under its own reason when one change removed models for different ones", () => {
    const second = provider({ modelId: "chat-b" });
    const running = memory();
    activate(running, provider(), second);
    events.length = 0;
    running.sync([], "configuration-changed", "corr-mixed", new Map([["chat-a", "deactivated"]]));
    const lines = changeLines().filter((line) => line.change === "discarded");
    expect(lines).toContainEqual(expect.objectContaining({ reason: "deactivated", count: 1 }));
    expect(lines).toContainEqual(
      expect.objectContaining({ reason: "configuration-changed", count: 1 }),
    );
  });

  describe("capacity", () => {
    const providersOf = (count: number): ModelProviderConfig[] =>
      Array.from({ length: count }, (_, index) => provider({ modelId: `chat-${String(index)}` }));

    it("round-trips exactly the bound it stores", () => {
      activate(memory(), ...providersOf(512));
      expect(restoredIds(memory(), ...providersOf(512))).toHaveLength(512);
      expect(changeLines().filter((line) => line.reason === "capacity")).toEqual([]);
    });

    it("reports what it cannot store instead of saving it and losing it at the restart", () => {
      activate(memory(), ...providersOf(513));
      expect(changeLines()).toContainEqual(
        expect.objectContaining({ change: "discarded", reason: "capacity", count: 1 }),
      );
      // What was reported saved is exactly what comes back.
      expect(restoredIds(memory(), ...providersOf(513))).toHaveLength(512);
    });
  });

  describe("a startup discard that could not be written", () => {
    afterEach(() => {
      writer.failures = 0;
    });

    it("withdraws the incompatible record so a downgrade cannot restore it", () => {
      activate(memory(), provider());
      writer.failures = 1;
      const upgraded = memory({ productVersion: "1.5.11" });
      expect(restoredIds(upgraded, provider())).toEqual([]);
      expect(upgraded.recorded()).toBe(true);
      expect(restoredIds(memory({ productVersion: "1.5.10" }), provider())).toEqual([]);
    });

    it("stays pending while neither the rewrite nor the withdrawal lands, then settles", () => {
      activate(memory(), provider());
      const record = join(dir, MODEL_ACTIVATION_FILE);
      const saved = readFileSync(record, "utf8");
      // A directory where the record belongs refuses the rewrite and the removal alike.
      rmSync(record);
      mkdirSync(join(record, "blocker"), { recursive: true });
      const upgraded = memory({ productVersion: "1.5.11" });
      expect(restoredIds(upgraded, provider())).toEqual([]);
      expect(upgraded.recorded()).toBe(false);
      expect(upgraded.settle("invalidated", "corr-blocked")).toBe(false);
      rmSync(record, { recursive: true });
      writeFileSync(record, saved, { mode: 0o600 });
      expect(upgraded.settle("invalidated", "corr-retry")).toBe(true);
      expect(restoredIds(memory({ productVersion: "1.5.10" }), provider())).toEqual([]);
    });
  });

  describe("an unchanged activated set", () => {
    afterEach(() => {
      kdf.fake = false;
    });

    it("derives no credential again, however many models are active", () => {
      kdf.fake = true;
      const providers = Array.from({ length: 300 }, (_, index) =>
        provider({ modelId: `chat-${String(index)}`, apiKey: `sk-test-key-${String(index)}` }),
      );
      const running = memory();
      activate(running, ...providers);
      const before = kdf.calls;
      activate(running, ...providers);
      activate(running, ...providers);
      expect(kdf.calls).toBe(before);
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
