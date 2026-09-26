// Intentional ADR-0175 violation: catalog compilation has no filesystem capability.
// The existing AST import-policy owner checks core modules even when graph filtering excludes them.
import { readFile } from "node:fs/promises";
export const violation = readFile;
