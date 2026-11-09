import assert from "node:assert/strict";
import { read, proof } from "./api-qualification-read.mjs";
import { readCase } from "./api-qualification-cases.mjs";
import { adminMutationCase, observeAdminActor } from "./api-qualification-admin-cases.mjs";
import { fixtureWrite } from "./api-qualification-fixtures.mjs";

const exposurePath = "/rest/api/2/monitoring/jmx/areMetricsExposed";
function toggle(tool, path) {
  return adminMutationCase(
    tool,
    (f) => ({ expectedEnabled: f.monitoringBefore, enabled: !f.monitoringBefore }),
    async (c, _data, f) => {
      assert.equal((await read(c, path)).enabled, !f.monitoringBefore);
      return proof(1);
    },
    async (c, f) => {
      await observeAdminActor(c, f);
      const current = await read(c, path);
      assert.equal(typeof current.enabled, "boolean");
      f.monitoringBefore = current.enabled;
    },
  );
}
function exposure(enabled) {
  return adminMutationCase(
    `jira.${enabled ? "start" : "stop"}-jmx-metrics`,
    (f) => ({ expectedEnabled: f.exposureBefore }),
    async (c) => {
      assert.equal(await read(c, exposurePath), enabled);
      return proof(1);
    },
    async (c, f) => {
      await observeAdminActor(c, f);
      let current = await read(c, exposurePath);
      assert.equal(typeof current, "boolean");
      if (current === enabled) {
        await fixtureWrite(
          c,
          `jira.${enabled ? "stop" : "start"}-jmx-metrics`,
          { expectedEnabled: current },
          async (context) => {
            assert.equal(await read(context, exposurePath), !enabled);
            return proof(1);
          },
        );
        current = await read(c, exposurePath);
      }
      assert.equal(current, !enabled);
      f.exposureBefore = current;
    },
  );
}
export const API_QUALIFICATION_MONITORING_CASES = [
  toggle("jira.set-app-monitoring", "/rest/api/2/monitoring/app"),
  toggle("jira.set-ipd-monitoring", "/rest/api/2/monitoring/ipd"),
  {
    ...readCase(
      "jira.jmx-metrics",
      "/rest/api/2/monitoring/jmx/getAvailableMetrics",
      ["metricsText"],
      {
        // Jira serves the metric names as a JSON array; the product keeps the literal response
        // text, so the independent oracle compares it with the compact JSON of the native array.
        nativeRoot: (value) => {
          assert.ok(Array.isArray(value) && value.every((name) => typeof name === "string"));
          return [{ metricsText: JSON.stringify(value) }];
        },
        productRoot: "single",
      },
    ),
    actor: "admin",
    administration: true,
  },
  exposure(true),
  exposure(false),
];
