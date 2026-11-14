// What the gate refuses and what the person is told, graded from Jira and from the PRODUCT's own stored
// refusal, never from the model's prose (#4369). The hard verdict is deterministic: nothing was created
// natively, and the stored tool exchange of the turn carries the product's closed refusal and the
// product's own hint text. Both expectations are derived from the PRODUCER (the built contracts and
// connectors packages), never from a hand-written copy, so a producer that moves cannot leave the
// lab asserting an old value. The model's prose is graded softly and apart: a failure there is a
// MODEL OBSERVATION (status `unverified`, never red) that the scorecard shows as such.
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  askedForApproval,
  isStageExchange,
  namesRule,
  ruleNames,
  soft,
  stepProof,
  succeededWrite,
  writeCalls,
} from "./composer-graders.mjs";
import { templateRefusals } from "./templates.mjs";

const REPO = join(import.meta.dirname, "..", "..", "..", "..");
const { JIRA_TEMPLATE_RULE_IDS } = await import(
  pathToFileURL(join(REPO, "packages/keiko-contracts/dist/jira-issue-template.js")).href
);
const { jiraTemplateViolationGuidance } = await import(
  pathToFileURL(join(REPO, "packages/keiko-connectors/dist/jira-issue-template-check.js")).href
);
const { JIRA_ALREADY_REFUSED_GUIDANCE } = await import(
  pathToFileURL(join(REPO, "packages/keiko-server/dist/atlassian/jiraMutationResult.js")).href
);

/** The closed rule ids that say no template governs a create, as far as THIS build defines them. */
export const PRODUCER_NO_TEMPLATE_RULES = Object.freeze(
  ["template-missing", "template-not-activated"].filter((id) =>
    JIRA_TEMPLATE_RULE_IDS.includes(id),
  ),
);
/** The rule id of a Sub-task created under a parent of a type its template does not allow. */
const PARENT_MISMATCH_RULE = "parent-type-mismatch";
/** The parent types the lab's Sub-task template allows (the template builder takes the same list). */
export const SUBTASK_PARENT_TYPES = Object.freeze(["Task"]);

const producerPorts = {
  noTemplateRules: PRODUCER_NO_TEMPLATE_RULES,
  parentRules: JIRA_TEMPLATE_RULE_IDS.includes(PARENT_MISMATCH_RULE) ? [PARENT_MISMATCH_RULE] : [],
  guidance: jiraTemplateViolationGuidance,
  allRuleIds: JIRA_TEMPLATE_RULE_IDS,
};

/**
 * Nothing was created in Jira by this turn (the native read of new keys only), and the turn showed
 * the gate was asked: it ran to an answer or a call (`stepProof`) AND attempted a write or stored a
 * refusal. An issue that exists is red whatever the turn did; a turn that only talked, stayed silent
 * or failed proves nothing about the gate, so it is `unverified`, never green.
 */
function gradeRefusedNatively({ created, what, turn, exchanges }) {
  if (created.length > 0)
    return {
      status: "red",
      detail: `${created.length} issues were created natively although ${what}: ${created.map((issue) => issue.key).join(", ")}`,
    };
  const proof = stepProof(turn, "the request");
  if (proof !== undefined) return proof;
  const attempted = writeCalls(exchanges).length > 0 || templateRefusals(exchanges).length > 0;
  return attempted
    ? { status: "green", detail: `nothing was created natively (${what}); a write was attempted` }
    : {
        status: "unverified",
        detail: `nothing was created natively (${what}), but no write was attempted and no refusal is stored; the gate was not asked`,
      };
}

/**
 * The stored refusal of the first exchange that names one of `rules`: the union of every violation
 * of that exchange (a draft carries one refusal per failed item), whether the product replayed an
 * earlier refusal, and whether the exchange mixes in item states with guidance of their own.
 */
function storedRefusal(exchanges, rules) {
  const all = templateRefusals(exchanges);
  const [first] = namesRule(all, rules);
  if (first === undefined) return undefined;
  const data = exchanges[first.index]?.result?.data;
  const items = Array.isArray(data?.items) ? data.items : [];
  const violations = all
    .filter((refusal) => refusal.index === first.index)
    .flatMap((refusal) => refusal.violations);
  return {
    refusal: { ...first, violations },
    data,
    replayed: data?.replayed === true || items.some((item) => item?.detail?.replayed === true),
    mixed: items.some(
      (item) =>
        item?.state === "uncertain" ||
        item?.state === "pending" ||
        (item?.state === "failed" && (item.detail?.fieldErrors ?? item.detail?.messages)),
    ),
  };
}

