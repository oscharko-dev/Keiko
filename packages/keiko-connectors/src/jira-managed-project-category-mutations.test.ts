import { describe, expect, it } from "vitest";
import { PROJECT_CATEGORY_FIXTURE_CASES, projectCategoryFixture } from "../../../tests/support/jira-project-category-fixture.js";
import { executeJiraProjectCategoryMutation as execute } from "./jira-managed-project-category-mutations.js";

describe("reviewed native project category administration", () => {
  it.each(PROJECT_CATEGORY_FIXTURE_CASES)("executes $name once with exact native arguments", async ({ name, args, method, path, body }) => {
    const f = projectCategoryFixture();
    const result = await execute(name, structuredClone(args), f.request);
    const effects = f.calls.filter((call) => call.method !== "GET");
    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({ method, path: path.replace("/rest/api/2/", ""), body });
    const categoryId = name === "jira.create-project-category" ? "9007199254740993" : "7";
    expect(result.receipt).toEqual({ categoryId, userKey: "synthetic-actor", categoryPresent: method !== "DELETE" });
    expect(result.ok).toBe(method !== "DELETE");
    if (name === "jira.update-project-category") expect(f.snapshot()).toEqual([{ id: "7", name: "Delivery revised", description: "" }]);
    if (name === "jira.delete-project-category") {
      expect(f.snapshot()).toEqual([]);
      expect(result).toMatchObject({ ok: false, reason: "unavailable" });
    }
  });
  it.each(PROJECT_CATEGORY_FIXTURE_CASES)("checks $name without effects", async ({ name, args }) => {
    const f = projectCategoryFixture();
    expect(await execute(name, structuredClone(args), f.request, true)).toEqual({ ok: true, receipt: {} });
    expect(f.calls.every((call) => call.method === "GET")).toBe(true);
    expect(f.snapshot()).toEqual([{ id: "7", name: "Delivery", description: "Current category" }]);
  });
  it.each(PROJECT_CATEGORY_FIXTURE_CASES)("retains acknowledged context after denied $name readback", async ({ name, args }) => {
    const f = projectCategoryFixture();
    f.controls.denyReadback = true;
    const result = await execute(name, structuredClone(args), f.request);
    expect(result).toMatchObject({ ok: false, reason: "permission-denied", receipt: { userKey: "synthetic-actor" } });
    expect(f.calls.filter((call) => call.method !== "GET")).toHaveLength(1);
  });
  it.each(PROJECT_CATEGORY_FIXTURE_CASES)("does not replay $name after a lost acknowledgement", async ({ name, args }) => {
    const f = projectCategoryFixture();
    f.controls.loseAck = true;
    const result = await execute(name, structuredClone(args), f.request);
    expect(result).toMatchObject({ ok: false, reason: "timeout" });
    expect(f.calls.at(-1)?.method).not.toBe("GET");
    expect(f.calls.filter((call) => call.method !== "GET")).toHaveLength(1);
    if (name === "jira.create-project-category") expect(result.receipt).toBeUndefined();
    else expect(result.receipt?.categoryId).toBe("7");
  });
  it("retains a lossless created ID even when the ACK supplies no descriptive fields", async () => {
    const f = projectCategoryFixture();
    f.controls.ackIdOnly = true;
    const test = PROJECT_CATEGORY_FIXTURE_CASES[0];
    expect(await execute(test.name, test.args, f.request)).toEqual({ ok: true, receipt: {
      categoryId: "9007199254740993", userKey: "synthetic-actor", categoryPresent: true,
    } });
  });
  it("uses collection names without inventing unavailable descriptions for unrelated categories", async () => {
    const f = projectCategoryFixture();
    if (f.categories[0] === undefined) throw new TypeError("Synthetic existing category missing");
    delete f.categories[0].description;
    const test = PROJECT_CATEGORY_FIXTURE_CASES[0];
    expect(await execute(test.name, test.args, f.request)).toMatchObject({ ok: true });
    expect(f.snapshot()[0]).not.toHaveProperty("description");
  });
  it("does not guess a created ID from matching collection names after malformed ACK", async () => {
    const f = projectCategoryFixture();
    f.controls.malformedAck = true;
    const test = PROJECT_CATEGORY_FIXTURE_CASES[0];
    const result = await execute(test.name, test.args, f.request);
    expect(result).toEqual({ ok: false, reason: "malformed-payload" });
    expect(f.snapshot()).toHaveLength(2);
    expect(f.calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });
  it("requires independent current metadata rather than the PUT response", async () => {
    const f = projectCategoryFixture();
    f.controls.wrongReadback = true;
    const test = PROJECT_CATEGORY_FIXTURE_CASES[1];
    expect(await execute(test.name, test.args, f.request)).toMatchObject({ ok: false, reason: "unavailable", receipt: { categoryId: "7" } });
  });
  it("reports a true no-op without a native write", async () => {
    const f = projectCategoryFixture();
    const test = PROJECT_CATEGORY_FIXTURE_CASES[1];
    expect(await execute(test.name, { ...test.args, name: "Delivery", description: "Current category" }, f.request))
      .toMatchObject({ ok: false, reason: "conflict", detail: { unchanged: true } });
    expect(f.calls.every((call) => call.method === "GET")).toBe(true);
  });
  it.each(["actor", "name", "description", "unavailable-description"])("refuses changed/unavailable %s before effects", async (field) => {
    const f = projectCategoryFixture();
    const test = PROJECT_CATEGORY_FIXTURE_CASES[1];
    if (field === "actor") f.actor.key = "another-actor";
    if (field === "name" && f.categories[0] !== undefined) f.categories[0].name = "Changed";
    if (field === "description" && f.categories[0] !== undefined) f.categories[0].description = "Changed";
    if (field === "unavailable-description") f.controls.nullDescription = true;
    expect(await execute(test.name, test.args, f.request)).toMatchObject({ ok: false });
    expect(f.calls.every((call) => call.method === "GET")).toBe(true);
  });
  it("requires explicit deletion uncertainty and rejects extra routing arguments", async () => {
    const f = projectCategoryFixture();
    const test = PROJECT_CATEGORY_FIXTURE_CASES[2];
    expect(await execute(test.name, { ...test.args, confirmUnverifiedDeletion: false }, f.request)).toMatchObject({ ok: false, reason: "field-validation" });
    expect(await execute(test.name, { ...test.args, url: "https://foreign.invalid" }, f.request)).toMatchObject({ ok: false, reason: "field-validation" });
    expect(f.calls).toEqual([]);
  });
});
