import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import {
  buildRoleStep,
  ROLE_STEP_CATALOG,
  ROLE_STEP_IDS,
} from "../testing/jira-chat-lab/browser-roles-steps.mjs";
import { step } from "../testing/jira-chat-lab/browser-journey-step.mjs";
import { projectAgileWitness } from "../testing/jira-chat-lab/project-agile-oracles.mjs";
import { EXECUTION, RoleWorld, roleOf } from "./helpers/jira-browser-roles-world.mjs";

const ORIGIN = "https://127.0.0.1:18443";
const READS = ["Dev1", "PL10", "TL4", "TL8"];
const EXPECTED_WRITES = [
  1, 1, 1, 1, 1, 4, 1, 0, 1, 1, 1, 1, 1, 2, 1, 1, 1, 2, 1, 0, 2, 1, 3, 1, 0, 2, 1, 3, 0, 1,
];
function presentation(count, denied) {
  return {
    locator: () => ({
      count: () => Promise.resolve(count),
      nth: () => ({
        isVisible: () => Promise.resolve(true),
        innerText: () =>
          Promise.resolve(
            denied ? "Sprint löschen\nBerechtigung fehlt" : "Vorgang\nLesbares Ergebnis",
          ),
        locator: (selector) =>
          selector === "pre:visible"
            ? { count: () => Promise.resolve(0) }
            : {
                innerText: () => Promise.resolve("Vorgang"),
                isVisible: () => Promise.resolve(true),
              },
      }),
    }),
  };
}
function exchange(plan, index, result = false) {
  return {
    call: { name: plan.operation.replaceAll(/[.-]/gu, "_") },
    ...(result
      ? {
          result: {
            status: plan.status === 403 ? "failed" : "completed",
            data: {
              outcome:
                plan.status === 403
                  ? "rejected"
                  : plan.operation === "jira.rank-issues" || plan.operation === "jira.delete-sprint"
                    ? "succeeded-unconfirmed"
                    : "succeeded",
              ...(plan.status === 403 ? { reason: "permission-denied" } : {}),
            },
          },
        }
      : {
          approval: {
            approvalId: `approval-${index}`,
            state: "pending",
            operation: plan.operation,
          },
        }),
  };
}
function request(plan, wrong = false) {
  return {
    method: plan.method,
    url: `${ORIGIN}${plan.path}${wrong ? "/wrong" : ""}`,
    ...(plan.body === undefined ? {} : { bodyJson: JSON.stringify(plan.body) }),
  };
}
function nativePort(plans, mode) {
  let index = 0;
  return (wire) => {
    const planned = plans[index++];
    assert.ok(planned, "No additional native effect is permitted");
    assert.equal(wire.method, planned.method);
    assert.equal(wire.url, `${ORIGIN}${planned.path}`);
    assert.deepEqual(
      wire.bodyJson === undefined ? undefined : JSON.parse(wire.bodyJson),
      planned.body,
    );
    planned.apply();
    return Promise.resolve({
      kind: "response",
      status: mode === "wrong-denial-status" ? 200 : planned.status,
      bodyText: "{}",
      bodyBytes: 2,
      truncated: false,
    });
  };
}
function readExchange(mode) {
  return {
    call: {
      name: mode === "read-via-report" || mode === "failed-report" ? "jira_report" : "jira_search",
    },
    result: { status: mode === "failed-report" ? "failed" : "completed", data: {} },
  };
}
function finishStubTurn({ world, id, mode, plans, exchanges }) {
  if (plans.length === 0) exchanges.push(readExchange(mode));
  if (mode === "precheck-refusal") exchanges.push(exchange(plans[0], 0, true));
  if (mode === "duplicate-refusal") exchanges.push(structuredClone(exchanges[0]));
  if (mode === "wrong-denial-reason") exchanges[0].result.data.reason = "conflict";
  world.drift = mode === "readback-drift";
  let answer = world.answer(id);
  if (mode === "wrong-answer-keys") answer += "\nSYN-999";
  if (mode === "wrong-answer-numbers")
    answer = answer.replace(/(Anzahl|Erledigt): [0-9]+/u, "$1: 999");
  if (mode === "duplicate-permission-answer") answer += "\nBerechtigung fehlt";
  return {
    exchanges,
    answer,
    user: { id: "user-turn" },
    clientTurnId: "00000000-0000-4000-8000-000000000001",
    decisions: mode === "precheck-refusal" ? 0 : plans.length,
  };
}
function createEnvironment(id, mode = "positive", shared = {}) {
  const world = shared.world ?? new RoleWorld().prepare(id);
  const plans = world.plans(id);
  const witness = shared.witness ?? projectAgileWitness();
  const group = shared.group ?? { state: world.observedState(), results: [] };
  const port = witness.decorate(() => nativePort(plans, mode))();
  const environment = {
    fixture: world.fixture,
    group,
    witness,
    context: { session: {} },
    chat: { id: "role-chat" },
    page: {},
    persist: () => undefined,
    region: presentation(Math.max(1, plans.length), id === "Dev10"),
    read: (path) => Promise.resolve(world.read(path)),
    readResult: (path) =>
      Promise.resolve({
        status: world.sprints.some(({ id }) => path.endsWith(`/${id}`)) ? 200 : 404,
      }),
  };
  environment.sendTurn = async (_page, _region, _context, _chat, _prompt, options) => {
    const exchanges = [];
    for (const [index, plan] of (mode === "precheck-refusal" ? [] : plans).entries()) {
      options.beforeDecision(exchange(plan, index));
      await port(request(plan, mode === "wrong-wire" && index === 0));
      exchanges.push(exchange(plan, index, true));
    }
    if (mode === "extra-write" || (mode === "wrong-wire" && plans.length === 0))
      await port(
        request(
          plans.at(-1) ?? { method: "PUT", path: "/rest/api/2/issue/999", body: { fields: {} } },
        ),
      );
    return finishStubTurn({ world, id, mode, plans, exchanges });
  };
  return { environment, world, plans };
}
async function execute(id, mode) {
  const { environment, world, plans } = createEnvironment(id, mode);
  const definition = await buildRoleStep(environment, roleOf(id), id);
  const proof = await step(environment, environment.group, definition);
  return { proof, environment, world, plans, definition };
}
function signatureMatches(template, path) {
  const source = template
    .split(/(\{[A-Za-z][A-Za-z0-9]*\})/u)
    .map((part) => (/^\{/u.test(part) ? "[^/?]+" : part.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&")))
    .join("");
  return new RegExp(`^${source}$`, "u").test(path);
}

describe("thirty role turns through the real shared step and native transport witness", () => {
  it("executes the complete interleaved day with IDs supplied only by prior native readbacks", async () => {
    const shared = {
      world: new RoleWorld(),
      witness: projectAgileWitness(),
      group: { state: {}, results: [] },
    };
    let forwarded = 0;
    for (const id of EXECUTION) {
      const { environment } = createEnvironment(id, "positive", shared);
      await step(environment, shared.group, await buildRoleStep(environment, roleOf(id), id));
      forwarded += shared.witness.snapshot().forwarded;
    }
    expect(shared.group.results).toHaveLength(30);
    expect(forwarded).toBe(37);
    expect(Object.keys(shared.group.state).sort()).toEqual([
      "bug",
      "component",
      "sprint1",
      "sprint2",
      "subtask",
      "version",
    ]);
    expect(
      shared.group.results
        .filter(({ proof }) => proof.status === "unverified")
        .map(({ name }) => name),
    ).toEqual(["PL5", "PL11"]);
  });
  it("declares the exact complete role order and independent write counts", () => {
    expect(ROLE_STEP_IDS).toEqual({
      projectLead: Array.from({ length: 11 }, (_, i) => `PL${i + 1}`),
      developer: Array.from({ length: 10 }, (_, i) => `Dev${i + 1}`),
      techLead: Array.from({ length: 9 }, (_, i) => `TL${i + 1}`),
    });
    expect(
      EXECUTION.map(
        (id) => ROLE_STEP_CATALOG[roleOf(id)].find((item) => item.id === id).expectedWrites,
      ),
    ).toEqual(EXPECTED_WRITES);
  });
  it.each(EXECUTION)(
    "%s proves the exact approved wire and independent native effects",
    async (id) => {
      const { proof, environment, plans, definition } = await execute(id, "positive");
      expect(proof.status).toBe(
        id === "Dev10" ? "denied" : id === "PL5" || id === "PL11" ? "unverified" : "verified",
      );
      expect(environment.witness.snapshot()).toMatchObject({
        blocked: 0,
        attempted: plans.length,
        forwarded: plans.length,
      });
      expect(environment.group.results[0].approvals).toBe(plans.length);
      const signatures = ROLE_STEP_CATALOG[roleOf(id)].find(
        (entry) => entry.id === id,
      ).wireSignatures;
      for (const [index, plan] of plans.entries()) {
        expect(signatures[index].method).toBe(plan.method);
        expect(signatureMatches(signatures[index].path, plan.path)).toBe(true);
      }
      expect(definition.prompt).not.toMatch(/\bjira[._][a-z]|keiko[_-]jira|tools?\b/iu);
      expect(JSON.stringify(proof)).not.toContain("Synthetic description");
    },
  );
  for (const mode of ["wrong-wire", "extra-write", "readback-drift"]) {
    it.each(EXECUTION)(`%s rejects ${mode} without claiming success`, async (id) => {
      await expect(execute(id, mode)).rejects.toMatchObject({ name: "JourneyStepFailure" });
    });
  }
  it.each(READS)("%s rejects an extra answer issue key against independent JQL", async (id) => {
    await expect(execute(id, "wrong-answer-keys")).rejects.toMatchObject({
      stage: "answer",
      code: "answer-keys-mismatch",
    });
  });
  it.each(READS)(
    "%s accepts a completed curated report under the same independent JQL oracle",
    async (id) => {
      const { proof, environment } = await execute(id, "read-via-report");
      expect(proof.status).toBe("verified");
      expect(environment.witness.snapshot().forwarded).toBe(0);
    },
  );
  it("PL10 refuses a failed report result even when its answer happens to match native JQL", async () => {
    await expect(execute("PL10", "failed-report")).rejects.toMatchObject({
      code: "operation-outcome-unexpected",
      stage: "turn",
    });
  });
  it("TL1 rejects a conflicting returned lead key even when its native username matches", async () => {
    const { environment } = createEnvironment("TL1");
    const read = environment.read;
    environment.read = async (path) => {
      const value = await read(path);
      return path === "/rest/api/2/component/601"
        ? { ...value, lead: { ...value.lead, key: "foreign-lead" } }
        : value;
    };
    const definition = await buildRoleStep(environment, "techLead", "TL1");
    await expect(step(environment, environment.group, definition)).rejects.toMatchObject({
      stage: "readback",
      code: "native-state-mismatch",
    });
  });
  it.each(READS)("%s rejects wrong report numbers against independent JQL", async (id) => {
    await expect(execute(id, "wrong-answer-numbers")).rejects.toMatchObject({
      stage: "answer",
      code: "answer-numbers-mismatch",
    });
  });
  it.each([
    "wrong-denial-status",
    "precheck-refusal",
    "duplicate-refusal",
    "wrong-denial-reason",
    "duplicate-permission-answer",
  ])("Dev10 rejects %s instead of accepting one native readable403 refusal", async (mode) => {
    await expect(execute("Dev10", mode)).rejects.toMatchObject({ name: "JourneyStepFailure" });
  });
  it("builds from each environment's observed native IDs instead of retaining another run", async () => {
    const { environment, world } = createEnvironment("TL2");
    world.components[0].id = "777";
    environment.group.state.component.id = "777";
    const definition = await buildRoleStep(environment, "techLead", "TL2");
    expect(definition.wire[0].admit({ fields: { components: [{ id: "777" }] }, update: {} })).toBe(
      true,
    );
    expect(definition.wire[0].admit({ fields: { components: [{ id: "601" }] }, update: {} })).toBe(
      false,
    );
  });
  it.each(["PL6", "PL11", "Dev7"])(
    "%s binds a newly observed opaque ID between its writes",
    async (id) => {
      const { environment, world, plans } = createEnvironment(id);
      const create = plans[0].apply;
      plans[0].apply = () => {
        create();
        replaceCreatedIdentity(world, plans, id);
      };
      const definition = await buildRoleStep(environment, roleOf(id), id);
      const proof = await step(environment, environment.group, definition);
      expect(proof.status).toBe(id === "PL11" ? "unverified" : "verified");
      if (id !== "PL11")
        expect(environment.group.state[id === "PL6" ? "version" : "bug"].id).toBe("777");
      expect(environment.witness.snapshot().forwarded).toBe(plans.length);
    },
  );
});

function replaceCreatedIdentity(world, plans, id) {
  if (id === "PL6") {
    world.versions[0].id = "777";
    for (const plan of plans.slice(1)) plan.body.fields.fixVersions[0].id = "777";
  } else if (id === "Dev7") {
    world.issue("902").id = "777";
    Object.assign(plans[1], world.link("777", "202", "1001"));
  } else {
    world.sprints.find((value) => value.id === "403").id = "777";
    world.memberships.delete("403");
    world.memberships.set("777", []);
    plans[1].path = "/rest/agile/1.0/sprint/777";
    plans[1].apply = () => {
      world.sprints = world.sprints.filter((value) => value.id !== "777");
      world.memberships.delete("777");
    };
  }
}

function completionScenario({ offered, fields, resolutions, actual }) {
  const scenario = createEnvironment("Dev8");
  const { environment, world, plans } = scenario;
  const read = environment.read;
  environment.read = async (path) => {
    if (path === "/rest/api/2/resolution") return structuredClone(resolutions);
    const value = await read(path);
    if (path === "/rest/api/2/issue/SYN-4/transitions?expand=transitions.fields") {
      const target = value.transitions.find(({ id }) => id === "41");
      target.fields = offered ? { resolution: { allowedValues: offered } } : {};
    }
    return value;
  };
  plans[0].body.fields = fields;
  const apply = plans[0].apply;
  plans[0].apply = () => {
    apply();
    world.issue("202").fields.resolution = structuredClone(actual);
  };
  return scenario;
}

describe("Dev8 native completion resolution", () => {
  const fixed = { id: "1", name: "Fixed" };
  const done = { id: "2", name: "Done" };
  it("accepts a native Done postfunction without inserting a resolution field or asking for Fixed", async () => {
    const { environment, plans } = completionScenario({
      fields: {},
      resolutions: [fixed, done],
      actual: done,
    });
    const definition = await buildRoleStep(environment, "developer", "Dev8");
    expect(definition.prompt).not.toContain('Resolution "Fixed"');
    expect(definition.prompt).toContain("gesetzter Resolution");
    expect(
      definition.wire[0].admit({
        fields: { resolution: { id: "1" } },
        update: {},
        transition: { id: "41" },
      }),
    ).toBe(false);
    const proof = await step(environment, environment.group, definition);
    expect(proof.status).toBe("verified");
    expect(plans).toHaveLength(1);
    expect(plans[0].body).toEqual({ fields: {}, update: {}, transition: { id: "41" } });
    expect(environment.witness.snapshot().forwarded).toBe(1);
  });
  it("pins a non-Fixed resolution that the actual transition offers", async () => {
    const { environment } = completionScenario({
      offered: [done],
      fields: { resolution: { id: "2" } },
      resolutions: [fixed, done],
      actual: done,
    });
    const definition = await buildRoleStep(environment, "developer", "Dev8");
    expect(definition.prompt).toContain('Resolution "Done"');
    expect(
      definition.wire[0].admit({
        fields: { resolution: { id: "1" } },
        update: {},
        transition: { id: "41" },
      }),
    ).toBe(false);
    const proof = await step(environment, environment.group, definition);
    expect(proof.status).toBe("verified");
    expect(environment.witness.snapshot().forwarded).toBe(1);
  });
  it.each([null, { id: "999", name: "Done" }, { id: "2", name: "Foreign" }])(
    "rejects an absent or uncatalogued native postfunction resolution %j",
    async (actual) => {
      const { environment } = completionScenario({
        fields: {},
        resolutions: [fixed, done],
        actual,
      });
      const definition = await buildRoleStep(environment, "developer", "Dev8");
      await expect(step(environment, environment.group, definition)).rejects.toMatchObject({
        code: "native-state-mismatch",
        stage: "readback",
      });
      expect(environment.witness.snapshot().forwarded).toBe(1);
    },
  );
  it("rejects another catalogued resolution when an offered exact ID was requested", async () => {
    const { environment } = completionScenario({
      offered: [done],
      fields: { resolution: { id: "2" } },
      resolutions: [fixed, done],
      actual: fixed,
    });
    const definition = await buildRoleStep(environment, "developer", "Dev8");
    await expect(step(environment, environment.group, definition)).rejects.toMatchObject({
      code: "native-state-mismatch",
      stage: "readback",
    });
    expect(environment.witness.snapshot().forwarded).toBe(1);
  });
});
