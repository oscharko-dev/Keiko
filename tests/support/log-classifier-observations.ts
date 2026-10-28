import { expect, it } from "vitest";

function acceptedClassifierCause(trace: string[], receivers: unknown[]): unknown {
  const prototype = {
    get code(): string {
      trace.push("code");
      receivers.push(this);
      return "ENOSPC";
    },
    get name(): never {
      trace.push("name");
      throw new TypeError("accepted code must short-circuit");
    },
  };
  const cause: unknown = Object.create(prototype);
  return cause;
}

function foreignClassifierCause(trace: string[], receivers: unknown[]): unknown {
  const foreignCode = {
    [Symbol.toPrimitive](): string {
      trace.push("coerce");
      return "ENOSPC";
    },
  };
  const prototype = {
    get code(): typeof foreignCode {
      trace.push("code");
      receivers.push(this);
      return foreignCode;
    },
    get name(): string {
      trace.push("name");
      receivers.push(this);
      return "TypeError";
    },
    get message(): never {
      trace.push("message");
      throw new TypeError("private-classifier-canary");
    },
  };
  const cause: unknown = Object.create(prototype);
  return cause;
}

interface RefusedClassifierInputs {
  readonly callable: () => string;
  readonly hostile: object;
  readonly revoked: { readonly proxy: object };
  readonly callableReads: number;
}

function refusedClassifierInputs(trace: string[]): RefusedClassifierInputs {
  let callableReads = 0;
  const callable = (): string => "unused callable";
  Object.defineProperty(callable, "code", {
    get(): never {
      callableReads += 1;
      throw new TypeError("callable property must remain unread");
    },
  });
  const hostile = new Proxy(
    {},
    {
      get(_target, key): never {
        trace.push(String(key));
        throw new TypeError("private-classifier-canary");
      },
    },
  );
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  return {
    callable,
    hostile,
    revoked,
    get callableReads(): number {
      return callableReads;
    },
  };
}

export function defineClassifierObservationContract(classify: (input: unknown) => string): void {
  it("accepts inherited code once with its original receiver and skips name", (): void => {
    const trace: string[] = [];
    const receivers: unknown[] = [];
    const cause: unknown = acceptedClassifierCause(trace, receivers);
    expect(classify(cause)).toBe("ENOSPC");
    expect(trace).toEqual(["code"]);
    expect(receivers).toHaveLength(1);
    expect(receivers[0]).toBe(cause);
  });

  it("falls back in inherited read order without coercing a foreign code", (): void => {
    const trace: string[] = [];
    const receivers: unknown[] = [];
    const cause: unknown = foreignClassifierCause(trace, receivers);
    expect(classify(cause)).toBe("TypeError");
    expect(trace).toEqual(["code", "name"]);
    expect(receivers).toHaveLength(2);
    expect(receivers[0]).toBe(cause);
    expect(receivers[1]).toBe(cause);
  });

  it("refuses callable properties and contains both throwing and revoked proxies", (): void => {
    const trace: string[] = [];
    const refused = refusedClassifierInputs(trace);
    const { callable, hostile, revoked } = refused;
    expect(classify(callable)).toBe("unknown");
    expect(refused.callableReads).toBe(0);
    expect(classify(hostile)).toBe("unknown");
    expect(trace).toEqual(["code", "name"]);
    expect(classify(revoked.proxy)).toBe("unknown");
  });
}
