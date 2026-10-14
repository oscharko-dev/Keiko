import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RouteContext } from "./routes.js";
import { API_ROUTES } from "./routes.js";
import { createInMemoryUiStore } from "./store/index.js";
import {
  handleListMarkdownSkills,
  handleReadMarkdownSkill,
  handleImportMarkdownSkill,
  handleReplaceMarkdownSkill,
  handleDeleteMarkdownSkill,
  handleExportMarkdownSkill,
} from "./markdown-skill-routes.js";
import { createCodingAppSessionChannel } from "./coding-app-session/sessionChannel.js";
import { createSessionRegistry } from "./coding-app-session/sessionRegistry.js";
import {
  createFakeSessionPairingPort,
  fakePairingRequestBody,
} from "./coding-app-session/_support.js";
import { APP_SESSION_COOKIE_NAME } from "./coding-app-session/sessionCookie.js";
import { createServerLogger, setServerLogger } from "./observability/index.js";
import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";
import type { UiStore } from "./store/types.js";

const BODY = "# Synthetic review\nList missing assumptions before suggesting tests.\n";
const UPLOAD = { fileName: "method.md", contentBase64: Buffer.from(BODY).toString("base64") };
const stores: UiStore[] = [];
type RouteDeps = Parameters<typeof handleListMarkdownSkills>[1];

function fixture(): { deps: RouteDeps; cookie: string } {
  const channel = createCodingAppSessionChannel({
    registry: createSessionRegistry(),
    pairingPort: createFakeSessionPairingPort(),
  });
  const paired = channel.pair(fakePairingRequestBody());
  if (!paired.paired) throw new Error("Pairing fixture failed");
  const store = createInMemoryUiStore();
  stores.push(store);
  return {
    deps: { store, codingAppSessionChannel: channel },
    cookie: `${APP_SESSION_COOKIE_NAME}=${paired.cookieToken}`,
  };
}

function context(cookie: string, body: unknown = {}, id = "", revision?: number): RouteContext {
  const req = new IncomingMessage(new Socket());
  req.headers.cookie = cookie;
  req.headers["content-type"] = "application/json";
  req.push(JSON.stringify(body));
  req.push(null);
  return {
    req,
    res: new ServerResponse(req),
    params: { id },
    url: new URL(
      `http://localhost/api/skills/${id}?${revision === undefined ? "" : `revision=${String(revision)}`}`,
    ),
    correlationId: "skills-test",
  };
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  resetServerLogger();
  vi.restoreAllMocks();
});

