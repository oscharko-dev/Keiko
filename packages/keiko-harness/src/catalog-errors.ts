import type { HarnessCode } from "./errors.js";
export class HarnessCatalogError extends Error {
  constructor(
    readonly category: HarnessCode,
    message: string,
  ) {
    super(message);
    this.name = "HarnessCatalogError";
  }
}
