import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_LAB_CONNECTION } from "../testing/jira-chat-lab/lab-client.mjs";
import {
  projectAgileWitness,
  observedEffects,
  oneObservedEffect,
} from "../testing/jira-chat-lab/project-agile-oracles.mjs";
import {
  JourneyStepFailure,
  step,
  stepOutcome,
  readableSummary,
  readableResultFindings,
  visibleReceipt,
  visibleLink,
  issueRead,
} from "../testing/jira-chat-lab/browser-journey-step.mjs";

const lazyDriver = vi.hoisted(() => ({ loads: 0, send: vi.fn() }));
vi.mock("../testing/jira-chat-lab/browser-workflow-turn.mjs", () => {
  lazyDriver.loads += 1;
  return { sendBrowserTurn: lazyDriver.send };
});
afterEach(() => {
  vi.clearAllMocks();
});

const ORIGIN = "https://127.0.0.1:18443";
const PATH = "/rest/api/2/issue/10001";
const WIRE = { method: "PUT", path: PATH, admit: (body) => body?.value === 7 };
const REQUEST = { method: "PUT", url: ORIGIN + PATH, bodyJson: '{"value":7}' };
const ACK = { kind: "response", status: 204, bodyText: "", bodyBytes: 0, truncated: false };
const OPERATION = "jira.update";
const alias = (operation) => operation.replaceAll(/[.-]/gu, "_");
const pending = (operation, index = 0) => ({
  call: { name: alias(operation) },
  approval: {
    operation,
    approvalId: `approval-${index}`,
    actionDigest: "a".repeat(64),
    state: "pending",
  },
});
function resultTurn(operations = [OPERATION], decisions = 1, outcome = "succeeded") {
  return {
    clientTurnId: "turn-1",
    user: { id: "user-1", turnState: "completed" },
    decisions,
    answer: "Observed native result",
    exchanges: operations.map((operation) => ({
      call: { name: alias(operation) },
      result: { status: "completed", data: { outcome } },
    })),
  };
}
function card({
  title = "Update issue",
  text = "Update issue\nCompleted\nSYN-1",
  visible = true,
  headingVisible = true,
  raw = 0,
} = {}) {
  return {
    isVisible: async () => visible,
    innerText: async () => text,
    locator: (selector) => {
      if (selector === ":scope > strong")
        return { isVisible: async () => headingVisible, innerText: async () => title };
      if (selector === "pre:visible") return { count: async () => raw };
      throw new TypeError("Unexpected presentation selector");
    },
  };
}
function region(cards = [card()]) {
  return {
    locator: (selector) => {
      expect(selector).toContain(":has(> output)");
      return { count: async () => cards.length, nth: (index) => cards[index] };
    },
  };
}
function fixture(cards) {
  const witness = projectAgileWitness();
  const native = vi.fn(async () => ACK);
  const port = witness.decorate(() => native)({}, "correlation", { beforeDispatch: vi.fn() });
  const group = { results: [] };
  const snapshots = [];
  const receivers = [];
  const environment = {
    page: {},
    region: region(cards),
    context: { session: DEFAULT_LAB_CONNECTION },
    chat: { id: "chat-1" },
    group,
    witness,
    persist: function () {
      receivers.push(this);
      snapshots.push(structuredClone(group));
    },
  };
  return { environment, witness, native, port, group, snapshots, receivers };
}
function definition(f, extra = {}) {
  const proof = { status: "verified", independentlyRead: true };
  const selected = {
    id: "step-1",
    name: "step-1",
    prompt: "Perform this bounded action",
    operations: new Set([OPERATION]),
    wire: [WIRE],
    verify: vi.fn(async () => proof),
    ...extra,
  };
  f.environment.sendTurn = vi.fn(async (_page, _region, _context, _chat, _prompt, options) => {
    options.persist({ phase: "submitted", clientTurnId: "turn-1" });
    options.beforeDecision(pending(OPERATION));
    await f.port(REQUEST);
    return resultTurn();
  });
  return { selected, proof };
}

