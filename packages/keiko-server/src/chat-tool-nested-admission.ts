import {
  CallerAttemptAdmissionError,
  type GatewayCallRequest,
} from "@oscharko-dev/keiko-model-gateway";

type Admission = NonNullable<GatewayCallRequest["attemptAdmission"]>;
type Reservation = NonNullable<ReturnType<Admission>>;
type AttemptInput = Parameters<Admission>[0];

function narrowedInput(input: AttemptInput, reservation: Reservation): AttemptInput {
  const limit = reservation.maxOutputTokens;
  if (limit === undefined) return input;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > input.maxOutputTokens)
    throw new CallerAttemptAdmissionError("Nested caller output grant must narrow the request");
  return { ...input, maxOutputTokens: limit };
}

function combinedReservation(parent: Reservation, nested: Reservation): Reservation {
  let settled = false;
  return {
    maxOutputTokens: nested.maxOutputTokens ?? parent.maxOutputTokens,
    settle(usage, dispatched, state): void {
      if (settled) return;
      settled = true;
      try {
        nested.settle(usage, dispatched, state);
      } finally {
        parent.settle(usage, dispatched, state);
      }
    },
  };
}

/** A nested model call spends its own grant and the current enclosing caller's grant. */
export function withNestedCallerAdmission(
  request: GatewayCallRequest,
  parent: GatewayCallRequest["attemptAdmission"],
  observeParent?: (reservation: Reservation) => void,
): GatewayCallRequest {
  if (parent === undefined) return request;
  if (parent === request.attemptAdmission && observeParent === undefined) return request;
  const enclosing: Admission = (input) => {
    const reservation = parent(input);
    if (reservation !== undefined) observeParent?.(reservation);
    return reservation;
  };
  const nested = parent === request.attemptAdmission ? undefined : request.attemptAdmission;
  if (nested === undefined) return { ...request, attemptAdmission: enclosing };
  return {
    ...request,
    attemptAdmission: (input): ReturnType<Admission> => {
      const outer = enclosing(input);
      if (outer === undefined) return undefined;
      let inner: Reservation | undefined;
      let accepted = false;
      try {
        const next = narrowedInput(input, outer);
        inner = nested(next);
        if (inner === undefined) return undefined;
        narrowedInput(next, inner);
        accepted = true;
        return combinedReservation(outer, inner);
      } finally {
        if (!accepted) {
          try {
            inner?.settle(undefined, false, "none");
          } finally {
            outer.settle(undefined, false, "none");
          }
        }
      }
    },
  };
}
