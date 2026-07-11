import type { ManagedLspRuntimeConfiguration } from "@oscharko-dev/keiko-contracts";

import { pythonProtocolConfiguration } from "./pythonProvider.js";
import { goProtocolConfiguration } from "./goProvider.js";
import { shellProtocolConfiguration } from "./shellProvider.js";
import { javaProtocolConfiguration } from "./javaProvider.js";
import { rustProtocolConfiguration } from "./rustProvider.js";

export interface ManagedProviderProtocolConfiguration {
  readonly revision: number;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly initializationOptions: Readonly<Record<string, unknown>>;
  readonly resourceBudget?:
    | {
        readonly maxFiles: number;
        readonly maxBytes: number;
        readonly maxMemoryMb?: number | undefined;
        readonly indexDeadlineMs?: number | undefined;
      }
    | undefined;
}

export function managedProviderProtocolConfiguration(
  configuration: ManagedLspRuntimeConfiguration,
  workspaceRoot: string,
): ManagedProviderProtocolConfiguration {
  return {
    revision: configuration.revision,
    ...protocolSettings(configuration, workspaceRoot),
  };
}

function protocolSettings(
  configuration: ManagedLspRuntimeConfiguration,
  workspaceRoot: string,
): {
  readonly settings: Readonly<Record<string, unknown>>;
  readonly initializationOptions: Readonly<Record<string, unknown>>;
} {
  switch (configuration.language) {
    case "python":
      return { settings: pythonProtocolConfiguration(configuration), initializationOptions: {} };
    case "go":
      return goProtocolConfiguration(configuration, workspaceRoot);
    case "shell":
      return shellProtocolConfiguration(configuration, workspaceRoot);
    case "java":
      return javaProtocolConfiguration(configuration);
    case "rust":
      return rustProtocolConfiguration(configuration);
  }
}
