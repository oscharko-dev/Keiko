// Extends the existing browser diagnostic sink with bounded, body-free runtime evidence.
import { recordClientDiagnosticLoss } from "./client-diagnostics";
import {
  clientErrorClass,
  isClientDiagnosticFrame,
  type ClientErrorEvidence,
} from "@oscharko-dev/keiko-contracts/runtime/diagnostics";

// The two fields this reducer reads from a thrown value it did not build.
interface ErrorChainFields {
  readonly cause?: unknown;
  readonly stack?: unknown;
}

function errorChainFields(value: unknown): ErrorChainFields | undefined {
  return (typeof value === "object" && value !== null) || typeof value === "function"
    ? value
    : undefined;
}

// Reads from a thrown value are hostile-input reads: an accessor or proxy trap may throw, and a
// throw is counted and degrades to absence.
function safeProperty<T>(read: () => T | undefined): T | undefined {
  try {
    return read();
  } catch {
    recordClientDiagnosticLoss("errorsSuppressed");
    return undefined;
  }
}

function safeStack(error: ErrorChainFields | undefined): string | undefined {
  return safeProperty(() => {
    const stack = error !== undefined && "stack" in error ? error.stack : undefined;
    return typeof stack === "string" ? stack : undefined;
  });
}

// One step of the cause chain. A primitive cause has no cause or stack of its own, so it ends the
// chain and is reduced to its class at once; only an object cause is walked further.
type CauseLink =
  | { readonly kind: "object"; readonly cause: ErrorChainFields }
  | { readonly kind: "primitive"; readonly errorClass: string };

function causeLink(error: ErrorChainFields | undefined): CauseLink | undefined {
  return safeProperty((): CauseLink | undefined => {
    const cause = error !== undefined && "cause" in error ? error.cause : undefined;
    if (cause === undefined) return undefined;
    const fields = errorChainFields(cause);
    return fields === undefined
      ? { kind: "primitive", errorClass: safeClass(cause) }
      : { kind: "object", cause: fields };
  });
}

function safeClass(error: unknown): string {
  try {
    return clientErrorClass(error);
  } catch {
    recordClientDiagnosticLoss("errorsSuppressed");
    return "Error";
  }
}

function frameLocation(line: string): string | undefined {
  const trimmed = line.trim();
  if (trimmed.startsWith("at ")) {
    return trimmed.endsWith(")")
      ? trimmed.slice(trimmed.lastIndexOf("(") + 1, -1)
      : trimmed.slice(3);
  }
  const separator = trimmed.lastIndexOf("@");
  return separator < 0 ? undefined : trimmed.slice(separator + 1);
}

function safeFrame(line: string): string | undefined {
  const location = frameLocation(line);
  if (
    location === undefined ||
    (!location.startsWith("http://") && !location.startsWith("https://"))
  )
    return undefined;
  const coordinates = /:\d{1,8}:\d{1,8}$/u.exec(location);
  if (coordinates === null) return undefined;
  try {
    const url = new URL(location.slice(0, coordinates.index));
    if (url.origin !== globalThis.location.origin || url.search !== "" || url.hash !== "")
      return undefined;
    const frame = `dist/ui/static${url.pathname}${coordinates[0]}`;
    return isClientDiagnosticFrame(frame) ? frame : undefined;
  } catch {
    recordClientDiagnosticLoss("errorsSuppressed");
    return undefined;
  }
}

function safeFrames(error: ErrorChainFields | undefined): string[] {
  const stack = safeStack(error);
  if (stack === undefined) return [];
  return stack
    .slice(0, 16_384)
    .split("\n")
    .slice(0, 64)
    .map(safeFrame)
    .filter((frame) => frame !== undefined)
    .slice(0, 8);
}

/** No raw message, origin, query string, function name or source path leaves this reducer. */
export function clientErrorEvidence(error: unknown): ClientErrorEvidence {
  const root = errorChainFields(error);
  let frames = safeFrames(root);
  const causeChain: string[] = [];
  const seen = new Set<ErrorChainFields | undefined>([root]);
  let link = causeLink(root);
  while (link !== undefined && causeChain.length < 5) {
    if (link.kind === "primitive") {
      causeChain.push(link.errorClass);
      break;
    }
    if (seen.has(link.cause)) break;
    seen.add(link.cause);
    causeChain.push(safeClass(link.cause));
    // Prefer the original failing location over wrapper frames when the shared budget fills.
    frames = [...new Set([...safeFrames(link.cause), ...frames])].slice(0, 8);
    link = causeLink(link.cause);
  }
  return { errorClass: safeClass(error), frames, causeChain };
}
