import { join } from "node:path";
import { e2eStateDir } from "./e2e-state-dir.js";

export const DELIVERY_PORT = 32587;
export const DELIVERY_LAUNCHER_SECRET = "draft-delivery-3387-local-pairing-fixture";
export const DELIVERY_REPOSITORY = "fixture/issue-delivery";
export const DELIVERY_URL = `https://github.com/${DELIVERY_REPOSITORY}.git`;
export const DELIVERY_TITLE = "fix: deliver the accepted issue <script>";
export const DELIVERY_TEMPLATE = "## Review notes\n\nPreserved template <img src=x>.\n";
// #3401: the fixed draft digest the delivery server's fake WorkbenchDescriptionDispatcher
// returns, shared with the spec so it can assert the automatic-description dispatch reached the
// composed job store without either side restating the other's literal.
export const DELIVERY_DESCRIPTION_DRAFT_DIGEST = "b".repeat(64);
export const DELIVERY_OPERATIONS = [
  "push-propose",
  "push-execute",
  "pr-propose",
  "pr-execute",
  "reconcile",
] as const;
export type DeliveryFixtureOperation = (typeof DELIVERY_OPERATIONS)[number];
export function deliveryStateDir(): string {
  return e2eStateDir("coding-issue-delivery-3387");
}
export function deliveryRepository(stateDir: string): string {
  return join(stateDir, "repository");
}
export function deliveryManagedRoot(stateDir: string): string {
  return join(stateDir, "bff-state", "ui-db", "task-workspaces");
}
export function deliveryRemote(stateDir: string): string {
  return join(stateDir, "remote.git");
}
export function deliveryProviderState(stateDir: string): string {
  return join(stateDir, "provider-state.json");
}
export function deliveryRevisionPath(stateDir: string): string {
  return join(stateDir, "issue-revision.txt");
}
