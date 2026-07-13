import type {
  EvidenceStore,
  ManagedLspLanguage,
  WorkspaceInfo,
} from "@oscharko-dev/keiko-contracts";

import { createWorkspaceMutexRegistry } from "../../task-workspace/mutex.js";
import { disposeHostLspPoolEntry } from "./hostLanguageOperation.js";
import {
  defaultHostLanguageCommandRules,
  HOST_LANGUAGE_PROVIDER_SPECS,
  isHostLanguageProviderProvisioned,
} from "./hostLanguageProviders.js";
import { createManagedLspActivationStore } from "./managedLspActivationStore.js";
import {
  createManagedLspControlService,
  type ManagedLspControlService,
} from "./managedLspControl.js";
import { providerConfigurationPathsContained } from "./providers/providerConfigurationSafety.js";
import {
  createManagedLspEvidenceProjector,
  type ManagedLspEvidenceProjector,
} from "./managedLspEvidenceProjector.js";
import {
  emitServerDiagnostic,
  serverDiagnosticFromError,
  type ServerDiagnosticSink,
} from "../../diagnostics-log.js";

export interface NodeManagedLspControlOptions {
  readonly stateDir: string;
  readonly processEnv: Readonly<Record<string, string | undefined>>;
  readonly redact: (value: unknown) => unknown;
  readonly evidenceStore: EvidenceStore;
  readonly diagnosticSink?: ServerDiagnosticSink | undefined;
}

function workspaceForRoot(root: string): WorkspaceInfo {
  return {
    root,
    name: undefined,
    version: undefined,
    testFramework: "unknown" as const,
    sourceDirs: [],
    testDirs: [],
    languages: [],
    ignoreLines: [],
  };
}

export function createNodeManagedLspControl(
  options: NodeManagedLspControlOptions,
): ManagedLspControlService {
  const commandRules = defaultHostLanguageCommandRules();
  const projectEvidence: ManagedLspEvidenceProjector = createManagedLspEvidenceProjector(
    options.evidenceStore,
    (error: unknown): void => {
      emitServerDiagnostic(
        options.diagnosticSink,
        serverDiagnosticFromError({
          correlationId: "managed-lsp-evidence-projection",
          operation: "managed-lsp.evidence.project",
          source: "managed-lsp-control",
          error,
          redact: (message) => {
            const redacted = options.redact(message);
            return typeof redacted === "string" ? redacted : "[REDACTED]";
          },
        }),
      );
    },
  );
  return createManagedLspControlService({
    store: createManagedLspActivationStore({ stateDir: options.stateDir }),
    processEnv: options.processEnv,
    provisioning: (root: string, language: ManagedLspLanguage): boolean =>
      isHostLanguageProviderProvisioned(language, {
        workspace: workspaceForRoot(root),
        processEnv: options.processEnv,
        commandRules,
      }),
    disposePoolEntry: disposeHostLspPoolEntry,
    runtimeApproved: (language, runtimeId) => {
      const spec = HOST_LANGUAGE_PROVIDER_SPECS.find((candidate) =>
        candidate.languages.includes(language),
      );
      return spec?.id === runtimeId;
    },
    configurationSafe: (root, configuration) =>
      providerConfigurationPathsContained(root, configuration) &&
      JSON.stringify(options.redact(configuration)) === JSON.stringify(configuration),
    projectEvidence,
    mutex: createWorkspaceMutexRegistry(),
  });
}
