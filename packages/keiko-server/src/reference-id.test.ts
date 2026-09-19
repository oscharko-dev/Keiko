import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { looksLikeSecretShape } from "@oscharko-dev/keiko-contracts/runtime/memory";

// The failing WebKit smoke run's chat id: its digits across the last hyphen are Luhn-valid.
const FLAGGED_ID = "1404206d-9ab6-4bca-8853-813867352087";
const CLEAN_ID = "0f7c2e9a-3b1d-4c5e-9a8b-7d6c5b4a3f2e";

const randomUUIDMock = vi.hoisted(() => vi.fn<() => string>());

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  randomUUIDMock.mockImplementation(() => actual.randomUUID());
  return { ...actual, randomUUID: randomUUIDMock };
});

const { newReferenceId } = await import("./reference-id.js");
const { createInMemoryUiStore } = await import("./store/index.js");

function draws(...ids: string[]): () => string {
  const queue = [...ids];
  return (): string => queue.shift() ?? CLEAN_ID;
}

describe("newReferenceId (#3557 review)", () => {
  it("pins the fixture: the flagged id trips the shared heuristic and the clean one does not", () => {
    expect(looksLikeSecretShape(FLAGGED_ID)).toBe(true);
    expect(looksLikeSecretShape(CLEAN_ID)).toBe(false);
  });

  it("draws again when the heuristic flags an id", () => {
    expect(newReferenceId("", draws(FLAGGED_ID, CLEAN_ID))).toBe(CLEAN_ID);
  });

  it("checks the id with its prefix", () => {
    expect(newReferenceId("fs-", draws(FLAGGED_ID, CLEAN_ID))).toBe(`fs-${CLEAN_ID}`);
  });

  it("fails loudly when the random source keeps producing flagged ids", () => {
    expect(() => newReferenceId("", () => FLAGGED_ID)).toThrow(
      "No reference id outside the secret-shape heuristic was drawn.",
    );
  });

  it("never returns an id the heuristic flags from the real random source", () => {
    for (let index = 0; index < 2_000; index += 1) {
      const id = newReferenceId();
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
      expect(looksLikeSecretShape(id)).toBe(false);
    }
  });
});

// The browser persists a chat id as its window's reference, so the store must never issue one the
// persistence heuristic redacts.
describe("UI store chat ids", () => {
  let tmp: string | undefined;

  afterEach(() => {
    if (tmp !== undefined) rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  it("issues a chat id the heuristic never flags, even when the first draw is flagged", () => {
    tmp = mkdtempSync(join(tmpdir(), "keiko-reference-id-"));
    const project = join(tmp, "p");
    mkdirSync(project);
    const store = createInMemoryUiStore({ now: () => 1 });
    try {
      store.createProject(project);
      randomUUIDMock.mockReturnValueOnce(FLAGGED_ID).mockReturnValueOnce(CLEAN_ID);

      const chat = store.createChat(project, "Deploy status", "example-chat-model");

      expect(chat.id).toBe(CLEAN_ID);
    } finally {
      store.close();
    }
  });
});