describe("shared per-request native write witness", () => {
  it("keeps the legacy synchronous dispatch, this-binding, lazy getters and refusal message", async () => {
    const witness = projectAgileWitness();
    const events = [];
    const specification = {
      get method() {
        events.push("method");
        return "PUT";
      },
      get path() {
        events.push("path");
        return PATH;
      },
      get admit() {
        events.push("admit");
        return function (body) {
          expect(this).toBe(specification);
          return body.value === 7;
        };
      },
    };
    witness.arm(specification);
    expect(events).toEqual([]);
    const native = vi.fn(async () => ACK);
    const port = witness.decorate(() => native)({}, "legacy");
    const first = port(REQUEST);
    expect(events).toEqual(["method", "path", "admit"]);
    expect(native).toHaveBeenCalledExactlyOnceWith(REQUEST);
    expect(witness.snapshot()).toMatchObject({ forwarded: 1, statuses: [] });
    await expect(first).resolves.toBe(ACK);
    expect(() => oneObservedEffect(witness.snapshot())).not.toThrow();
    await expect(port(REQUEST)).rejects.toThrow(
      "Lab blocked unexpected or repeated mutation; this journey cannot pass",
    );
  });

  it("preserves the legacy native origin assertion and JSON parse error before blocked counting", async () => {
    const witness = projectAgileWitness();
    witness.arm(WIRE);
    const native = vi.fn();
    const port = witness.decorate(() => native)({}, "legacy");
    await expect(port({ ...REQUEST, url: "https://elsewhere.invalid/path" })).rejects.toThrow(
      "Only the existing selected synthetic TLS frontend is observed",
    );
    await expect(port({ ...REQUEST, bodyJson: "{" })).rejects.toBeInstanceOf(SyntaxError);
    expect(witness.snapshot()).toEqual({ attempted: 1, forwarded: 0, statuses: [], blocked: 0 });
    expect(native).not.toHaveBeenCalled();
  });

  it("admits repeated identical specifications exactly N times, synchronously dispatching sync matches", async () => {
    const f = fixture();
    f.witness.arm([WIRE, WIRE]);
    const first = f.port(REQUEST);
    expect(f.native).toHaveBeenCalledOnce();
    expect(f.witness.snapshot().forwarded).toBe(1);
    await first;
    await f.port(REQUEST);
    expect(() => observedEffects(f.witness.snapshot(), [WIRE, WIRE])).not.toThrow();
    await expect(f.port(REQUEST)).rejects.toMatchObject({
      code: "wire-unexpected-write",
      stage: "wire",
    });
    expect(f.native).toHaveBeenCalledTimes(2);
  });

  it("requires zero mutations for a read while allowing native GET and JQL POST reads", async () => {
    const f = fixture();
    f.witness.arm([]);
    await f.port({ method: "GET", url: ORIGIN + PATH });
    await f.port({ method: "POST", url: ORIGIN + "/rest/api/2/search", bodyJson: "{}" });
    expect(() => observedEffects(f.witness.snapshot(), [])).not.toThrow();
    await expect(f.port(REQUEST)).rejects.toMatchObject({ code: "wire-unexpected-write" });
    expect(f.native).toHaveBeenCalledTimes(2);
  });

  it.each(["", "?adjustEstimate=auto", "?adjustEstimate=leave&extra=true"])(
    "rejects any query other than the exact configured worklog query: %s",
    async (query) => {
      const f = fixture();
      const path = PATH + "/worklog";
      f.witness.arm([{ method: "POST", path: path + "?adjustEstimate=leave", admit: () => true }]);
      await expect(
        f.port({ method: "POST", url: ORIGIN + path + query, bodyJson: "{}" }),
      ).rejects.toMatchObject({ code: "wire-unexpected-write" });
      expect(f.native).not.toHaveBeenCalled();
    },
  );

  it("admits only the exact pathname plus search without treating the query as an arbitrary suffix", async () => {
    const f = fixture();
    const path = PATH + "/worklog?adjustEstimate=leave";
    const specification = { method: "POST", path, admit: () => true };
    f.witness.arm([specification]);
    await expect(f.port({ method: "POST", url: ORIGIN + path, bodyJson: "{}" })).resolves.toBe(ACK);
    expect(() => observedEffects(f.witness.snapshot(), [specification])).not.toThrow();
  });

  it("resolves later identities and admission from fresh reads only immediately before their own forward", async () => {
    const f = fixture();
    const events = [];
    const read = vi.fn(async () => {
      events.push("read");
      return "42";
    });
    const second = {
      method: "DELETE",
      path: async () => {
        events.push("path");
        return `/rest/agile/1.0/sprint/${await read()}`;
      },
      admit: async (body) => {
        events.push("admit");
        return body === undefined && (await read()) === "42";
      },
    };
    f.native.mockImplementation(async () => {
      events.push("forward");
      return ACK;
    });
    f.witness.arm([WIRE, second]);
    expect(events).toEqual([]);
    await f.port(REQUEST);
    expect(events).toEqual(["forward"]);
    await f.port({ method: "DELETE", url: ORIGIN + "/rest/agile/1.0/sprint/42" });
    expect(events).toEqual(["forward", "path", "read", "admit", "read", "forward"]);
    expect(() => observedEffects(f.witness.snapshot(), [WIRE, second])).not.toThrow();
  });

  it("rejects out-of-order native requests before resolving the next specification", async () => {
    const f = fixture();
    const laterPath = vi.fn(async () => PATH + "/later");
    f.witness.arm([WIRE, { method: "DELETE", path: laterPath, admit: () => true }]);
    await expect(
      f.port({ method: "DELETE", url: ORIGIN + PATH + "/later" }),
    ).rejects.toBeInstanceOf(JourneyStepFailure);
    expect(laterPath).not.toHaveBeenCalled();
    expect(f.native).not.toHaveBeenCalled();
  });

  it.each([WIRE, [WIRE]])(
    "keeps a late acknowledgement in the originally armed state %#",
    async (specification) => {
      const f = fixture();
      let settle;
      f.native.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            settle = resolve;
          }),
      );
      f.witness.arm(specification);
      const old = f.port(REQUEST);
      expect(f.witness.snapshot().forwarded).toBe(1);
      f.witness.arm([]);
      settle(ACK);
      await old;
      expect(f.witness.snapshot()).toEqual({
        attempted: 0,
        forwarded: 0,
        statuses: [],
        blocked: 0,
      });
    },
  );

  it("requires an actual acknowledgement and exact expected native refusal status", async () => {
    const f = fixture();
    const denial = { ...WIRE, status: 403 };
    f.native.mockResolvedValueOnce({ ...ACK, status: 403 });
    f.witness.arm([denial]);
    await f.port(REQUEST);
    expect(() => observedEffects(f.witness.snapshot(), [denial])).not.toThrow();
    expect(() => observedEffects(f.witness.snapshot(), [WIRE])).toThrow(JourneyStepFailure);
    f.native.mockResolvedValueOnce({ kind: "network-error" });
    f.witness.arm([WIRE]);
    await f.port(REQUEST);
    expect(() => observedEffects(f.witness.snapshot(), [WIRE])).toThrow(JourneyStepFailure);
  });

  it("does not expose a resolver's raw failure in closed role evidence", async () => {
    const f = fixture();
    f.witness.arm([
      {
        ...WIRE,
        path: async () => {
          throw new Error("private-test-value");
        },
      },
    ]);
    const failure = await f.port(REQUEST).catch((error) => error);
    expect(failure).toMatchObject({ code: "wire-unexpected-write", stage: "wire" });
    expect(failure.message).not.toContain("private-test-value");
    expect(failure.cause).toBeUndefined();
    expect(f.native).not.toHaveBeenCalled();
  });
});

