import { join } from "node:path";
import { e2eStateDir } from "./e2e-state-dir.js";

export const DELIVERY_PORT = 32587;
export const DELIVERY_DESCRIPTION_MODEL_ID = "delivery-description-model";
export const DELIVERY_DESCRIPTION_MODEL_API_KEY = "delivery-description-provider-secret";
export const DELIVERY_LAUNCHER_SECRET = "draft-delivery-3387-local-pairing-fixture";
export const DELIVERY_REPOSITORY = "fixture/issue-delivery";
export const DELIVERY_URL = `https://github.com/${DELIVERY_REPOSITORY}.git`;
export const DELIVERY_TITLE = "fix: deliver the accepted issue <script>";
export const DELIVERY_TEMPLATE = "## Review notes\n\nPreserved template <img src=x>.\n";
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
export function deliveryDescriptionModelState(stateDir: string): string {
  return join(stateDir, "description-model-state.json");
}
