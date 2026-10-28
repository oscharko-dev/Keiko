import type { ExpectTypeOf } from "vitest";

type Callable = (...args: never[]) => unknown;

type LibraryInput<F extends Callable> = Parameters<
  Parameters<ExpectTypeOf<F, { positive: true }>["parameters"]["map"]>[0]
>[0][0];

export type LibraryOutput<F extends Callable> = Parameters<
  Parameters<ExpectTypeOf<F, { positive: true }>["returns"]["map"]>[0]
>[0];

type MatcherPass<M> = [M] extends [never]
  ? false
  : M extends (...args: infer A) => unknown
    ? [] extends A
      ? true
      : false
    : false;

export type LibraryParserTypeFacts<F extends Callable> = readonly [
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