describe("shared Journey step without a browser or Keiko", () => {
  it("uses an injected sender without loading the real driver and retains legacy evidence and persistence", async () => {
    const f = fixture();
    const { selected, proof } = definition(f, { operation: OPERATION, wire: WIRE });
    const verificationReceivers = [];
    selected.verify = function () {
      verificationReceivers.push(this);
      return Promise.resolve(proof);
    };
    await expect(step(f.environment, selected)).resolves.toBe(proof);
    expect(lazyDriver.loads).toBe(0);
    expect(f.group.results).toEqual([
      {
        name: "step-1",
        clientTurnId: "turn-1",
        userId: "user-1",
        approvals: 1,
        wire: { attempted: 1, forwarded: 1, statuses: [204], blocked: 0 },
        proof,
      },
    ]);
    expect(f.snapshots.map((item) => [item.current.phase, item.results.length])).toEqual([
      ["prepared", 0],
      ["submitted", 0],
      ["independently-observed", 1],
    ]);
    expect(f.receivers.every((value) => value === undefined)).toBe(true);
    expect(verificationReceivers).toEqual([selected]);
  });

  it.each([0, 1])(
    "retains the original denied Journey's <=1 native refusal allowance (%s writes)",
    async (writes) => {
      const f = fixture();
      const { selected } = definition(f, { operation: OPERATION, wire: WIRE, denied: true });
      f.native.mockResolvedValue({ ...ACK, status: 403 });
      f.environment.sendTurn = async (...args) => {
        const options = args[5];
        if (writes) {
          options.beforeDecision();
          await f.port(REQUEST);
        }
        return resultTurn([], writes);
      };
      await expect(step(f.environment, selected)).resolves.toMatchObject({ status: "verified" });
      expect(f.group.results[0].approvals).toBe(writes);
    },
  );

  it("retains original legacy verification failures instead of changing their error or message", async () => {
    const f = fixture();
    const { selected } = definition(f, { operation: OPERATION, wire: WIRE });
    const failure = new Error("Original independent assertion");
    selected.verify = () => {
      throw failure;
    };
    await expect(step(f.environment, selected)).rejects.toBe(failure);
    expect(f.group.results).toEqual([]);
  });

  it("supports ordered N decisions from an allowed operation Set and the explicit group API", async () => {
    const f = fixture();
    const other = "jira.sprint-delete";
    const second = { method: "DELETE", path: "/rest/agile/1.0/sprint/42", admit: () => true };
    const { selected, proof } = definition(f, {
      operations: new Set([OPERATION, other]),
      wire: [WIRE, second],
      readable: true,
    });
    f.environment.sendTurn = async (...args) => {
      const options = args[5];
      expect(options.operations).toEqual([OPERATION, other]);
      options.beforeDecision(pending(OPERATION));
      await f.port(REQUEST);
      options.beforeDecision(pending(other, 1));
      await f.port({ method: "DELETE", url: ORIGIN + second.path });
      return resultTurn([OPERATION, other], 2);
    };
    const group = { results: [] };
    await expect(step(f.environment, group, selected)).resolves.toBe(proof);
    expect(f.group.results).toEqual([]);
    expect(group.results[0]).toMatchObject({ approvals: 2, presentationFindings: 0 });
  });

  it("allows no-card reads with zero writes and a completed selected read without a write outcome", async () => {
    const f = fixture([]);
    const { selected } = definition(f, { operations: ["jira.search"], wire: [], readable: true });
    f.environment.sendTurn = async () => {
      await f.port({ method: "GET", url: ORIGIN + "/rest/api/2/search" });
      const turn = resultTurn(["jira.search"], 0);
      delete turn.exchanges[0].result.data.outcome;
      return turn;
    };
    await expect(step(f.environment, selected)).resolves.toMatchObject({ status: "verified" });
    expect(f.group.results[0].wire).toEqual({
      attempted: 0,
      forwarded: 0,
      statuses: [],
      blocked: 0,
    });
  });

  it("requires one actual DELETE403 and one decision for the explicit native-denial definition", async () => {
    const f = fixture();
    const spec = {
      method: "DELETE",
      path: "/rest/agile/1.0/sprint/42",
      admit: () => true,
      status: 403,
    };
    const { selected } = definition(f, {
      operations: ["jira.sprint-delete"],
      wire: [spec],
      denied: true,
      readable: true,
      verify: async () => ({ status: "denied", independentlyUnchanged: true }),
    });
    f.native.mockResolvedValue({ ...ACK, status: 403 });
    f.environment.sendTurn = async (...args) => {
      args[5].beforeDecision(pending("jira.sprint-delete"));
      await f.port({ method: "DELETE", url: ORIGIN + spec.path });
      const turn = resultTurn(["jira.sprint-delete"], 1, "rejected");
      turn.exchanges[0].result.data.reason = "permission-denied";
      return turn;
    };
    await expect(step(f.environment, selected)).resolves.toMatchObject({ status: "denied" });
    expect(f.group.results[0]).toMatchObject({ approvals: 1, wire: { statuses: [403] } });
  });

  it("rejects an approval outside the declared operation set before forwarding", async () => {
    const f = fixture();
    const { selected } = definition(f);
    f.environment.sendTurn = async (...args) => {
      args[5].beforeDecision(pending("jira.sprint-delete"));
      return resultTurn();
    };
    await expect(step(f.environment, selected)).rejects.toMatchObject({
      code: "operation-not-allowed",
      stage: "approval",
    });
    expect(f.native).not.toHaveBeenCalled();
    expect(f.group.results).toEqual([]);
  });

  it("rejects a second approval before its preceding decision was forwarded", async () => {
    const f = fixture();
    const { selected } = definition(f, { wire: [WIRE, WIRE] });
    f.environment.sendTurn = async (...args) => {
      args[5].beforeDecision(pending(OPERATION));
      args[5].beforeDecision(pending(OPERATION, 1));
      return resultTurn();
    };
    await expect(step(f.environment, selected)).rejects.toMatchObject({
      code: "approval-order-mismatch",
      stage: "approval",
    });
    expect(f.native).not.toHaveBeenCalled();
  });

  it("does not credit a forwarded write without exactly its own decision", async () => {
    const f = fixture();
    const { selected } = definition(f);
    f.environment.sendTurn = async () => {
      await f.port(REQUEST);
      return resultTurn([OPERATION], 0);
    };
    await expect(step(f.environment, selected)).rejects.toMatchObject({
      code: "approval-count-mismatch",
      stage: "approval",
    });
    expect(selected.verify).not.toHaveBeenCalled();
  });

  it.each(["verified", "unverified"])(
    "never upgrades an unconfirmed product outcome through a %s proof",
    async (status) => {
      const f = fixture();
      const { selected } = definition(f, { verify: async () => ({ status }) });
      f.environment.sendTurn = async (...args) => {
        expect(args[5].allowFailure).toBe(true);
        args[5].beforeDecision(pending(OPERATION));
        await f.port(REQUEST);
        return resultTurn([OPERATION], 1, "succeeded-unconfirmed");
      };
      if (status === "unverified")
        await expect(step(f.environment, selected)).resolves.toEqual({ status });
      else
        await expect(step(f.environment, selected)).rejects.toMatchObject({
          code: "unconfirmed-outcome-promoted",
          stage: "readback",
        });
    },
  );

  it("classifies independent verification errors without their private contents or assertion values", async () => {
    const f = fixture();
    const { selected } = definition(f, {
      verify: () => {
        throw new Error("private-test-value");
      },
    });
    const error = await step(f.environment, selected).catch((failure) => failure);
    expect(error).toMatchObject({ code: "readback-failed", stage: "readback" });
    expect(error.message).not.toContain("private-test-value");
    expect(error.cause).toBeUndefined();
  });
});

