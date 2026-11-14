// Templates the lab seeds are BOUND the way a person's are (#4354, #4369): the product writes the stable ids
// of Jira's issue types, parent types, required fields and transition targets into a template when its
// author saves it and the bind route resolves it in the AUTHOR's view of the project. The lab therefore
// saves a template through the skill library and then calls POST /api/skills/jira-templates/bind with the
// Pod, the skill and the revision the save returned, as the author's profile (`en_US` for a template an
// English author wrote, even when the German-language session's Pod credential shows German). It never
// writes an id by hand. A build without the route (404) or a binding the product refuses (422: the template
// names what the author's view does not show) leaves the template as saved: the gate then decides on names,
// and a template that the product cannot bind is the very case the later checks look for.
import { withActorLocale } from "../seed-language.mjs";
import { isLocalized } from "./language-names.mjs";

export const BIND_PATH = "/api/skills/jira-templates/bind";
/** The profile of the lab's baseline author: the seed names every type as the administrator sees it. */
export const BASELINE_AUTHOR_LOCALE = "en_US";

/**
 * Binds one saved template; returns the skill to use from now on (the bind writes a new revision) and what
 * happened: `bound`, `unchanged` (already bound), `dead` (bound to a type the project does not have),
 * `absent` (no route in this build) or `refused` (HTTP 422).
 */
export async function bindSavedTemplate(post, podId, skill) {
  const { status, value } = await post(BIND_PATH, {
    podId,
    skillId: skill.id,
    revision: skill.revision,
  });
  if (status === 404) return { skill, outcome: "absent" };
  if (status === 422) return { skill, outcome: "refused" };
  if (status < 200 || status >= 300)
    throw new TypeError(`Binding a template answered HTTP ${String(status)}`);
  if (value?.dead === true) return { skill, outcome: "dead" };
  if (value?.changed !== true) return { skill, outcome: "unchanged" };
  return { skill: value.skill ?? skill, outcome: "bound" };
}

/** Runs `run` under the author's profile: only a localized session needs the switch. */
export function asAuthor(ctx, locale, run) {
  if (locale === undefined || !isLocalized(ctx.language)) return run();
  return (ctx.withActorLocale ?? withActorLocale)(ctx.session, "api", locale, run);
}

/** The Pod a bind is made through: the one the lab's Chats are bound to, read once and kept. */
function podIdReader(ctx, readPod) {
  let podId;
  return async () => {
    podId ??= await readPod(ctx);
    return podId;
  };
}

/** The saved template, bound as its author's profile sees the project (no Pod, no route: as saved). */
export async function bindAfterSave(ctx, skill) {
  const podId = await ctx.templatePodId?.();
  if (podId === undefined || ctx.templateBindPost === undefined) return skill;
  const { skill: bound } = await asAuthor(ctx, ctx.authorLocale, async () => {
    // The profile the Pod account really had while the bind ran, for the result's profile line.
    ctx.lastBindProfile = await ctx.apiLocale?.();
    return bindSavedTemplate(ctx.templateBindPost, podId, skill);
  });
  return bound;
}

const BASELINE_NAME = /baseline/iu;

/**
 * Binds every baseline template of the library once per product start, as the English author who wrote
 * them: without it a German user's write meets a template whose typed type name nobody sees. Idempotent.
 */
export async function bindBaselineTemplates(ctx, listTemplates) {
  if (ctx.baselineBound === true || ctx.templateBindPost === undefined) return 0;
  const podId = await ctx.templatePodId?.();
  if (podId === undefined) return 0;
  const entries = (await listTemplates(ctx.http)).filter((entry) =>
    BASELINE_NAME.test(
      [entry.name, entry.fileName, entry.displayName, entry.title].filter(Boolean).join(" "),
    ),
  );
  let bound = 0;
  await asAuthor(ctx, BASELINE_AUTHOR_LOCALE, async () => {
    for (const entry of entries) {
      const result = await bindSavedTemplate(ctx.templateBindPost, podId, {
        id: entry.id,
        revision: entry.revision,
      });
      if (result.outcome === "bound") bound += 1;
    }
  });
  ctx.baselineBound = true;
  return bound;
}

/**
 * The parts of a journey context that save and bind templates: `http` (a saved template comes back bound),
 * the bind post, the Pod it goes through and the once-per-product baseline binding.
 */
export function templateContext(ctx, { plain, post, readPod, readLocale }) {
  return {
    http: async (name, path, body, method = "POST") => {
      const result = await plain(name, path, body, method);
      return name === "template-import"
        ? { ...result, skill: await bindAfterSave(ctx, result.skill) }
        : result;
    },
    templateBindPost: post,
    apiLocale: readLocale,
    templatePodId: podIdReader(ctx, readPod),
    ensureBaselineBound: () =>
      bindBaselineTemplates(
        ctx,
        async (http) =>
          (await http("template-list", "/api/skills/jira-templates", undefined, "GET")).templates,
      ),
  };
}