/**
 * The product's own words arrived: the stored `guidance` equals what the producer returns for the
 * union of the exchange's violations. A replayed refusal carries the producer's replay text instead
 * and cannot show the violation guidance: unverified, with the replay text checked. No guidance
 * from the producer for the union, or a mixed draft, is not a green either.
 */
function gradeGuidance(stored, guidance) {
  if (stored.replayed)
    return {
      status: "unverified",
      detail:
        stored.data?.guidance === JIRA_ALREADY_REFUSED_GUIDANCE
          ? "the product replayed an earlier refusal with its own replay text; the violation guidance was shown earlier"
          : "the product replayed an earlier refusal without its own replay text",
    };
  if (stored.mixed)
    return {
      status: "unverified",
      detail: "the draft mixes item states whose guidance outranks the violation guidance",
    };
  const expected = guidance(stored.refusal.violations);
  if (expected === undefined)
    return { status: "unverified", detail: "the producer states no guidance for this refusal" };
  return stored.data?.guidance === expected
    ? { status: "green", detail: "the product's own guidance text is in the stored refusal" }
    : {
        status: "red",
        detail: "the stored refusal does not carry the product's own guidance text",
      };
}

/**
 * Obligation c, hard half: the stored exchange carries the product's closed refusal for a missing
 * template and its own hint. Unverified when the turn stored no write exchange, when the producer
 * defines no such refusal in this build, or when the write failed for another reason.
 */
export function gradeHintDelivered({ exchanges, ports = producerPorts }) {
  const attempts = writeCalls(exchanges);
  if (attempts.length === 0)
    return {
      status: "unverified",
      detail: "no stored write exchange in the turn; nothing to read",
    };
  // The two reds need no producer rule: a card for a write that can never pass, and a write that
  // succeeded although no template governs the type, are wrong in every build.
  // A staging step writes nothing: only a create or a draft commit can show a card for a write.
  const cards = attempts.filter(
    (exchange) => !isStageExchange(exchange) && askedForApproval(exchange),
  ).length;
  if (cards > 0)
    return {
      status: "red",
      detail: `${cards} approval cards were shown for a write that can never pass`,
    };
  if (attempts.some(succeededWrite))
    return {
      status: "red",
      detail: "the write succeeded instead of the closed missing-template refusal",
    };
  if (ports.noTemplateRules.length === 0)
    return {
      status: "unverified",
      detail:
        "the producer of this build defines no missing-template refusal (template-missing / template-not-activated); the expected value cannot be derived",
    };
  const stored = storedRefusal(exchanges, ports.noTemplateRules);
  return stored !== undefined
    ? gradeGuidance(stored, ports.guidance)
    : {
        status: "unverified",
        detail: `a write was attempted, but no stored refusal names ${ports.noTemplateRules.join(" or ")}`,
      };
}

