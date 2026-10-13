interface OwnedCycleFrame {
  readonly identity: string;
  readonly parent: string | undefined;
  readonly index: number;
  readonly targets: Iterator<string, undefined>;
}

interface OwnedCycleTraversal {
  readonly connections: ReadonlyMap<string, ReadonlySet<string>>;
  readonly indices: Map<string, number>;
  readonly lowLinks: Map<string, number>;
  readonly active: Set<string>;
  readonly stack: string[];
  readonly frames: OwnedCycleFrame[];
  readonly groups: string[][];
}

function startOwnedCycleFrame(
  identity: string,
  parent: string | undefined,
  state: OwnedCycleTraversal,
): void {
  const index = state.indices.size;
  state.indices.set(identity, index);
  state.lowLinks.set(identity, index);
  state.active.add(identity);
  state.stack.push(identity);
  state.frames.push({
    identity,
    parent,
    index,
    targets: (state.connections.get(identity) ?? new Set<string>()).values(),
  });
}

function inspectOwnedCycleTarget(
  frame: OwnedCycleFrame,
  target: string,
  state: OwnedCycleTraversal,
): void {
  const index = state.indices.get(target);
  if (index === undefined) {
    startOwnedCycleFrame(target, frame.identity, state);
  } else if (state.active.has(target)) {
    state.lowLinks.set(
      frame.identity,
      Math.min(state.lowLinks.get(frame.identity) ?? frame.index, index),
    );
  }
}

function retainOwnedCycleGroup(identity: string, state: OwnedCycleTraversal): void {
  const group: string[] = [];
  while (state.stack.length > 0) {
    const member = state.stack.pop();
    if (member === undefined) break;
    state.active.delete(member);
    group.push(member);
    if (member === identity) break;
  }
  if (group.length > 1 || state.connections.get(identity)?.has(identity) === true)
    state.groups.push(group);
}

function finishOwnedCycleFrame(frame: OwnedCycleFrame, state: OwnedCycleTraversal): void {
  const low = state.lowLinks.get(frame.identity) ?? frame.index;
  if (low === frame.index) retainOwnedCycleGroup(frame.identity, state);
  state.frames.pop();
  if (frame.parent !== undefined) {
    const parent = state.lowLinks.get(frame.parent);
    if (parent !== undefined) state.lowLinks.set(frame.parent, Math.min(parent, low));
  }
}

function traverseOwnedCycles(state: OwnedCycleTraversal): void {
  while (state.frames.length > 0) {
    const frame = state.frames.at(-1);
    if (frame === undefined) break;
    const target = frame.targets.next();
    if (target.done === true) finishOwnedCycleFrame(frame, state);
    else inspectOwnedCycleTarget(frame, target.value, state);
  }
}

/** Request-local analysis of observed OWN edges; definition parent identities stay acyclic. */
export function observedOwnedCallCycles(
  selectedIdentities: readonly string[],
  calls: ReadonlyMap<string, ReadonlySet<string>>,
): readonly (readonly string[])[] {
  const identities = [...new Set(selectedIdentities)];
  const order = new Map(identities.map((identity, index) => [identity, index]));
  const connections = new Map(
    identities.map((identity) => [
      identity,
      new Set([...(calls.get(identity) ?? [])].filter((target) => order.has(target))),
    ]),
  );
  const state: OwnedCycleTraversal = {
    connections,
    indices: new Map(),
    lowLinks: new Map(),
    active: new Set(),
    stack: [],
    frames: [],
    groups: [],
  };
  for (const identity of identities) {
    if (state.indices.has(identity)) continue;
    startOwnedCycleFrame(identity, undefined, state);
    traverseOwnedCycles(state);
  }
  const groups = state.groups.map((group) => {
    const ordered = [...group];
    ordered.sort((left, right) => (order.get(left) ?? 0) - (order.get(right) ?? 0));
    return ordered;
  });
  groups.sort((left, right) => (order.get(left[0] ?? "") ?? 0) - (order.get(right[0] ?? "") ?? 0));
  return groups;
}
