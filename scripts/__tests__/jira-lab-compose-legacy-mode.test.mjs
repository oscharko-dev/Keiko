import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

const COMPOSE = join(import.meta.dirname, "../testing/jira-chat-lab/compose.yaml");

it("starts every laboratory Jira with the authentication plugin in legacy mode", () => {
  // Without it Jira 10.3 answers POST /rest/auth/1/session with 403 "two-step verification being
  // enabled", so no private administrator session exists for websudo and avatar qualification.
  const jira = readFileSync(COMPOSE, "utf8").split(/^ {2}jira:$/mu)[1] ?? "";
  expect(jira).toMatch(
    /JVM_SUPPORT_RECOMMENDED_ARGS: "[^"]*-Datlassian\.authentication\.legacy\.mode=true/u,
  );
});
it("enables the synced-sprints feature that creates genuine synced sprints", () => {
  const jira = readFileSync(COMPOSE, "utf8").split(/^ {2}jira:$/mu)[1] ?? "";
  expect(jira).toMatch(
    /JVM_SUPPORT_RECOMMENDED_ARGS: "[^"]*-Datlassian\.darkfeature\.com\.atlassian\.jira\.agile\.darkfeature\.synced\.sprints\.enabled=true/u,
  );
});
