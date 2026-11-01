import type { ExpectTypeOf } from "vitest";

type Callable = (...args: never[]) => unknown;

type LibraryInput<F extends Callable> = Parameters<
  Parameters<ExpectTypeOf<F, { positive: true }>["parameters"]["map"]>[0]
>[0][0];

type LibraryOutput<F extends Callable> = Parameters<
  Parameters<ExpectTypeOf<F, { positive: true }>["returns"]["map"]>[0]
>[0];

type MatcherPass<M> = [M] extends [never]
  ? false
  : M extends (...args: infer A) => unknown
    ? [] extends A
      ? true
      : false
    : false;

type LibraryParserTypeFacts<F extends Callable> = readonly [
  MatcherPass<ExpectTypeOf<LibraryInput<F>, { positive: true }>["toBeUnknown"]>,
  MatcherPass<ExpectTypeOf<LibraryInput<F>, { positive: true }>["not"]["toBeAny"]>,
  LibraryOutput<F>,
  MatcherPass<ExpectTypeOf<F, { positive: true }>["returns"]["not"]["toBeAny"]>,
];

export type LibraryParserTripleFacts<
  S extends Callable,
  P extends Callable,
  W extends Callable,
> = readonly [
  ...LibraryParserTypeFacts<S>,
  ...LibraryParserTypeFacts<P>,
  ...LibraryParserTypeFacts<W>,
];

export type LibraryParserTripleExpected<SOutput, POutput, WOutput> = readonly [
  true,
  true,
  SOutput,
  true,
  true,
  true,
  POutput,
  true,
  true,
  true,
  WOutput,
  true,
];

type AcceptedValue<F extends Callable> =
  LibraryOutput<F> extends infer R
    ? R extends { readonly ok: true; readonly value: infer V }
      ? V
      : never
    : never;

type ConcreteFacts<T> = readonly [
  MatcherPass<ExpectTypeOf<T, { positive: true }>["not"]["toBeAny"]>,
  MatcherPass<ExpectTypeOf<T, { positive: true }>["not"]["toBeUnknown"]>,
];

type ResultOk<F extends Callable> =
  LibraryOutput<F> extends infer R ? (R extends { readonly ok: infer O } ? O : never) : never;

type RefusedErrors<F extends Callable> =
  LibraryOutput<F> extends infer R
    ? R extends { readonly ok: false; readonly errors: infer E }
      ? E
      : never
    : never;

/** A checked result: a boolean `ok`, string refusals, and a concrete accepted value. */
export type CheckedResultFacts<F extends Callable> = readonly [
  ResultOk<F>,
  RefusedErrors<F>,
  ConcreteFacts<AcceptedValue<F>>,
];

export type CheckedResultExpected = readonly [boolean, readonly string[], readonly [true, true]];