/** A clause that says an issue was created: a creation verb that nothing negates, defers or applies to the template. */
const CREATION = /\b(?:angelegt|erstellt|created)\b/iu;
const NEGATED = /\b(?:nicht|nichts|nie\w*|kein\w*|not|never|no|n't|konnte nicht|unable)\b/iu;
// "Sobald die Vorlage angelegt ist, kann ich ...": the template is what gets created, or it is a later offer or
// an instruction ("Laut Rückmeldung soll diese hier angelegt werden"): none states that the person's issue exists.
const NOT_A_CLAIM =
  /(?:vorlage|template)\W+(?:\w+\W+){0,4}(?:angelegt|erstellt|created)|\b(?:wenn|sobald|danach|falls|nachdem|kann|k(?:ö|oe)nnte|k(?:ö|oe)nnen|w(?:ü|ue)rde|soll(?:en|te)?|muss|m(?:ü|ue)ssen|once|after|if|can|could|would|should|must)\b/iu;
const claimsCreation = (clause) =>
  CREATION.test(clause) && !NEGATED.test(clause) && !NOT_A_CLAIM.test(clause);

/** Obligation c, soft half: the answer mentions the template and does not claim an issue was created. */
export function gradeMentionsTemplate(answer) {
  const text = String(answer ?? "");
  const mentions = /vorlage|template/iu.test(text);
  // Citing an issue key (a parent the model read) states no creation; only a creation clause does.
  const claims = text.split(/[.!?;\n]+/u).some(claimsCreation);
  return soft(
    mentions && !claims,
    mentions
      ? claims
        ? "the answer claims an issue was created"
        : "the answer mentions the template and claims no created issue"
      : "the answer does not mention the template",
  );
}

/** The three obligations of a create without a template: hard, hard, soft. */
export function gradeNoTemplate({ created, exchanges, answer, turn, ports }) {
  return {
    refused: gradeRefusedNatively({
      created,
      what: "no template governs the type",
      turn,
      exchanges,
    }),
    hint: gradeHintDelivered({ exchanges, ports }),
    mentions: gradeMentionsTemplate(answer),
  };
}

/**
 * Unrepairable parent, hard half: nothing created natively is the first obligation; this is the
 * stored refusal: the parent-relation rule, a subject that names the allowed parent type, and the
 * producer's own guidance. (The product's refusal does not name the type that was found.)
 */
export function gradeParentRefusal({
  exchanges,
  allowed = SUBTASK_PARENT_TYPES,
  ports = producerPorts,
}) {
  if (ports.parentRules.length === 0)
    return {
      status: "unverified",
      detail: "the producer of this build defines no parent-type refusal",
    };
  const stored = storedRefusal(exchanges, ports.parentRules);
  if (stored === undefined)
    return {
      status: "unverified",
      detail: `no stored refusal names ${ports.parentRules.join(" or ")}; the gate was not exercised`,
    };
  const subjects = stored.refusal.violations
    .filter((item) => ports.parentRules.includes(item.ruleId))
    .map((item) => String(item.subject ?? ""));
  const names = allowed.every((type) =>
    subjects.some((subject) => subject.toLowerCase().includes(type.toLowerCase())),
  );
  if (!names)
    return {
      status: "red",
      detail: `the stored refusal (${ruleNames([stored.refusal])}) does not name the allowed parent type ${allowed.join(", ")}`,
    };
  return gradeGuidance(stored, ports.guidance);
}

/**
 * A template exists for the type (in whatever words its author wrote it): the product must find it.
 * A stored refusal that names a missing template means the product did not bind the template to the
 * type the person asked for (the type's NAME as the acting user sees it differs from the name the
 * author wrote) and is red; a refusal for a content rule shows it governed the create; an issue
 * created although the request violates the template shows the same silent miss and is red too.
 */
export function gradeTemplateRecognised({ created, exchanges, turn, ports = producerPorts }) {
  const refusals = templateRefusals(exchanges);
  const missing = namesRule(refusals, ports.noTemplateRules);
  if (missing.length > 0)
    return {
      status: "red",
      detail: `the product refused with ${ruleNames(missing)} although a template exists for the type`,
    };
  const governed = refusals.filter(
    (refusal) => !refusal.violations.every((item) => ports.noTemplateRules.includes(item.ruleId)),
  );
  if (governed.length > 0)
    return {
      status: "green",
      detail: `the template governed the create: refused with ${ruleNames(governed)}`,
    };
  if (created.length > 0)
    return {
      status: "red",
      detail: `${created.length} issues were created without any template refusal although the request violates the template: ${created.map((issue) => issue.key).join(", ")}`,
    };
  return (
    stepProof(turn, "the request") ?? {
      status: "unverified",
      detail: "no write was attempted and no refusal is stored; the template was not exercised",
    }
  );
}

/** The own-word parent type: "Teilaufgabe" and "Sub-task" are the request's words, not the answer's. */
const PARENT_TYPE_WORD = /(?<![\p{L}-])(?:aufgaben?|tasks?)(?![\p{L}])/iu;

/** Unrepairable parent, soft half: no bare rule id in the answer, and the parent type is named. */
export function gradeParentAnswer(answer, ports = producerPorts) {
  const text = String(answer ?? "");
  const bare = ports.allRuleIds.filter((id) => text.includes(id));
  if (bare.length > 0)
    return soft(false, `the answer shows the bare machine value ${bare.join(", ")}`);
  return soft(
    PARENT_TYPE_WORD.test(text),
    PARENT_TYPE_WORD.test(text)
      ? "no machine value; the answer names the parent type"
      : "the answer does not name the parent type",
  );
}

/** The two obligations of the unrepairable request, with the native first obligation: hard, hard, soft. */
export function gradeUnrepairable({ created, exchanges, answer, turn, ports, allowed }) {
  return {
    refused: gradeRefusedNatively({
      created,
      what: "the parent type is not allowed",
      turn,
      exchanges,
    }),
    gate: gradeParentRefusal({ exchanges, ports, allowed }),
    plain: gradeParentAnswer(answer, ports),
  };
}
