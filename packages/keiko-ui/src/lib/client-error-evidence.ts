// Extends the existing browser diagnostic sink with bounded, body-free runtime evidence.
import { recordClientDiagnosticLoss } from "./client-diagnostics";
import {
  clientErrorClass,
  isClientDiagnosticFrame,
  type ClientErrorEvidence,
} from "@oscharko-dev/keiko-contracts/runtime/diagnostics";

// The two fields this reducer reads from a thrown value it did not build.
interface ThrownFields {
  readonly cause?: unknown;
  readonly stack?: unknown;
}

function thrownFields(value: unknown): ThrownFields | undefined {
  return (typeof value === "object" && value !== null) || typeof value === "function"
    ? value
    : undefined;
}

// Reads from a thrown value are hostile-input reads: an accessor or proxy trap may throw, and a
// throw is counted and degrades to absence.
function safeProperty<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    recordClientDiagnosticLoss("errorsSuppressed");
    return undefined;
  }
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

function safeFrames(fields: ThrownFields | undefined): string[] {
  const stack = safeProperty(() => fields?.stack);
  if (typeof stack !== "string") return [];
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
  let frames = safeFrames(thrownFields(error));
  const causeChain: string[] = [];
  const seen = new Set<unknown>([error]);
  let cause = safeProperty(() => thrownFields(error)?.cause);
  while (cause !== undefined && !seen.has(cause) && causeChain.length < 5) {
    const current = cause;
    seen.add(current);
    causeChain.push(safeClass(current));
    // Prefer the original failing location over wrapper frames when the shared budget fills.
    frames = [...new Set([...safeFrames(thrownFields(current)), ...frames])].slice(0, 8);
    cause = safeProperty(() => thrownFields(current)?.cause);
  }
  return { errorClass: safeClass(error), frames, causeChain };
}
