export function acceptedClassifierCause(trace: string[], receivers: unknown[]): unknown {
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

export function foreignClassifierCause(trace: string[], receivers: unknown[]): unknown {
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

export function refusedClassifierInputs(trace: string[]): RefusedClassifierInputs {
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
