import { probeBackends, selectEnforcingBackend } from "@oscharko-dev/keiko-sandbox";

export interface NetworkIsolationCapability {
  readonly backend: ReturnType<typeof selectEnforcingBackend>;
  readonly enforced: boolean;
}

export function probeNetworkIsolation(): NetworkIsolationCapability {
  const backend = selectEnforcingBackend(process.platform, probeBackends());
  return { backend, enforced: backend !== "none" };
}