describe("readable role presentation checks", () => {
  it("ignores the stable aria label and legitimate body text while inspecting visible result headings", async () => {
    const f = fixture([card({ text: "Update issue\nJira action\nCompleted" })]);
    await expect(readableResultFindings(f.environment)).resolves.toBe(0);
    await expect(readableSummary(f.environment)).resolves.toEqual({ presentationFindings: 0 });
  });
  it("counts visible generic headings and unavailable-result rows without serializing their text", async () => {
    const f = fixture([
      card({
        title: "Jira action",
        text: "Jira action\nA readable view of this result is unavailable.",
      }),
      card({ title: "Jira action" }),
    ]);
    await expect(readableResultFindings(f.environment)).resolves.toBe(3);
    await expect(readableSummary(f.environment)).rejects.toMatchObject({
      stage: "presentation",
      presentationFindings: 3,
    });
  });
  it("ignores hidden cards and hidden headings, and refuses raw visible output", async () => {
    const f = fixture([
      card({ title: "Jira action", headingVisible: false }),
      card({ title: "Jira action", visible: false }),
    ]);
    await expect(readableResultFindings(f.environment)).resolves.toBe(0);
    await expect(readableSummary(fixture([card({ raw: 1 })]).environment)).rejects.toMatchObject({
      code: "raw-result-visible",
      presentationFindings: 1,
    });
  });
  it("permits zero cards only by explicit read opt-in and still rejects any visible generic read result", async () => {
    const f = fixture([]);
    await expect(readableSummary(f.environment)).rejects.toMatchObject({
      code: "readable-summary-missing",
      presentationFindings: 1,
    });
    await expect(readableSummary(f.environment, { allowNoCard: true })).resolves.toEqual({
      presentationFindings: 0,
    });
    await expect(
      readableSummary(fixture([card({ title: "Jira action" })]).environment, { allowNoCard: true }),
    ).rejects.toMatchObject({ code: "jira-action-generic" });
  });
});

