// The lab's view of an instance: how it reads the store and the capture ledger past the first page,
// how it knows a model call has ended, and which environments it refuses to measure in. Nothing here
// forks the product; the routes are mocked and the Activity Log is a fixture file.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  callKey,
  isCallCompleted,
  isCallFailed,
  isCallStart,
  openCallKeys,
} from "../testing/memory-lab/gateway-calls.mjs";
import {
  awaitLearning,
  captureTotal,
  listMemories,
  pendingGatewayCalls,
  readCaptures,
  startLabInstance,
} from "../testing/memory-lab/instance.mjs";
import { LabConfigurationError } from "../testing/memory-lab/isolation.mjs";

const PAGE = 200;

function memoryRows(count) {
  return Array.from({ length: count }, (_, index) => ({ id: `m-${String(index)}` }));
}

// The list route: newest first, `limit` and `offset`, and the total beside the page. `afterRequest`
// runs once the response is built, so a change it makes shows from the next request on.
function listRoute(rows, { afterRequest } = {}) {
  const requests = [];
  return {
    requests,
    request: async (_method, path) => {
      requests.push(path);
      const url = new URL(path, "http://127.0.0.1");
      const limit = Number(url.searchParams.get("limit"));
      const offset = Number(url.searchParams.get("offset") ?? "0");
      const json = {
        memories: rows.slice(offset, offset + limit),
        total: rows.length,
        limit,
        offset,
      };
      afterRequest?.(requests.length);
      return { status: 200, json };
    },
  };
}

describe("memory lab store reading", () => {
  it("reads a store of more than one page completely", async () => {
    const rows = memoryRows(PAGE * 2 + 37);
    const route = listRoute(rows);
    const memories = await listMemories(route);
    expect(memories).toHaveLength(rows.length);
    expect(memories.map((memory) => memory.id)).toEqual(rows.map((row) => row.id));
    expect(route.requests).toEqual([
      "/api/memory?limit=200&offset=0",
      "/api/memory?limit=200&offset=200",
      "/api/memory?limit=200&offset=400",
    ]);
  });

  it("asks once for a store that fits one page and for an empty store", async () => {
    const small = listRoute(memoryRows(3));
    expect(await listMemories(small)).toHaveLength(3);
    expect(small.requests).toHaveLength(1);
    expect(await listMemories(listRoute([]))).toEqual([]);
  });

  it("fails when the total changes between pages", async () => {
    const rows = memoryRows(PAGE + 5);
    const route = listRoute(rows, {
      afterRequest: (count) => {
        if (count === 1) rows.push({ id: "late" });
      },
    });
    await expect(listMemories(route)).rejects.toThrow(/changed while it was read/u);
  });

  it("fails when a page is empty before the total is reached", async () => {
    const stalled = {
      request: async (_method, path) => ({
        status: 200,
        json: {
          memories: path.includes("offset=0") ? memoryRows(PAGE) : [],
          total: PAGE + 10,
        },
      }),
    };
    await expect(listMemories(stalled)).rejects.toThrow(/paging stalled at 200 of 210/u);
  });

  it("fails on a response without a usable total instead of reading it as complete", async () => {
    const noTotal = { request: async () => ({ status: 200, json: { memories: memoryRows(2) } }) };
    await expect(listMemories(noTotal)).rejects.toThrow(/carries no usable total/u);
  });
});

function decision(index, occurredAt = 1000 + index) {
  return { eventId: `e-${String(index)}`, occurredAt, outcome: "captured" };
}

// The ledger route: ascending, `since` inclusive, no offset, a page of at most `limit` decisions
// and the count of every decision from `since` on.
function ledgerRoute(decisions, { afterRequest } = {}) {
  const requests = [];
  return {
    requests,
    request: async (_method, path) => {
      requests.push(path);
      const url = new URL(path, "http://127.0.0.1");
      const since = Number(url.searchParams.get("since"));
      const limit = Number(url.searchParams.get("limit"));
      const from = decisions.filter((entry) => entry.occurredAt >= since);
      const json = { captures: from.slice(0, limit), total: from.length };
      afterRequest?.(requests.length);
      return { status: 200, json };
    },
  };
}

