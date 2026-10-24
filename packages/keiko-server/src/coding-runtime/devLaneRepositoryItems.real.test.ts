import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import { createCodingRuntimeRepositoryItemsPort } from "./codingRuntimeRepositoryItems.js";
import { createDevLaneSecureWorkspaceTextReadPort } from "./devLaneSecureWorkspaceTextRead.js";
import {
  discoverDevLaneOpenCode,
  KEIKO_CODING_RUNTIME_DEV_LANE_ENV,
} from "./devLanePortableCodingRuntime.js";

// #3897 review (P1): the production discovery -> verified helper -> repository-item admission
// path, with the staged helper this checkout ships (`npm run dev:coding-runtime:stage`). The
// helper of the current approved source speaks the native KSR3/KSS3 protocol, so its binding
// declares it and the loader can list the workspace's `.opencode/` directories.
const CHECKOUT = fileURLToPath(new URL("../../../../", import.meta.url));
const STAGED = join(
  CHECKOUT,
  ".portable-sidecar-payloads",
  "macos-arm64",
  "dev-lane-manifest.json",
);
const skip = process.platform !== "darwin" || process.arch !== "arm64" || !existsSync(STAGED);

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("repository items through the production dev-lane helper", () => {
  it.skipIf(skip)(
    "lists and admits a repository agent through the verified helper's native protocol",
    async () => {
      const discovery = discoverDevLaneOpenCode({
        env: { ...process.env, [KEIKO_CODING_RUNTIME_DEV_LANE_ENV]: "1" },
      });
      expect(discovery.outcome).toBe("activated");
      if (discovery.outcome !== "activated") return;
      expect(discovery.runtime.secureRead.artifact.nativeProtocol).toBe("KSR3/KSS3");

      const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-dev-lane-items-")));
      roots.push(root);
      const workspace = join(root, "workspace");
      const discoveryRoot = join(root, "discovery");
      const safeCwd = join(root, "secure-read");
      mkdirSync(join(workspace, ".opencode", "agent"), { recursive: true });
      mkdirSync(discoveryRoot, { mode: 0o700 });
      mkdirSync(safeCwd, { mode: 0o700 });
      writeFileSync(
        join(workspace, ".opencode", "agent", "reviewer.md"),
        "---\ndescription: Reviews the change.\nmode: subagent\n---\nReview the change.\n",
      );
      const source = createDevLaneSecureWorkspaceTextReadPort({
        binding: discovery.runtime.secureRead,
        resolveWorkspaceRoot: () => workspace,
        safeCwd,
      });
      const activityLog = createBufferedServerLogSink();
      await createCodingRuntimeRepositoryItemsPort({
        enabled: true,
        source,
        isRunWorkspace: () => true,
        activityLog,
      }).admitForRun({ runId: "run-dev-lane-items", discoveryRoot });

      const admitted = activityLog.events.find(
        (event) => event.op === "coding-runtime.repository-items.admitted",
      );
      expect(admitted?.extra).toMatchObject({ state: "completed", agentAdmittedCount: 1 });
      expect(readFileSync(join(discoveryRoot, "agents", "reviewer.md"), "utf8")).toContain(
        "Review the change.",
      );
    },
    60_000,
  );
});
