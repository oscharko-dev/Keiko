/** The accepted value of a healthy fixture's checked result; a refusal fails the proof. */
export function acceptedValue<T>(
  result: { readonly ok: true; readonly value: T } | { readonly ok: false },
): T {
  if (!result.ok) throw new TypeError("healthy fixture refused");
  return result.value;
}
