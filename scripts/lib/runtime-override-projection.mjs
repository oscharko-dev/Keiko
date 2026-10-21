import { valid } from "semver";
import {
  descriptorIsSatisfied,
  lockfileRecordIdentity,
  manifestRuntimeEdges,
  resolveLockfileEdge,
} from "./runtime-requirements.mjs";

function exactOverride(overrides, requirement, identity) {
  const pin = overrides?.[requirement.name];
  return typeof pin === "string" &&
    valid(pin) === pin &&
    pin === identity.version &&
    !descriptorIsSatisfied(requirement, identity.version)
    ? pin
    : undefined;
}

function addParent(state, child, parent) {
  const parents = state.parents.get(child) ?? new Set();
  parents.add(parent);
  state.parents.set(child, parents);
}

function requiredPaths(state) {
  const required = new Set(state.roots);
  const pending = [...state.roots];
  for (const origin of pending)
    for (const edge of state.children.get(origin) ?? []) {
      if (edge.optional || required.has(edge.target)) continue;
      required.add(edge.target);
      pending.push(edge.target);
    }
  return required;
}

function visitEdge(state, origin, requirement) {
  const target = resolveLockfileEdge(state.packages, origin, requirement.name);
  if (target === undefined) return;
  const entry = state.packages.get(target);
  if (entry?.link === true || entry?.version === undefined) return;
  const identity = lockfileRecordIdentity(target, entry);
  addParent(state, target, origin);
  const edges = state.children.get(origin) ?? [];
  edges.push({ target, optional: requirement.optional === true });
  state.children.set(origin, edges);
  const pin = exactOverride(state.overrides, requirement, identity);
  if (pin !== undefined) {
    if (identity.name !== requirement.name)
      throw new Error("runtime override alias needs an explicit delivery projection");
    state.pins.set(requirement.name, pin);
    state.affected.add(origin);
  }
  if (!state.visited.has(target)) {
    state.visited.add(target);
    state.pending.push(target);
  }
}

function affectedAncestors(state) {
  const pending = [...state.affected];
  for (const current of pending) {
    for (const parent of state.parents.get(current) ?? []) {
      if (state.affected.has(parent)) continue;
      state.affected.add(parent);
      pending.push(parent);
    }
  }
  return [...state.affected].filter((path) => state.visited.has(path));
}

/** Project only reviewed exact flat overrides actually selected by the runtime lockfile graph.
 * Other npm override forms retain their existing owner; this is not another npm resolver. */
export function planRuntimeOverrides(packages, requirements, overrides) {
  const state = {
    packages,
    overrides,
    parents: new Map(),
    pins: new Map(),
    affected: new Set(),
    visited: new Set(),
    pending: [],
    children: new Map(),
    roots: new Set(requirements.flatMap((requirement) => requirement.origins)),
  };
  for (const requirement of requirements)
    for (const origin of requirement.origins) visitEdge(state, origin, requirement);
  for (const origin of state.pending) {
    const entry = packages.get(origin);
    for (const requirement of manifestRuntimeEdges(entry)) visitEdge(state, origin, requirement);
  }
  const required = requiredPaths(state);
  return {
    pins: state.pins,
    ancestors: affectedAncestors(state).map((installPath) => ({
      installPath,
      optional: !required.has(installPath),
      ...lockfileRecordIdentity(installPath, packages.get(installPath)),
    })),
  };
}
