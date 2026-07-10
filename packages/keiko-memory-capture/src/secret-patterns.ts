// Memory-specific compatibility wrapper over the shared security classifier. Keeping the memory
// return type here preserves its closed rejection vocabulary without duplicating regex families.

import { looksLikeEuDePii, scanSensitiveText } from "@oscharko-dev/keiko-security/sensitive-text";

import type { RejectionReason } from "./errors.js";

export { looksLikeEuDePii };

export function scanForSecrets(
  value: string,
  customerIdentifierMatchers: readonly RegExp[] = [],
): RejectionReason | null {
  return scanSensitiveText(value, customerIdentifierMatchers);
}