describe("unchanged extracted helpers and lazy fallback", () => {
  it("retains the exact old receipt/link locators and encoded issue-read path", async () => {
    const waitFor = vi.fn(async () => undefined);
    const receipt = {
      filter: vi.fn(() => ({ last: () => ({ waitFor }) })),
      locator: vi.fn(() => ({ count: async () => 0 })),
    };
    const link = { waitFor, getAttribute: vi.fn(async () => ORIGIN + "/browse/SYN-1") };
    const links = { filter: vi.fn(() => ({ first: () => link })) };
    const environment = {
      context: { session: DEFAULT_LAB_CONNECTION },
      region: { getByRole: vi.fn((role) => (role === "region" ? receipt : links)) },
    };
    await visibleReceipt(environment, "SYN-1");
    await visibleLink(environment, "SYN-1", "/browse/SYN-1");
    expect(environment.region.getByRole).toHaveBeenCalledWith("region", {
      name: "Jira action",
      exact: true,
    });
    expect(receipt.locator).toHaveBeenCalledWith("pre");
    const read = vi.fn(async () => ({ key: "SYN-1" }));
    await expect(issueRead(environment.context, "SYN/1", read)).resolves.toEqual({ key: "SYN-1" });
    expect(read).toHaveBeenCalledExactlyOnceWith(
      DEFAULT_LAB_CONNECTION,
      "/rest/api/2/issue/SYN%2F1?fields=*all",
    );
  });
  it("rejects missing or unknown selected outcomes rather than crediting answer prose", () => {
    expect(() =>
      stepOutcome({ ...resultTurn(), exchanges: [] }, { operations: [OPERATION] }),
    ).toThrow(JourneyStepFailure);
    expect(() =>
      stepOutcome(resultTurn([OPERATION], 1, "unknown"), { operations: [OPERATION] }),
    ).toThrow(JourneyStepFailure);
  });
  it("loads the real sender owner lazily only when no injected sender is supplied", async () => {
    expect(lazyDriver.loads).toBe(0);
    const f = fixture();
    const { selected, proof } = definition(f, { operation: OPERATION, wire: WIRE });
    lazyDriver.send.mockImplementationOnce(f.environment.sendTurn);
    delete f.environment.sendTurn;
    await expect(step(f.environment, selected)).resolves.toBe(proof);
    expect(lazyDriver.loads).toBe(1);
    expect(lazyDriver.send).toHaveBeenCalledOnce();
  });
});
