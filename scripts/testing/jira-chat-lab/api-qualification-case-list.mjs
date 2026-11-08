import assert from "node:assert/strict";
import { API_QUALIFICATION_CASES } from "./api-qualification-cases.mjs";
import { API_QUALIFICATION_OBSERVATION_CASES } from "./api-qualification-observation-cases.mjs";
import { API_QUALIFICATION_CONFIGURATION_CASES } from "./api-qualification-configuration-cases.mjs";
import { API_QUALIFICATION_ISSUE_CASES } from "./api-qualification-issue-cases.mjs";
import { API_QUALIFICATION_PROPERTY_CASES } from "./api-qualification-property-cases.mjs";
import { API_QUALIFICATION_RELEASE_CASES } from "./api-qualification-release-cases.mjs";
import { API_QUALIFICATION_ADMIN_CASES } from "./api-qualification-admin-cases.mjs";
import { API_QUALIFICATION_AGILE_CASES } from "./api-qualification-agile-cases.mjs";
import { API_QUALIFICATION_WORKFLOW_CASES } from "./api-qualification-workflow-cases.mjs";
import { API_QUALIFICATION_SCREEN_CASES } from "./api-qualification-screen-cases.mjs";
import { API_QUALIFICATION_PREFERENCE_CASES } from "./api-qualification-preference-cases.mjs";
import { API_QUALIFICATION_MONITORING_CASES } from "./api-qualification-monitoring-cases.mjs";
import { API_QUALIFICATION_VERSION_LIFECYCLE_CASES } from "./api-qualification-version-lifecycle-cases.mjs";
import { API_QUALIFICATION_ISSUE_LIFECYCLE_CASES } from "./api-qualification-issue-lifecycle-cases.mjs";
import { API_QUALIFICATION_PROJECT_LIFECYCLE_CASES } from "./api-qualification-project-lifecycle-cases.mjs";
import {
  API_QUALIFICATION_SCHEMA_CASES,
  API_QUALIFICATION_SCHEMA_CLEANUP_CASES,
} from "./api-qualification-schema-cases.mjs";
import { API_QUALIFICATION_ASSOCIATION_CASES } from "./api-qualification-association-cases.mjs";
import { API_QUALIFICATION_INTEGRATOR_A_CASES } from "./api-qualification-integrator-a-cases.mjs";
import { API_QUALIFICATION_INTEGRATOR_B_CASES } from "./api-qualification-integrator-b-cases.mjs";
import { API_QUALIFICATION_INTEGRATOR_C_CASES } from "./api-qualification-integrator-c-cases.mjs";
import { API_QUALIFICATION_PLANNING_CASES } from "./api-qualification-planning-cases.mjs";
import { API_QUALIFICATION_APPLICATION_ROLE_CASES } from "./api-qualification-application-role-cases.mjs";
import { API_QUALIFICATION_ASSETS_CASES } from "./api-qualification-assets-cases.mjs";
import { API_QUALIFICATION_FILTER_CASES } from "./api-qualification-filter-cases.mjs";
import { API_QUALIFICATION_LINK_CASES } from "./api-qualification-link-cases.mjs";
import { API_QUALIFICATION_INDEX_CASES } from "./api-qualification-index-cases.mjs";

export const API_QUALIFICATION_ALL_CASES = [
  ...API_QUALIFICATION_CASES,
  ...API_QUALIFICATION_OBSERVATION_CASES,
  ...API_QUALIFICATION_CONFIGURATION_CASES,
  ...API_QUALIFICATION_ISSUE_CASES,
  ...API_QUALIFICATION_PROPERTY_CASES,
  ...API_QUALIFICATION_RELEASE_CASES,
  ...API_QUALIFICATION_ADMIN_CASES,
  ...API_QUALIFICATION_AGILE_CASES,
  ...API_QUALIFICATION_WORKFLOW_CASES,
  ...API_QUALIFICATION_SCREEN_CASES,
  ...API_QUALIFICATION_PREFERENCE_CASES,
  ...API_QUALIFICATION_MONITORING_CASES,
  ...API_QUALIFICATION_VERSION_LIFECYCLE_CASES,
  ...API_QUALIFICATION_ISSUE_LIFECYCLE_CASES,
  ...API_QUALIFICATION_PROJECT_LIFECYCLE_CASES,
  ...API_QUALIFICATION_SCHEMA_CASES,
  ...API_QUALIFICATION_ASSOCIATION_CASES,
  ...API_QUALIFICATION_SCHEMA_CLEANUP_CASES,
  ...API_QUALIFICATION_INTEGRATOR_A_CASES,
  ...API_QUALIFICATION_INTEGRATOR_B_CASES,
  ...API_QUALIFICATION_INTEGRATOR_C_CASES,
  ...API_QUALIFICATION_PLANNING_CASES,
  ...API_QUALIFICATION_APPLICATION_ROLE_CASES,
  ...API_QUALIFICATION_ASSETS_CASES,
  ...API_QUALIFICATION_FILTER_CASES,
  ...API_QUALIFICATION_LINK_CASES,
  ...API_QUALIFICATION_INDEX_CASES,
];
export function assertQualificationRecipeCoverage(ledger, decisions) {
  const identities = new Set();
  for (const entry of API_QUALIFICATION_ALL_CASES) {
    const identity = ledger.currentCapabilities[entry.tool]?.identity;
    assert.ok(identity && !identities.has(identity) && !decisions.has(identity));
    identities.add(identity);
  }
  for (const row of ledger.operations)
    assert.ok(
      identities.has(row.identity) || decisions.has(row.identity),
      "The complete inventory needs native recipes or explicit owner decisions before a full run",
    );
  assert.equal(identities.size + decisions.size, ledger.operations.length);
}