describe("private Markdown skill routes (#4023)", () => {
  it("refuses a mutation when the session is revoked while its body is being read", async () => {
    const { deps, cookie } = fixture();
    const pending = handleImportMarkdownSkill(context(cookie, UPLOAD), deps);
    deps.codingAppSessionChannel?.signOut(cookie.split("=")[1]);
    expect((await pending).status).toBe(404);
    expect(deps.store.markdownSkills.list()).toEqual([]);
  });
  it("mounts all six library operations in the actual dispatcher", () => {
    const handlers = [
      handleListMarkdownSkills,
      handleReadMarkdownSkill,
      handleImportMarkdownSkill,
      handleReplaceMarkdownSkill,
      handleDeleteMarkdownSkill,
      handleExportMarkdownSkill,
    ];
    for (const handler of handlers)
      expect(API_ROUTES.some((route) => route.handler === handler)).toBe(true);
  });

  it("refuses unpaired access before resolving any skill or reading a body", async () => {
    const { deps } = fixture();
    const read = vi.spyOn(deps.store.markdownSkills, "get");
    const list = vi.spyOn(deps.store.markdownSkills, "list");
    const create = vi.spyOn(deps.store.markdownSkills, "import");
    for (const handler of [
      handleListMarkdownSkills,
      handleReadMarkdownSkill,
      handleImportMarkdownSkill,
      handleReplaceMarkdownSkill,
      handleDeleteMarkdownSkill,
      handleExportMarkdownSkill,
    ]) {
      expect((await handler(context("", UPLOAD), deps)).status).toBe(404);
    }
    expect(read).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("imports, reads and explicitly exports a file without any project", async () => {
    const { deps, cookie } = fixture();
    expect((await handleImportMarkdownSkill(context(cookie, UPLOAD), deps)).status).toBe(201);
    const metadata = deps.store.markdownSkills.list()[0];
    if (metadata === undefined) throw new Error("Missing imported fixture");
    const read = await handleReadMarkdownSkill(context(cookie, {}, metadata.id, 1), deps);
    expect(read.body).toEqual({ skill: deps.store.markdownSkills.get(metadata.id, 1) });
    expect(
      (await handleExportMarkdownSkill(context(cookie, {}, metadata.id, 1), deps)).body,
    ).toEqual({ fileName: "skill.md", content: BODY });
    const listed = await handleListMarkdownSkills(context(cookie), deps);
    expect(listed.headers?.["Cache-Control"]).toBe("no-store");
    expect(JSON.stringify(listed.body)).not.toContain("missing assumptions");
  });

  it("rejects stale writes, malformed requests and missing revisions without losing data", async () => {
    const { deps, cookie } = fixture();
    const skill = deps.store.markdownSkills.import(UPLOAD);
    const replacement = {
      ...UPLOAD,
      contentBase64: Buffer.from("New instructions").toString("base64"),
      expectedRevision: 1,
    };
    expect(
      (await handleReplaceMarkdownSkill(context(cookie, replacement, skill.id), deps)).status,
    ).toBe(200);
    expect(
      (await handleReplaceMarkdownSkill(context(cookie, replacement, skill.id), deps)).status,
    ).toBe(409);
    expect((await handleDeleteMarkdownSkill(context(cookie, {}, skill.id), deps)).status).toBe(400);
    expect(
      (await handleImportMarkdownSkill(context(cookie, { fileName: "x.md" }), deps)).status,
    ).toBe(400);
    expect((await handleReadMarkdownSkill(context(cookie, {}, skill.id, 9), deps)).status).toBe(
      404,
    );
    expect(
      (await handleDeleteMarkdownSkill(context(cookie, { expectedRevision: 2 }, skill.id), deps))
        .status,
    ).toBe(204);
    expect((await handleReadMarkdownSkill(context(cookie, {}, skill.id, 1), deps)).status).toBe(
      404,
    );
  });

  it("records a body-free lifecycle through the production Activity Log", async () => {
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "debug" }));
    const { deps, cookie } = fixture();
    await handleImportMarkdownSkill(context(cookie, UPLOAD), deps);
    await handleImportMarkdownSkill(context("", UPLOAD), deps);
    const events = sink.events.filter((entry) => entry.op === "skills.library.operation");
    expect(events.map((entry) => entry.extra?.phase)).toEqual([
      "started",
      "completed",
      "started",
      "rejected",
    ]);
    for (const event of events) {
      const persisted = expectActivityLogProof(
        "skills.library.operation.lifecycle",
        formatActivityLogProofLine(event),
      );
      expect(persisted.correlationId).toBe("skills-test");
    }
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(BODY);
    expect(serialized).not.toContain(UPLOAD.contentBase64);
    expect(serialized).not.toContain(UPLOAD.fileName);
  });

  it("propagates unexpected storage faults for the server's correlated diagnostic boundary", async () => {
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "debug" }));
    const { deps, cookie } = fixture();
    vi.spyOn(deps.store.markdownSkills, "list").mockImplementation(() => {
      throw new Error("private storage detail");
    });
    await expect(handleListMarkdownSkills(context(cookie), deps)).rejects.toThrow(
      "private storage detail",
    );
    expect(
      sink.events.filter((event) => event.op === "skills.library.operation").at(-1)?.extra,
    ).toMatchObject({ phase: "failed", httpStatus: 500 });
    expect(JSON.stringify(sink.events)).not.toContain("private storage detail");
  });
});
