import { beforeEach, describe, expect, it, vi } from "vitest";
import { codingAppSessionPairingSettled } from "./coding-app-session-client";
import { bffFetchJson } from "./http";
import * as skills from "./markdown-skills-api";

vi.mock("./coding-app-session-client", () => ({ codingAppSessionPairingSettled: vi.fn() }));
vi.mock("./http", () => ({ bffFetchJson: vi.fn() }));

const reference = { id: "local/id", revision: 3, digest: "a".repeat(64) };
const upload = { fileName: "synthetic.md", contentBase64: "c3ludGhldGlj" };
beforeEach(() => vi.resetAllMocks());

describe("private skill client boundary", () => {
  it("waits for pairing before making an authenticated library request", async () => {
    let finish: ((paired: boolean) => void) | undefined;
    vi.mocked(codingAppSessionPairingSettled).mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    vi.mocked(bffFetchJson).mockResolvedValue({ skills: [reference] });
    const pending = skills.fetchMarkdownSkills();
    expect(bffFetchJson).not.toHaveBeenCalled();
    finish?.(true);
    expect(await pending).toEqual([reference]);
    expect(bffFetchJson).toHaveBeenCalledWith(
      "/api/skills",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("uses revision preconditions on replacement, deletion and selection, with encoded identifiers", async () => {
    vi.mocked(bffFetchJson).mockResolvedValue({ skill: reference });
    expect(await skills.saveMarkdownSkill(upload)).toEqual(reference);
    expect(bffFetchJson).toHaveBeenLastCalledWith(
      "/api/skills",
      expect.objectContaining({ method: "POST", body: JSON.stringify(upload) }),
    );
    await skills.saveMarkdownSkill(upload, reference);
    expect(bffFetchJson).toHaveBeenLastCalledWith(
      "/api/skills/local%2Fid",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ ...upload, expectedRevision: 3 }),
      }),
    );
    await skills.deleteMarkdownSkill(reference);
    expect(bffFetchJson).toHaveBeenLastCalledWith(
      "/api/skills/local%2Fid",
      expect.objectContaining({ method: "DELETE", body: JSON.stringify({ expectedRevision: 3 }) }),
    );
    await skills.changeMarkdownSkillSelection("chat/id", reference, 7);
    expect(bffFetchJson).toHaveBeenLastCalledWith(
      "/api/chats/chat%2Fid/skill",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ skill: reference, expectedRevision: 7 }),
      }),
    );
    await skills.changeMarkdownSkillSelection("chat/id", null, 8);
    expect(bffFetchJson).toHaveBeenLastCalledWith(
      "/api/chats/chat%2Fid/skill",
      expect.objectContaining({ body: JSON.stringify({ skill: null, expectedRevision: 8 }) }),
    );
  });

  it("reads and exports the requested immutable revision and preserves cancellation", async () => {
    vi.mocked(bffFetchJson).mockResolvedValue({ skill: reference });
    expect(await skills.readMarkdownSkill(reference)).toEqual(reference);
    expect(bffFetchJson).toHaveBeenLastCalledWith(
      "/api/skills/local%2Fid?revision=3",
      expect.any(Object),
    );
    await skills.exportMarkdownSkill(reference);
    expect(bffFetchJson).toHaveBeenLastCalledWith(
      "/api/skills/local%2Fid/export?revision=3",
      expect.any(Object),
    );
    await skills.fetchMarkdownSkillSelection("chat/id");
    expect(bffFetchJson).toHaveBeenLastCalledWith("/api/chats/chat%2Fid/skill", expect.any(Object));
    const controller = new AbortController();
    await skills.fetchMarkdownSkillSelection("chat/id", controller.signal);
    expect(bffFetchJson).toHaveBeenLastCalledWith("/api/chats/chat%2Fid/skill", {
      signal: controller.signal,
    });
  });

  it("transports exact UTF-8 bytes without trimming or normalizing the local document", async () => {
    const body = "\uFEFF# Review\r\nGrüße 😀\r\n";
    const file = new File([body], "review.md");
    Object.defineProperty(file, "arrayBuffer", {
      value: async () => new TextEncoder().encode(body).buffer,
    });
    const result = await skills.markdownSkillUpload(file);
    expect(result.fileName).toBe("review.md");
    expect(
      new TextDecoder("utf-8", { ignoreBOM: true }).decode(
        Uint8Array.from(atob(result.contentBase64), (char) => char.charCodeAt(0)),
      ),
    ).toBe(body);
    expect(bffFetchJson).not.toHaveBeenCalled();
  });
});
