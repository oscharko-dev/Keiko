/**
 * INTENTIONAL ADR-0019 VIOLATION FIXTURE
 *
 * Proves patch writes in harness/workflows cannot bypass keiko-tools.
 */
import { writeFile } from "node:fs/promises";

export const violation = writeFile;
