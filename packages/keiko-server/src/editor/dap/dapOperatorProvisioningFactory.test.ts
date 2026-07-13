import { describe, expect, it } from "vitest";
import type { CommandTaskCatalog } from "@oscharko-dev/keiko-contracts";
import type { WorkspaceFs } from "@oscharko-dev/keiko-workspace";

import { createDapOperatorProvisioning } from "./dapOperatorProvisioningFactory.js";
import {
  parseDapOperatorProvisioningDocument,
  type DapOperatorProvisioningDocument,
} from "./dapOperatorProvisioning.js";

function document(): unknown {
  const artifact = (name: string, capsulePath: string): object => ({
    hostPath: `/operator/${name}`,
    approvedRoot: "/operator",
    capsulePath,
  });
  return {
    schemaVersion: 1,
    adapter: {
      executableName: "node",
      executableArgs: ["/operator/fake-dap.mjs"],
      trustedRoots: ["/operator"],
      approvedPath: "/operator:/usr/bin",
    },
    launch: {
      adapterApprovedRoot: "/operator",
      node: artifact("node", "/opt/keiko-runtime/node"),
      npm: artifact("npm", "/opt/keiko-runtime/npm"),
      shell: artifact("shell", "/opt/keiko-runtime/shell"),
      npmUserConfig: artifact("npm-user", "/opt/keiko-debug/npm-user-config"),
      npmGlobalConfig: artifact("npm-global", "/opt/keiko-debug/npm-global-config"),
      backend: artifact("bwrap", "/opt/keiko-backend/bwrap"),
      runtimeClosure: [artifact("runtime", "/opt/keiko-runtime/lib")],
    },
  };
}

function parsedDocument(): DapOperatorProvisioningDocument {
  const parsed = parseDapOperatorProvisioningDocument(document());
  if (!parsed.ok) throw new Error("Expected valid operator document.");
  return parsed.value;
}

const fs = {} as WorkspaceFs;
const catalog: CommandTaskCatalog = { schemaVersion: "1", projectId: "/workspace", tasks: [] };

describe("createDapOperatorProvisioning", () => {
  it("derives closed ports from server-owned workspace resolution", () => {
    const provisioning = createDapOperatorProvisioning({
      document: parsedDocument(),
      processEnv: { PATH: "/ambient", TOKEN: "secret" },
      fs,
      discover: () => catalog,
      workspaceForPartition: (partition) =>
        partition === "partition"
          ? { root: "/workspace", projectId: "/workspace", trusted: true }
          : undefined,
      workspaceForRoot: (root) =>
        root === "/workspace" ? { root, projectId: root, trusted: true } : undefined,
    });

    expect(provisioning.adapter).toMatchObject({ executableName: "node" });
    expect(
      provisioning.adapterPreflight({ workspacePartitionKey: "partition" } as never),
    ).toMatchObject({
      workspaceRoot: "/workspace",
      approvedPath: "/operator:/usr/bin",
      processEnv: { PATH: "/operator:/usr/bin", TOKEN: "secret" },
    });
    expect(
      provisioning.launchContext({ workspacePartitionKey: "partition" } as never),
    ).toMatchObject({ workspaceRoot: "/workspace", workspaceTrusted: true });
    expect(provisioning.targetCatalog("/workspace")).toMatchObject({ projectId: "/workspace" });
  });

  it("fails closed when the server no longer recognizes a workspace binding", () => {
    const provisioning = createDapOperatorProvisioning({
      document: parsedDocument(),
      processEnv: {},
      fs,
      discover: () => catalog,
      workspaceForPartition: () => undefined,
      workspaceForRoot: () => undefined,
    });

    expect(() =>
      provisioning.adapterPreflight({ workspacePartitionKey: "missing" } as never),
    ).toThrow("INVALID_DEBUG_WORKSPACE_BINDING");
    expect(() => provisioning.targetCatalog("/missing")).toThrow("INVALID_DEBUG_WORKSPACE_BINDING");
  });
});
