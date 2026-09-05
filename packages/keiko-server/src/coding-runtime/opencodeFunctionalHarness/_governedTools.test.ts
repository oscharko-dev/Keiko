import { describe, expect, it, vi } from "vitest";
import { ScriptedGovernedTools } from "./_governedTools.js";
import { codingToolApprovalBindingDigest } from "../codingToolApprovalBridge.js";
import { projectOpenCodePermissionEvent } from "../opencodeProtocol.js";
import type { ScriptedToolPhase } from "./_governedTools.js";

const SESSION = "ses_functional0000000001";
const RUN = "run-3386";
const verification = {
  id: "call-1",
  name: "keiko_verification",
  args: { verifierId: "typecheck" },
};

function fixture(
  mode = "governed-assist",
  observePhase?: (event: ScriptedToolPhase) => void,
): {
  readonly tools: ScriptedGovernedTools;
  readonly fetch: ReturnType<typeof vi.fn<typeof globalThis.fetch>>;
  readonly broadcast: ReturnType<typeof vi.fn>;
} {
  const fetch = vi.fn<typeof globalThis.fetch>(() =>
    Promise.resolve(new Response('{"status":"completed"}')),
  );
  const broadcast = vi.fn();
  const tools = new ScriptedGovernedTools({
    env: {
      KEIKO_CODING_MODE: mode,
      KEIKO_CODING_RUN_ID: RUN,
      KEIKO_TOOL_FACADE_URL: "http://127.0.0.1:1/unused-fixture",
      KEIKO_TOOL_FACADE_CAPABILITY: "synthetic-fixture-capability",
    },
    sessionId: SESSION,
    broadcast,
    fetch,
    ...(observePhase === undefined ? {} : { observePhase }),
  });
  return { tools, fetch, broadcast };
}

async function pending(tools: ScriptedGovernedTools): Promise<string> {
  await vi.waitFor(() => {
    expect(tools.rows()).toHaveLength(1);
  });
  const id = tools.rows()[0]?.id;
  if (typeof id !== "string") throw new Error("Expected pending fixture permission");
  return id;
}

describe("scripted child executes the production generated approval shim", () => {
  it("reports bounded content-free call phases through the existing fixture observer", async () => {
    const phases: ScriptedToolPhase[] = [];
    const f = fixture("autonomous-delivery", (event) => phases.push(event));
    await f.tools.execute(verification, new AbortController().signal);
    expect(phases).toEqual(
      ["entered", "ipc-requested", "ipc-returned", "completed"].map((phase) => ({
        runId: RUN,
        tool: "keiko_verification",
        phase,
      })),
    );
    expect(JSON.stringify(phases)).not.toMatch(/typecheck|capability|127\.0\.0/u);
  });
  it("bounds pending requests and cleans up every waiting call", async () => {
    const f = fixture();
    const waiting = Array.from({ length: 8 }, (_, index) =>
      f.tools.execute(
        { ...verification, id: `bounded-${String(index)}` },
        new AbortController().signal,
      ),
    );
    const settled = Promise.allSettled(waiting);
    await vi.waitFor(() => {
      expect(f.tools.rows()).toHaveLength(8);
    });
    await expect(
      f.tools.execute({ ...verification, id: "overflow" }, new AbortController().signal),
    ).rejects.toThrow("functional-permission-unavailable");
    expect(f.tools.rows()).toHaveLength(8);
    expect(f.fetch).not.toHaveBeenCalled();
    f.tools.close();
    expect((await settled).every((result) => result.status === "rejected")).toBe(true);
    expect(f.tools.rows()).toEqual([]);
  });

  it("holds verification before the facade and forwards the exact production proof only after reply", async () => {
    const f = fixture();
    const result = f.tools.execute(verification, new AbortController().signal);
    const requestId = await pending(f.tools);
    expect(f.fetch).not.toHaveBeenCalled();
    const row = f.tools.rows()[0];
    expect(
      projectOpenCodePermissionEvent(
        { id: "evt_permission1", type: "permission.asked", properties: row },
        SESSION,
      ),
    ).toMatchObject({ actionKind: "verification-command" });
    expect(f.tools.reply(requestId, '{"reply":"once"}')).toBe(true);
    await expect(result).resolves.toBe('{"status":"completed"}');
    expect(f.fetch).toHaveBeenCalledOnce();
    const body = f.fetch.mock.calls[0]?.[1]?.body;
    if (typeof body !== "string") throw new Error("Expected serialized facade request");
    const request: unknown = JSON.parse(body);
    expect(request).toMatchObject({
      action: "verification",
      approvalProof: {
        approvalId: `${SESSION}:call-1`,
        approvalDigest: codingToolApprovalBindingDigest(RUN, {
          action: "verification",
          actionId: `${SESSION}:call-1`,
          idempotencyKey: `${SESSION}:call-1`,
          verifierId: "typecheck",
        }),
      },
    });
    expect(f.tools.rows()).toEqual([]);
    expect(f.tools.reply(requestId, '{"reply":"once"}')).toBe(false);
  });

  it("rejects malformed or widening replies and never calls the facade on explicit denial", async () => {
    const f = fixture();
    const result = f.tools.execute(verification, new AbortController().signal);
    const rejected = expect(result).rejects.toThrow("functional-permission-rejected");
    const requestId = await pending(f.tools);
    expect(f.tools.reply(requestId, '{"reply":"always"}')).toBe(false);
    expect(f.tools.reply(requestId, '{"reply":"once","token":"foreign"}')).toBe(false);
    expect(f.tools.reply(requestId, '{"reply":"reject"}')).toBe(true);
    await rejected;
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it.each(["abort", "close"])("settles pending permission on %s", async (kind) => {
    const f = fixture();
    const controller = new AbortController();
    const result = f.tools.execute(verification, controller.signal);
    const rejected = expect(result).rejects.toThrow("functional-permission-rejected");
    await pending(f.tools);
    if (kind === "abort") controller.abort();
    else f.tools.close();
    await rejected;
    expect(f.tools.rows()).toEqual([]);
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it.each(["supervised-coding", "autonomous-delivery"])(
    "preserves %s shim admission without adding an ask",
    async (mode) => {
      const f = fixture(mode);
      await expect(f.tools.execute(verification, new AbortController().signal)).resolves.toBe(
        '{"status":"completed"}',
      );
      expect(f.broadcast).not.toHaveBeenCalled();
      expect(f.fetch).toHaveBeenCalledOnce();
      expect(f.tools.rows()).toEqual([]);
    },
  );

  it("uses the same generated edit metadata and waits before any write", async () => {
    const f = fixture();
    const result = f.tools.execute(
      {
        id: "edit-1",
        name: "keiko_changeset_edit",
        args: {
          changeset: {
            patch: "--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-old\n+new\n",
            files: [{ file: "src/example.ts", expectedContentHash: "a".repeat(64) }],
          },
        },
      },
      new AbortController().signal,
    );
    const rejected = expect(result).rejects.toThrow("functional-permission-rejected");
    await pending(f.tools);
    expect(f.tools.rows()[0]).toMatchObject({
      metadata: { actionKind: "file-edit", fileCount: 1, addedLines: 1, deletedLines: 1 },
    });
    expect(f.fetch).not.toHaveBeenCalled();
    f.tools.close();
    await rejected;
  });
});
