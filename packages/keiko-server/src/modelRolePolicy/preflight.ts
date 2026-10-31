// The shared preflight of a two-role model policy (Issue #4137): each role is checked in the
// policy's order, one after the other, before anything is saved or started. A role check decides
// its own result (a gateway round trip for Quality Intelligence, the eligibility and admission rule
// for Keiko for Quality) and owns its own cancellation handling; this runner only fixes the order
// and collects every role's result, so no policy can save after checking one role only.

export async function preflightRoles<Role extends string, Result>(
  roles: readonly Role[],
  check: (role: Role) => Promise<Result> | Result,
): Promise<ReadonlyMap<Role, Result>> {
  const results = new Map<Role, Result>();
  for (const role of roles) results.set(role, await check(role));
  return results;
}
