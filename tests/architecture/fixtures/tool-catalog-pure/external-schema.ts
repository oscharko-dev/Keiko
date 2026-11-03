// The external-schema owner may import four exact public validator modules, never arbitrary
// package internals. This would bypass its guarded compiler configuration.
import { default as forbidden } from "ajv/dist/compile/index.js";
export const violation = forbidden;
