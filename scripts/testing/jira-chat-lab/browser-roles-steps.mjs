import { ROLE_STEP_CATALOG, ROLE_STEP_IDS } from "./browser-roles-catalog.mjs";
import { projectLeadBuilders } from "./browser-roles-project-lead.mjs";
import { developerBuilders } from "./browser-roles-developer.mjs";
import { techLeadBuilders } from "./browser-roles-tech-lead.mjs";
import { requireRoleFact } from "./browser-roles-oracles.mjs";

export { ROLE_STEP_CATALOG, ROLE_STEP_IDS };
const BUILDERS = {
  projectLead: projectLeadBuilders,
  developer: developerBuilders,
  techLead: techLeadBuilders,
};

/** Build only the next accepted turn: later IDs must come from intervening native readbacks. */
export async function buildRoleStep(environment, role, id) {
  requireRoleFact(Object.hasOwn(BUILDERS, role), "definition-invalid", "turn");
  const meta = ROLE_STEP_CATALOG[role].find((entry) => entry.id === id);
  requireRoleFact(
    meta !== undefined && Object.hasOwn(BUILDERS[role], id),
    "definition-invalid",
    "turn",
  );
  const result = await BUILDERS[role][id](environment, meta);
  requireRoleFact(
    result.wire.length === meta.expectedWrites && result.prompt.trim().length > 0,
    "definition-invalid",
    "turn",
  );
  return result;
}