describe("memory lab capture ledger reading", () => {
  it("pages through a ledger of more than 200 decisions by time and drops the repeats", async () => {
    const ledger = Array.from({ length: 450 }, (_, index) => decision(index));
    const route = ledgerRoute(ledger);
    const captures = await readCaptures(route);
    expect(captures.map((capture) => capture.eventId)).toEqual(
      ledger.map((entry) => entry.eventId),
    );
    expect(route.requests[0]).toBe("/api/memory?since=0&order=asc&limit=200");
    expect(route.requests.length).toBeGreaterThanOrEqual(3);
    // Each later page starts at the last decision of the page before it, which the route includes.
    expect(route.requests[1]).toBe("/api/memory?since=1199&order=asc&limit=200");
  });

  it("keeps decisions that share one millisecond across the page boundary", async () => {
    const ledger = [
      ...Array.from({ length: 199 }, (_, index) => decision(index, 5000 + index)),
      ...Array.from({ length: 4 }, (_, index) => decision(199 + index, 6000)),
    ];
    const captures = await readCaptures(ledgerRoute(ledger));
    expect(captures).toHaveLength(203);
    expect(new Set(captures.map((capture) => capture.eventId)).size).toBe(203);
  });

  it("reads an empty ledger and a short one in one request", async () => {
    expect(await readCaptures(ledgerRoute([]))).toEqual([]);
    const short = ledgerRoute([decision(0), decision(1)]);
    expect(await readCaptures(short)).toHaveLength(2);
    expect(short.requests).toHaveLength(1);
  });

  it("fails when the ledger grows between pages", async () => {
    const ledger = Array.from({ length: 300 }, (_, index) => decision(index));
    const route = ledgerRoute(ledger, {
      afterRequest: (count) => {
        if (count === 1) ledger.push(decision(300));
      },
    });
    await expect(readCaptures(route)).rejects.toThrow(/ledger changed while it was read/u);
  });

  it("fails when more than a page of decisions share one millisecond, so paging cannot advance", async () => {
    const ledger = Array.from({ length: 250 }, (_, index) => decision(index, 7000));
    await expect(readCaptures(ledgerRoute(ledger))).rejects.toThrow(/paging stalled/u);
  });

  it("fails on a row without an event id and on a response without a total", async () => {
    const anonymous = {
      request: async () => ({ status: 200, json: { captures: [{ occurredAt: 1 }], total: 1 } }),
    };
    await expect(readCaptures(anonymous)).rejects.toThrow(/no event id/u);
    const noTotal = { request: async () => ({ status: 200, json: { captures: [] } }) };
    await expect(readCaptures(noTotal)).rejects.toThrow(/no usable total/u);
  });

  it("counts the ledger from its total, so the quiet detector sees past the first page", async () => {
    const route = ledgerRoute(Array.from({ length: 450 }, (_, index) => decision(index)));
    expect(await captureTotal(route)).toBe(450);
    expect(route.requests).toEqual(["/api/memory?since=0&order=asc&limit=1"]);
  });

  it("does not settle while captures keep arriving beyond the first page", async () => {
    // The old reader returned at most 200 rows, so the count stopped at 200 and looked quiet.
    let size = 250;
    const growing = {
      request: async () => {
        size += 1;
        return { status: 200, json: { captures: [], total: size } };
      },
    };
    await expect(
      awaitLearning(growing, { quietMs: 50, graceMs: 10, maxMs: 200, pendingLearner: () => 0 }),
    ).rejects.toThrow(/did not settle/u);
  });
});

describe("model calls in the Activity Log", () => {
  it("knows how a call starts and the three ways it ends", () => {
    expect(
      ["gateway.chat.started", "gateway.stream.started"].map((op) => isCallStart({ op })),
    ).toEqual([true, true]);
    expect(
      ["gateway.chat.completed", "gateway.stream.completed"].map((op) => isCallCompleted({ op })),
    ).toEqual([true, true]);
    expect(
      ["gateway.chat.failed", "gateway.stream.failed", "gateway.stream.abandoned"].map((op) =>
        isCallFailed({ op }),
      ),
    ).toEqual([true, true, true]);
    expect(isCallFailed({ op: "gateway.stream.buffered-fallback" })).toBe(false);
    expect(isCallStart({ op: "gateway.chat.completed" })).toBe(false);
  });

  it("identifies a call by its request id, else by its correlation", () => {
    expect(callKey({ requestId: "r", correlationId: "c" })).toBe("r");
    expect(callKey({ correlationId: "c" })).toBe("c");
    expect(callKey({})).toBeUndefined();
  });

  it("closes a call with any terminal line and keeps an unended one open", () => {
    const events = [
      { op: "gateway.chat.started", requestId: "a", correlationId: "turn" },
      { op: "gateway.chat.started", requestId: "b", correlationId: "turn" },
      { op: "gateway.chat.started", requestId: "c", correlationId: "turn" },
      { op: "gateway.stream.started", requestId: "d", correlationId: "turn" },
      { op: "gateway.stream.started", requestId: "e", correlationId: "turn" },
      { op: "gateway.chat.completed", requestId: "a", correlationId: "turn" },
      { op: "gateway.chat.failed", requestId: "b", correlationId: "turn" },
      { op: "gateway.stream.abandoned", requestId: "d", correlationId: "turn" },
    ];
    // Two calls of one correlation stay two calls: only the request ids tell them apart.
    expect([...openCallKeys(events)].toSorted()).toEqual(["c", "e"]);
    expect(openCallKeys([...events, { op: "gateway.stream.failed", requestId: "e" }]).size).toBe(1);
  });
});

