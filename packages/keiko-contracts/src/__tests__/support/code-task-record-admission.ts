import { expect } from "vitest";
import type { CodingWorkbenchValidationResult } from "../../coding-workbench.js";

export function expectCodeTaskRecordAdmission<T extends object>(
  validate: (value: unknown) => CodingWorkbenchValidationResult<unknown>,
  freshInput: () => T,
  selectExtraTarget: (input: T) => object,
  symbolError: string,
  expectedErrors: () => readonly [string, string],
): void {
  const healthy = freshInput();
  const accepted = validate(healthy);
  expect(accepted.ok).toBe(true);
  if (accepted.ok) expect(accepted.value).toBe(healthy);
  const prototypeTrace: string[] = [];
  const inherited = new Proxy(healthy, {
    getPrototypeOf(): object {
      prototypeTrace.push("prototype");
      return { fixtureInherited: true };
    },
    ownKeys(): never {
      throw new TypeError("prototype admission must precede key inspection");
    },
  });
  expect(validate(inherited).ok).toBe(false);
  expect(prototypeTrace).toEqual(["prototype"]);
  const input = freshInput();
  Object.defineProperty(selectExtraTarget(input), "fixtureExtra", { value: true });
  Object.defineProperty(selectExtraTarget(input), Symbol("fixtureExtra"), { value: true });
  const result = validate(input);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(
      result.errors.filter((error) => error.includes("fixtureExtra") || error === symbolError),
    ).toEqual(expectedErrors());
  }
}
