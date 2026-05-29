// Package-root boundary: the public surface is the agent harness, the model gateway, and
// the SDK version constant. The harness barrel already re-exports the session/run API the
// SDK surfaces, so we pull SDK_VERSION explicitly and avoid duplicate star re-exports.
export { SDK_VERSION } from "./sdk/index.js";
export * from "./harness/index.js";
export * from "./gateway/index.js";
export * from "./workspace/index.js";
