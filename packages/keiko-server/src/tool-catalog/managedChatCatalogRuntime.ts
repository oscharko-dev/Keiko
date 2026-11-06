import type { ToolDefinition } from "@oscharko-dev/keiko-contracts";
import type { CatalogConsumer } from "./catalogToolPorts.js";
import type { ManagedProviderCatalog } from "./managedProviderCatalog.js";
import { CatalogDispatchFault } from "./catalogToolErrors.js";

export interface ManagedChatCatalogRuntime<Consumer extends CatalogConsumer> {
  readonly get: () => Promise<ManagedProviderCatalog<Consumer>>;
  readonly toolDefinitions: () => readonly ToolDefinition[];
  readonly close: () => Promise<void>;
}
/** Application graph owns one lazy host and retries initialization only after a failed attempt. */
export function createManagedChatCatalogRuntime<Consumer extends CatalogConsumer>(
  toolDefinitions: () => readonly ToolDefinition[],
  initialize: () => Promise<ManagedProviderCatalog<Consumer>>,
): ManagedChatCatalogRuntime<Consumer> {
  type Initialization =
    | { readonly ok: true; readonly value: ManagedProviderCatalog<Consumer> }
    | { readonly ok: false; readonly error: unknown };
  let catalog: Promise<Initialization> | undefined;
  let closing: Promise<void> | undefined;
  let closed = false;
  const requireOpen = (): void => {
    if (closed) throw new CatalogDispatchFault("failed", "handler-unavailable");
  };
  const start = (): Promise<Initialization> => {
    const pending: Promise<Initialization> = initialize().then(
      (value) => ({ ok: true, value }),
      (error: unknown) => {
        if (catalog === pending) catalog = undefined;
        return { ok: false, error };
      },
    );
    return pending;
  };
  return {
    toolDefinitions,
    get: async (): Promise<ManagedProviderCatalog<Consumer>> => {
      requireOpen();
      catalog ??= start();
      const admitted = await catalog;
      if (!admitted.ok) throw admitted.error;
      requireOpen();
      return admitted.value;
    },
    close: (): Promise<void> => {
      closed = true;
      closing ??=
        catalog === undefined
          ? Promise.resolve()
          : catalog.then((admitted) => (admitted.ok ? admitted.value.close() : undefined));
      return closing;
    },
  };
}
