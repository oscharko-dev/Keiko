import { parseArgs } from "node:util";
import { downgradeJiraCompatibility } from "./lib/jira-compatibility-downgrade.mjs";

try {
  const { values } = parseArgs({
    options: {
      config: { type: "string" },
      apply: { type: "boolean", default: false },
      "server-stopped": { type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: true,
  });
  if (!values.config) throw new Error("config-required");
  const result = downgradeJiraCompatibility({
    configPath: values.config,
    apply: values.apply,
    serverStopped: values["server-stopped"],
  });
  console.log(
    `jira-compatibility-downgrade: affected=${result.affected} changed=${result.changed}`,
  );
} catch {
  // Invalid paths and metadata can contain private topology. Keep terminal diagnostics body-free.
  console.error("jira-compatibility-downgrade: refused; see the rollback runbook prerequisites");
  process.exitCode = 1;
}
