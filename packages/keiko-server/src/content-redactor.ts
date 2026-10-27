import {
  contentRedactionEnabled,
  deepRedactStrings,
  redactContent,
} from "@oscharko-dev/keiko-security";
import { currentRedactionSecrets, type Redactor, type UiHandlerDeps } from "./deps.js";

/** Private conversation content has a deployment policy separate from diagnostics and evidence. */
export function currentContentRedactor(deps: UiHandlerDeps): Redactor {
  if (contentRedactionEnabled()) return deps.redactor;
  const secrets = currentRedactionSecrets(deps);
  return (value: unknown): unknown =>
    deepRedactStrings(value, (text) => redactContent(text, secrets));
}
