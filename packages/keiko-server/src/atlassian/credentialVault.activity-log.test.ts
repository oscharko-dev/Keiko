import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  activityLogLossCounters,
  resetActivityLogLossCountersForTests,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { NO_LOCAL_VAULT_KEYCHAIN } from "@oscharko-dev/keiko-security/secret-vault";
import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import { resetServerLogger } from "../../../../tests/support/activity-log-test-support.js";
import { createServerLogger, setServerLogger } from "../observability/index.js";
import { openAtlassianCredentialVault } from "./credentialVault.js";

// #4351: the Atlassian credential vault was opened without a sink, so its merge line went nowhere
// and was counted as an unwired port on every credential write. Without a narrower sink named by
// the composition it reports to the process sink.
describe("the Atlassian credential vault", () => {
  afterEach(() => {
    resetServerLogger();
    resetActivityLogLossCountersForTests();
  });

  it("writes its merge line to the process Activity Log, never as an unwired port", () => {
    const logs = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink: logs, level: "info" }));
    resetActivityLogLossCountersForTests();
    const dir = mkdtempSync(join(tmpdir(), "keiko-atlassian-vault-"));
    try {
      const vault = openAtlassianCredentialVault({
        configPath: join(dir, "config.json"),
        env: {},
        keychainAccess: NO_LOCAL_VAULT_KEYCHAIN,
      });
      vault.setMany(new Map([["synthetic-reference", "synthetic-secret"]]));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(activityLogLossCounters()["port-unwired"]).toBe(0);
    expect(logs.events.map((event) => event.op)).toContain("security.vault.entries-merged");
  });
});
