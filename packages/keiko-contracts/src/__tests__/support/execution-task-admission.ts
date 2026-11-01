import { expect, it } from "vitest";

type CheckedObject =
  | { readonly ok: true; readonly value: object }
  | { readonly ok: false; readonly errors: readonly string[] };

/** Copies `input` onto enumerable getters that record each field read, in order. */
function observedExecutionFields(
  input: Record<string, unknown>,
  reads: string[],
): Record<string, unknown> {
  return Object.defineProperties(
    {},
    Object.fromEntries(
      Object.entries(input).map(([key, value]) => [
        key,
        {
          enumerable: true,
          get: (): unknown => {
            reads.push(key);
            return value;
          },
        },
      ]),
    ),
  );
}

/** Parses observed `fields`, expects the original object back, and returns the field reads. */
export function observedIdentityReads(
  parse: (input: Record<string, unknown>) => CheckedObject,
  fields: Record<string, unknown>,
): readonly string[] {
  const reads: string[] = [];
  const input = observedExecutionFields(fields, reads);
  const result = parse(input);
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.value).toBe(input);
  return reads;
}

type CheckedTaskCatalog =
  | {
      readonly ok: true;
      readonly value: { readonly tasks: readonly { readonly args: readonly string[] }[] };
    }
  | { readonly ok: false; readonly errors: readonly string[] };

/**
 * Parses an observed catalog holding `task`, expects the catalog, task and argument references
 * back, and returns the field reads made during admission.
 */
export function observedCatalogIdentityReads(
  parse: (input: Record<string, unknown>) => CheckedTaskCatalog,
  catalog: object,
  task: { readonly args: readonly string[] },
): readonly string[] {
  const reads: string[] = [];
  const input = observedExecutionFields({ ...catalog, tasks: [task] }, reads);
  const result = parse(input);
  const admissionReads = [...reads];
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value).toBe(input);
    expect(result.value.tasks[0]).toBe(task);
    expect(result.value.tasks[0]?.args).toBe(task.args);
  }
  return admissionReads;
}

export interface TaskCatalogAdmission {
  readonly validate: (input: object) => CheckedObject;
  readonly catalog: () => object;
  readonly task: () => object;
  /** A required task string field and the refusal a non-string value produces. */
  readonly malformed: { readonly field: string; readonly error: string };
}

/** Registers the native-array member cases shared by every execution task catalog. */
export function itAdmitsNativeTaskArrayMembers(admission: TaskCatalogAdmission): void {
  const { validate, catalog, task, malformed } = admission;
  it("rejects malformed tasks despite an own forEach that skips members", () => {
    const tasks = Object.defineProperty([{ ...task(), [malformed.field]: 0 }], "forEach", {
      value: (): void => undefined,
    });
    expect(validate({ ...catalog(), tasks })).toEqual({ ok: false, errors: [malformed.error] });
  });
  it("rejects nonstring arguments despite an own every that claims success", () => {
    const args = Object.defineProperty([1], "every", { value: (): boolean => true });
    expect(validate({ ...catalog(), tasks: [{ ...task(), args }] })).toEqual({
      ok: false,
      errors: ["tasks[0].args must be an array of strings"],
    });
  });
  it("rejects a task hole that cannot satisfy the member contract", () => {
    expect(validate({ ...catalog(), tasks: new Array<unknown>(1) })).toEqual({
      ok: false,
      errors: ["tasks[0] must be an object"],
    });
  });
  it("rejects an argument hole that cannot satisfy the string contract", () => {
    expect(validate({ ...catalog(), tasks: [{ ...task(), args: new Array<unknown>(1) }] })).toEqual(
      { ok: false, errors: ["tasks[0].args must be an array of strings"] },
    );
  });
  it("rejects a nonarray second task observation with the original two reads", () => {
    let reads = 0;
    const input = Object.defineProperty({ ...catalog() }, "tasks", {
      get: (): unknown => (++reads === 1 ? [task()] : { forEach: (): void => undefined }),
    });
    expect(validate(input)).toEqual({ ok: false, errors: ["tasks must be an array"] });
    expect(reads).toBe(2);
  });
}
