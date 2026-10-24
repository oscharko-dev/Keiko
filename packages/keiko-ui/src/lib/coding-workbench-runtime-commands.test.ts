import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchCodingWorkbenchRuntimeCommands,
  startCodingWorkbenchRuntime,
  submitCodingWorkbenchRuntimeFollowUp,
} from "./coding-workbench-runtime-api";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const SNAPSHOT = {
  schemaVersion: "1",
  state: "running",
  revision: 4,
  updatedAt: "2026-07-13T12:00:00.000Z",
  runId: "run-1",
} as const;

describe("slash command listing API", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads the run's commands over the authenticated channel and validates them", async () => {
    const commands = [
      { name: "init", description: "Set up AGENTS.md" },
      { name: "review" },
      { name: "team:deploy-check" },
    ];
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(jsonResponse({ session: "active", commands })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchCodingWorkbenchRuntimeCommands("run-1")).resolves.toEqual({
      session: "active",
      commands,
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/coding-workbench/runtime/runs/run-1/commands");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ cache: "no-store" });
    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty("method", "POST");
  });

  it("encodes the run id into the path and forwards the abort signal", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(jsonResponse({ session: "active" })));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    await fetchCodingWorkbenchRuntimeCommands("run/with space", { signal: controller.signal });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/coding-workbench/runtime/runs/run%2Fwith%20space/commands",
    );
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ["a run that offers none", { session: "active" }],
    ["an empty listing", { session: "active", commands: [] }],
    ["an unpaired window", { session: "unpaired" }],
  ])("accepts %s as the contract states it", async (_name, body) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(body))),
    );

    await expect(fetchCodingWorkbenchRuntimeCommands("run-1")).resolves.toEqual(body);
  });

  it.each([
    ["a command name that is not a name", { session: "active", commands: [{ name: "../etc" }] }],
    ["a name with whitespace", { session: "active", commands: [{ name: "re view" }] }],
    ["a repeated name", { session: "active", commands: [{ name: "init" }, { name: "init" }] }],
    [
      "a template smuggled into an entry",
      { session: "active", commands: [{ name: "init", template: "rm -rf" }] },
    ],
    [
      "a description beyond the bound",
      { session: "active", commands: [{ name: "init", description: "x".repeat(201) }] },
    ],
    ["commands on an unpaired answer", { session: "unpaired", commands: [{ name: "init" }] }],
    ["commands that are not a list", { session: "active", commands: { name: "init" } }],
    ["an unknown session facet", { session: "other" }],
    [
      "more commands than a listing may hold",
      {
        session: "active",
        commands: Array.from({ length: 65 }, (_unused, index) => ({ name: `c${String(index)}` })),
      },
    ],
  ])("rejects %s as a contract violation", async (_name, body) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(body))),
    );

    await expect(fetchCodingWorkbenchRuntimeCommands("run-1")).rejects.toMatchObject({
      code: "CONTRACT_VALIDATION_FAILED",
      status: 502,
    });
  });
});

describe("start and follow-up bodies that carry files and a command", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts the references and the command of a start as the wire contract shapes them", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(SNAPSHOT)));
    vi.stubGlobal("fetch", fetchMock);
    const body = {
      requestId: "request-1",
      taskIntent: "",
      requestedMode: "supervised-coding",
      runtimePreference: "managed-gateway",
      projectMemory: { enabled: true },
      references: [{ path: "src/app.ts" }],
      command: { name: "review" },
    } as const;

    await startCodingWorkbenchRuntime(body);

    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      "/api/coding-workbench/runtime/runs",
      expect.objectContaining({ method: "POST", body: JSON.stringify(body) }),
    );
  });

  it("posts the command of a follow-up with an empty text", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(SNAPSHOT)));
    vi.stubGlobal("fetch", fetchMock);
    const body = {
      requestId: "request-1",
      expectedRevision: 4,
      taskIntent: "",
      command: { name: "init" },
    } as const;

    await submitCodingWorkbenchRuntimeFollowUp("run-1", body);

    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      "/api/coding-workbench/runtime/runs/run-1/follow-up",
      expect.objectContaining({ method: "POST", body: JSON.stringify(body) }),
    );
  });
});
