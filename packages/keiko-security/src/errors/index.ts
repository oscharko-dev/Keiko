// Barrel for the safe-error taxonomies. Each per-layer error module exports its codes, the abstract
// base class, and the concrete subclasses. The taxonomies are kept in separate sub-modules so
// callers can subpath-import (`@oscharko-dev/keiko-security/errors/gateway`) when they want to pull
// only one layer's error names without dragging the rest in.

export * from "./gateway.js";
export * from "./audit.js";
export * from "./workspace.js";
export * from "./tools.js";
export * from "./harness.js";
export * from "./verification.js";
export * from "./secretbox.js";
