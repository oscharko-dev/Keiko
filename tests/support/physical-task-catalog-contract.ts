import { observeIndexedMembers as observedCatalogMembers } from "./observed-indexed-members.js";
import { expect, it } from "vitest";

interface PhysicalTask {
  readonly id: string;
}
interface PhysicalCatalog {
  readonly tasks: readonly unknown[];
}
type PhysicalCatalogResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly errors: readonly string[] };
export type PhysicalTaskCatalogValidator = (input: unknown) => PhysicalCatalogResult;
type TaskFactory = () => PhysicalTask;
type CatalogFactory = () => PhysicalCatalog;
type ValidatorResolver = (surface: "source" | "public") => Promise<PhysicalTaskCatalogValidator>;
type InspectionAssertion = (
  validate: PhysicalTaskCatalogValidator,
  input: unknown,
  failure: TypeError,
) => void;

function taskWithObservedArgs(
  createTask: TaskFactory,
  kind: string,
  reads: string[],
): Record<string, unknown> {
  const members: unknown[] = kind === "empty" ? [] : ["arg"];
  if (kind === "invalid") {
    members[0] = 0;
    members.push("unvisited");
  }
  if (kind === "sparse" || kind === "inherited") {
    expect(Reflect.deleteProperty(members, "0")).toBe(true);
  }
  if (kind === "inherited") Object.setPrototypeOf(members, ["arg"]);
  let lengthReads = 0;
  const observed = new Proxy(members, {
    get(target, key, receiver): unknown {
      if (key === "length") {
        reads.push("length");
        lengthReads += 1;
        if (lengthReads > 1) throw new TypeError("argument extent must be captured once");
      }
      if (key === "0") reads.push("0");
      if (key === "1") throw new TypeError("argument admission must stop at its first failure");
      return Reflect.get(target, key, receiver);
    },
    has(): never {
      throw new TypeError("argument admission must retain native indexed observation");
    },
  });
  let argsReads = 0;
  return {
    ...createTask(),
    get args(): unknown {
      reads.push("args");
      argsReads += 1;
      if (argsReads > 1) throw new TypeError("arguments must be captured once");
      return kind === "non-array" ? 0 : observed;
    },
  };
}

function registerArgumentAdmission(
  createTask: TaskFactory,
  createCatalog: CatalogFactory,
  resolveValidator: ValidatorResolver,
): void {
  it.each(["source", "public"] as const)(
    "retains physical argv admission through %s",
    async (surface) => {
      const validate = await resolveValidator(surface);
      for (const kind of ["healthy", "empty", "invalid", "sparse", "inherited", "non-array"]) {
        const reads: string[] = [];
        const input = {
          ...createCatalog(),
          tasks: [taskWithObservedArgs(createTask, kind, reads)],
        };
        const result = validate(input);
        if (kind === "invalid" || kind === "sparse" || kind === "non-array") {
          expect(result).toEqual({
            ok: false,
            errors: [
              kind === "non-array"
                ? "tasks[0].args must be an array"
                : "tasks[0].args must be an array of strings",
            ],
          });
        } else {
          expect(result.ok).toBe(true);
          if (result.ok) expect(result.value).toBe(input);
        }
        expect(reads).toEqual(
          kind === "non-array"
            ? ["args"]
            : kind === "empty"
              ? ["args", "length"]
              : ["args", "length", "0"],
        );
      }
    },
  );
}

function registerNonarrayObservation(
  domain: "Command" | "Container",
  createCatalog: CatalogFactory,
  resolveValidator: ValidatorResolver,
): void {
  it.each(["source", "public"] as const)(
    `${domain} catalog stops after a nonarray first task observation through %s`,
    async (surface) => {
      const validate = await resolveValidator(surface);
      let reads = 0;
      const input = Object.defineProperty({ ...createCatalog() }, "tasks", {
        get: (): unknown => {
          reads += 1;
          if (reads > 1) throw new TypeError("Unexpected second task observation");
          return null;
        },
      });
      expect(validate(input)).toEqual({ ok: false, errors: ["tasks must be an array"] });
      expect(reads).toBe(1);
    },
  );
}

function registerCapturedExtent(
  domain: "Command" | "Container",
  createTask: TaskFactory,
  createCatalog: CatalogFactory,
  resolveValidator: ValidatorResolver,
): void {
  it.each(["source", "public"] as const)(
    `${domain} catalog validates the second array with one captured extent through %s`,
    async (surface) => {
      const validate = await resolveValidator(surface);
      const reads: string[] = [];
      const task = createTask();
      const members: unknown[] = [task];
      Object.defineProperty(members, "0", {
        get: (): typeof task => {
          members.push(null);
          return task;
        },
      });
      const second = observedCatalogMembers(members, reads);
      const first = new Proxy([], {
        get: (): never => {
          throw new TypeError("The first array must not be inspected");
        },
      });
      let observations = 0;
      const input = Object.defineProperty({ ...createCatalog() }, "tasks", {
        get: (): unknown => {
          reads.push("tasks");
          observations += 1;
          return observations === 1 ? first : second;
        },
      });
      const result = validate(input);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe(input);
      expect(reads).toEqual(["tasks", "tasks", "get:length", "has:0", "get:0"]);
      expect(members).toHaveLength(2);
    },
  );
}

function registerEarlyHole(
  domain: "Command" | "Container",
  createCatalog: CatalogFactory,
  resolveValidator: ValidatorResolver,
): void {
  it.each(["source", "public"] as const)(
    `${domain} catalog stops at the first hole before later getters through %s`,
    async (surface) => {
      const validate = await resolveValidator(surface);
      const reads: string[] = [];
      const members = new Array<unknown>(2);
      Object.defineProperty(members, "1", {
        get: (): never => {
          throw new TypeError("A later task getter must remain unread");
        },
      });
      const input = { ...createCatalog(), tasks: observedCatalogMembers(members, reads) };
      expect(validate(input)).toEqual({ ok: false, errors: ["tasks[0] must be an object"] });
      expect(reads).toEqual(["get:length", "has:0"]);
    },
  );
}

function registerInspectionPolicy(
  domain: "Command" | "Container",
  createTask: TaskFactory,
  createCatalog: CatalogFactory,
  resolveValidator: ValidatorResolver,
  assertInspection: InspectionAssertion,
): void {
  it.each(["source", "public"] as const)(
    `${domain} catalog continues after an invalid present task and retains inspection policy through %s`,
    async (surface) => {
      const validate = await resolveValidator(surface);
      const reads: string[] = [];
      const failure = new TypeError("fixture-member-inspection");
      const task = Object.defineProperty(createTask(), "id", {
        get: (): never => {
          throw failure;
        },
      });
      const input = { ...createCatalog(), tasks: observedCatalogMembers([null, task], reads) };
      assertInspection(validate, input, failure);
      expect(reads).toEqual(["get:length", "has:0", "get:0", "has:1", "get:1"]);
    },
  );
}

export function registerPhysicalTaskCatalogContract(
  domain: "Command" | "Container",
  createTask: TaskFactory,
  createCatalog: CatalogFactory,
  resolveValidator: ValidatorResolver,
  assertInspection: InspectionAssertion,
): void {
  registerArgumentAdmission(createTask, createCatalog, resolveValidator);
  registerNonarrayObservation(domain, createCatalog, resolveValidator);
  registerCapturedExtent(domain, createTask, createCatalog, resolveValidator);
  registerEarlyHole(domain, createCatalog, resolveValidator);
  registerInspectionPolicy(domain, createTask, createCatalog, resolveValidator, assertInspection);
}