const LOG_FILE = "activity-20261103T211455207Z-46397-6fa9c7a4-000001.jsonl";

describe("waiting for learning through the product's own log", () => {
  let directory;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "memory-lab-instance-log-"));
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  function writeLog(events) {
    writeFileSync(
      join(directory, LOG_FILE),
      `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    );
    return { logDirectory: directory };
  }

  function quietLedger(logDirectory) {
    return {
      logDirectory,
      request: async () => ({ status: 200, json: { captures: [], total: 0 } }),
    };
  }

  it("counts a started learner call as pending until a terminal line closes it", async () => {
    const started = { op: "gateway.chat.started", correlationId: "learn", requestId: "r1" };
    expect(await pendingGatewayCalls(writeLog([started]))).toBe(1);
    expect(
      await pendingGatewayCalls(
        writeLog([started, { op: "gateway.chat.failed", correlationId: "learn", requestId: "r1" }]),
      ),
    ).toBe(0);
    expect(
      await pendingGatewayCalls(
        writeLog([
          started,
          { op: "gateway.chat.completed", correlationId: "learn", requestId: "r1" },
        ]),
      ),
    ).toBe(0);
  });

  it("settles after a failed learner call instead of waiting until the limit", async () => {
    // The failure this pins: a failed call ends with gateway.chat.failed, which the wait did not
    // know as terminal, so the call stayed open and the wait ended in "did not settle in time".
    const instance = quietLedger(
      writeLog([
        { op: "gateway.chat.started", correlationId: "learn", requestId: "r1" },
        { op: "gateway.chat.failed", correlationId: "learn", requestId: "r1" },
        { op: "gateway.stream.started", correlationId: "learn2", requestId: "r2" },
        { op: "gateway.stream.abandoned", correlationId: "learn2", requestId: "r2" },
      ]).logDirectory,
    );
    const settled = await awaitLearning(instance, {
      quietMs: 20,
      maxMs: 3000,
      openCalls: () => pendingGatewayCalls(instance),
    });
    expect(settled.captures).toBe(0);
  });

  it("still waits for a call that has not ended", async () => {
    const instance = quietLedger(
      writeLog([{ op: "gateway.chat.started", correlationId: "learn", requestId: "r1" }])
        .logDirectory,
    );
    await expect(
      awaitLearning(instance, {
        quietMs: 10,
        maxMs: 200,
        openCalls: () => pendingGatewayCalls(instance),
      }),
    ).rejects.toThrow(/did not settle/u);
  });
});

describe("an environment the repository .env would change", () => {
  let subjectRoot;
  let dir;
  beforeEach(() => {
    subjectRoot = mkdtempSync(join(tmpdir(), "memory-lab-subject-"));
    dir = mkdtempSync(join(tmpdir(), "memory-lab-instance-"));
    writeFileSync(join(subjectRoot, ".env"), "KEIKO_MEMORY_MODE=autonomous-delivery\nOTHER=1\n");
    mkdirSync(join(dir, "project"), { recursive: true });
  });
  afterEach(() => {
    rmSync(subjectRoot, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  const fixture = { baseUrl: "http://127.0.0.1:9/v1" };

  it("is refused, naming the keys, unless the operator allows it", async () => {
    const refused = await startLabInstance({
      dir,
      fixture,
      ceiling: "autonomous-delivery",
      subjectRoot,
    }).catch((error) => error);
    expect(refused).toBeInstanceOf(LabConfigurationError);
    expect(refused.message).toContain("KEIKO_MEMORY_MODE");
    expect(refused.message).toContain("--allow-folded-env");
    expect(refused.message).not.toContain("OTHER");
  });

  it("is let through when allowed (and then fails later, on the checkout that has no runtime)", async () => {
    const error = await startLabInstance({
      dir,
      fixture,
      ceiling: "autonomous-delivery",
      subjectRoot,
      allowFoldedEnv: true,
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(LabConfigurationError);
  });
});
