/**
 * INTENTIONAL ADR-0019 VIOLATION FIXTURE
 *
 * Proves tools/harness/workflows production code cannot import node:fs directly.
 */
import { readFileSync } from "node:fs";

export const violation = readFileSync;
