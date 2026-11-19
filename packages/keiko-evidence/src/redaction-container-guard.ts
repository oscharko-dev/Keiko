import { EvidenceWriteError } from "./errors.js";

/**
 * Shared depth-ceiling + cycle guard for both container branches (array/object) of a deep
 * evidence redaction walk. Fails closed with a controlled EvidenceWriteError -- rather than an
 * uncaught RangeError -- when the ceiling is exceeded or `node` is already an ancestor in the
 * current recursion path. `seen` tracks only the current path (added before recursing into
 * children, removed on the way back out), so two independent, non-cyclic references to the same
 * object are not mistaken for a cycle. `label` names the evidence family in the error text.
 */
function guardRedactionContainer(
  label: string,
  node: object,
  depth: number,
  maxDepth: number,
  seen: WeakSet<object>,
  build: () => unknown,
): unknown {
  if (depth >= maxDepth) {
    throw new EvidenceWriteError(`${label} evidence payload exceeds the maximum redaction depth`);
  }
  if (seen.has(node)) {
    throw new EvidenceWriteError(`${label} evidence payload contains a circular reference`);
  }
  seen.add(node);
  try {
    return build();
  } finally {
    seen.delete(node);
  }
}

/**
 * Rebuilds a plain-JSON value with `redactString` applied to every string leaf, under the shared
 * depth ceiling and cycle guard. Objects are rebuilt on a null-prototype seed (KEIKO-0188) so a
 * `__proto__` key from a JSON.parse'd input stays a plain own property instead of silently
 * mutating the reconstructed object's prototype.
 */
export function deepRedactJson(
  label: string,
  value: unknown,
  maxDepth: number,
  redactString: (input: string) => string,
  depth = 0,
  seen = new WeakSet(),
): unknown {
  if (typeof value === "string") {
    return redactString(value);
  }
  const walk = (child: unknown): unknown =>
    deepRedactJson(label, child, maxDepth, redactString, depth + 1, seen);
  if (Array.isArray(value)) {
    return guardRedactionContainer(label, value, depth, maxDepth, seen, () =>
      value.map((item): unknown => walk(item)),
    );
  }
  if (typeof value === "object" && value !== null) {
    return guardRedactionContainer(label, value, depth, maxDepth, seen, () => {
      const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const [key, child] of Object.entries(value)) {
        out[key] = walk(child);
      }
      return out;
    });
  }
  return value;
}
