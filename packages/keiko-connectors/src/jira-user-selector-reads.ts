export interface UserSelectorPrincipal {
  readonly key: string;
  readonly name: string;
}
interface Observed {
  readonly ok: boolean;
  readonly value?: unknown;
}
type ObservedValue<Observation extends Observed> = Extract<
  Observation,
  { readonly ok: true; readonly value: unknown }
>["value"];

/**
 * Reads the same user twice, once by username and once by key. Neither selector is a fallback for
 * the other: the caller decides whether both observations identify the one reviewed principal.
 */
export async function readUserBySelectors<Observation extends Observed>(
  read: (selector: "key" | "username", value: string) => Promise<Observation>,
  expected: UserSelectorPrincipal,
): Promise<
  | Extract<Observation, { readonly ok: false }>
  | {
      readonly ok: true;
      readonly value: readonly [ObservedValue<Observation>, ObservedValue<Observation>];
    }
> {
  const named = await read("username", expected.name);
  if (failed(named)) return named;
  const keyed = await read("key", expected.key);
  if (failed(keyed)) return keyed;
  return { ok: true, value: [valueOf(named), valueOf(keyed)] };
}
function failed<Observation extends Observed>(
  observation: Observation,
): observation is Extract<Observation, { readonly ok: false }> {
  return !observation.ok;
}
function valueOf<Observation extends Observed>(
  observation: Observation,
): ObservedValue<Observation> {
  return observation.value;
}
