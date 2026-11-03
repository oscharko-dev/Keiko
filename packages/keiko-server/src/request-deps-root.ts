// A request-scoped copy of the composed handler dependencies keeps the identity of the graph it was
// copied from. Caches keyed on dependency identity (the PR-description proposal holders) must key on
// that graph, not on the copy: the copy is discarded when its request settles, so anything a Chat
// turn held under it was unreachable for the later review, approval and apply requests.

const DEPS_ROOT: unique symbol = Symbol("keiko.request-deps-root");

interface RootBound<T> {
  readonly [DEPS_ROOT]?: T;
}

/**
 * Binds a request-scoped copy to the graph it was derived from. The binding is non-enumerable, so a
 * further spread of the copy cannot inherit it; the copy of a copy is bound to the original graph.
 */
export function bindDepsRoot<T extends object>(copy: T, source: T): T {
  Object.defineProperty(copy, DEPS_ROOT, {
    value: depsRoot(source),
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return copy;
}

/** The graph a cache keyed on dependency identity must use: the source of a bound copy, or itself. */
export function depsRoot<T extends object>(deps: T): T {
  return (deps as RootBound<T>)[DEPS_ROOT] ?? deps;
}
