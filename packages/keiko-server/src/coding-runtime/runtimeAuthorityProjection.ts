import { createHash } from "node:crypto";

export type RuntimeAuthorityProjectionDomain =
  "operator" | "task" | "workspace" | "project" | "branch" | "profile";

const PREFIX: Readonly<Record<RuntimeAuthorityProjectionDomain, string>> = {
  operator: "operator",
  task: "task",
  workspace: "workspace",
  project: "id",
  branch: "branch",
  profile: "profile",
};

/** Produces the only evidence-safe representation of a server-private authority value. */
export function projectRuntimeAuthorityValue(
  domain: RuntimeAuthorityProjectionDomain,
  rawValue: string,
): string {
  const hex = createHash("sha256").update(`${domain}\0${rawValue}`, "utf8").digest("hex");
  return `${PREFIX[domain]}-${BigInt(`0x${hex}`).toString(10)}`;
}
