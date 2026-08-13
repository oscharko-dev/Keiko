import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  publishApprovalPhrase,
  validateReleaseImpactCatalog,
  validateReleaseImpactRoot,
  withGithubResourceReader,
} from "../check-release-impact.mjs";

function rootManifest(overrides = {}) {
  return {
    files: [
      "dist",
      "README.md",
      "LICENSE",
      "NOTICE",
      "TRADEMARKS.md",
      "release-impact.catalog.json",
    ],
    name: "@oscharko-dev/keiko",
    version: "0.2.11",
    ...overrides,
  };
}

function entry(overrides = {}) {
  return {
    affectedStateStores: [],
    defaultPatchNotes: true,
    distTag: "latest",
    id: "2026-06-30-keiko-0.2.11-governed-release-impact-baseline",
    internalOnly: false,
    observableImpact: true,
    oneClickEligible: true,
    packageName: "@oscharko-dev/keiko",
    packageVersion: "0.2.11",
    publishGates: [
      "version-consistency",
      "publish-manifests",
      "release-impact",
      "workspace-supply-chain",
      "package-surface",
      "qi-supply-chain",
      "install-smoke",
    ],
    registry: "https://registry.npmjs.org/",
    releaseNoteBullets: ["Release-impact metadata now governs stable package publication."],
    releaseNoteCategory: "update-notes",
    releaseNotePriority: "normal",
    releaseTag: "v0.2.11",
    remediation: "no-action-required",
    review: {
      approvalReference: "issue:#1690",
      humanApproved: true,
      rationale: "Reviewed for stable publish.",
      reviewedAt: "2026-06-30",
      reviewer: "release-owner",
      status: "reviewed",
    },
    stateImpact: [],
    supportedFrom: ["0.2.0"],
    userActionRequired: false,
    userVisibleChange: "observable",
    userVisibleSummary: "Release-impact metadata is now reviewed before stable publication.",
    ...overrides,
  };
}

function catalog(entries = [entry()]) {
  return { entries, schemaVersion: 1 };
}

function messages(result) {
  return result.failures.join("\n");
}

function writeJson(root, relativePath, value) {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function oldEntry(overrides = {}) {
  return entry({
    id: "2026-05-01-keiko-0.2.10-baseline",
    packageVersion: "0.2.10",
    releaseNoteBullets: ["Earlier stable metadata remains retained."],
    releaseTag: "v0.2.10",
    ...overrides,
  });
}

function releasePublish(args) {
  return spawnSync(process.execPath, ["scripts/release-publish.mjs", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

function withEnv(name, value, callback) {
  const previous = process.env[name];
  process.env[name] = value;
  try {
    return callback();
  } finally {
    if (previous === undefined) {
      Reflect.deleteProperty(process.env, name);
    } else {
      process.env[name] = previous;
    }
  }
}

describe("release-impact governance", () => {
  let tempRoot;

  afterEach(() => {
    if (tempRoot !== undefined) {
      rmSync(tempRoot, { recursive: true, force: true });
      tempRoot = undefined;
    }
  });

  it("accepts reviewed metadata for the current package version", () => {
    const result = validateReleaseImpactCatalog(catalog(), rootManifest());

    expect(result).toEqual({ failures: [], ok: true });
  });

  it("accepts a prerelease package version with a beta dist-tag entry", () => {
    const beta = entry({
      distTag: "beta",
      id: "2026-07-09-keiko-0.2.15-beta.0-fixture",
      oneClickEligible: false,
      packageVersion: "0.2.15-beta.0",
      releaseNoteBullets: ["Beta preview of the governed Coding Workbench autonomy modes."],
      releaseTag: "v0.2.15-beta.0",
    });
    const result = validateReleaseImpactCatalog(
      catalog([entry(), beta]),
      rootManifest({ version: "0.2.15-beta.0" }),
    );

    expect(result).toEqual({ failures: [], ok: true });
  });

  it("rejects a prerelease entry that claims the latest dist-tag", () => {
    const wrongTag = entry({
      id: "2026-07-09-keiko-0.2.15-beta.0-fixture",
      packageVersion: "0.2.15-beta.0",
      releaseTag: "v0.2.15-beta.0",
    });
    const result = validateReleaseImpactCatalog(
      catalog([entry(), wrongTag]),
      rootManifest({ version: "0.2.15-beta.0" }),
    );

    expect(result.ok).toBe(false);
    expect(messages(result)).toContain("distTag must be beta");
  });

  it("rejects a stable entry that claims the beta dist-tag", () => {
    const wrongTag = entry({ distTag: "beta" });
    const result = validateReleaseImpactCatalog(catalog([wrongTag]), rootManifest());

    expect(result.ok).toBe(false);
    expect(messages(result)).toContain("distTag must be latest");
  });

  it("reports missing manifests without throwing", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "keiko-release-impact-"));
    writeJson(tempRoot, "release-impact.catalog.json", catalog());

    const result = validateReleaseImpactRoot(tempRoot);

    expect(result.ok).toBe(false);
    expect(messages(result)).toContain("package.json is missing");
  });

  it("fails closed when published-catalog discovery cannot resolve trusted git", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "keiko-release-impact-"));
    writeJson(tempRoot, "package.json", rootManifest());
    writeJson(tempRoot, "release-impact.catalog.json", catalog());

    expect(() =>
      withEnv("PATH", "relative-bin", () => validateReleaseImpactRoot(tempRoot)),
    ).toThrow("trusted host executable is unavailable: git");
  });

  it("blocks publish when the current package version has no catalog entry", () => {
    const result = validateReleaseImpactCatalog(catalog(), rootManifest({ version: "0.2.12" }));

    expect(result.ok).toBe(false);
    expect(messages(result)).toContain("@oscharko-dev/keiko@0.2.12 has no latest catalog entry");
  });

  it("blocks duplicated default patch-note bullets", () => {
    const duplicate = entry({
      id: "2026-06-30-keiko-0.2.10-duplicate-note",
      packageVersion: "0.2.10",
      releaseTag: "v0.2.10",
    });

    const result = validateReleaseImpactCatalog(catalog([entry(), duplicate]), rootManifest());

    expect(result.ok).toBe(false);
    expect(messages(result)).toContain("duplicates patch note");
  });

  it("allows explicit correction records without editing the original entry", () => {
    const correction = entry({
      correctionOf: "2026-06-30-keiko-0.2.11-governed-release-impact-baseline",
      correctionRationale: "Clarifies the release-note bullet without mutating the original entry.",
      defaultPatchNotes: false,
      id: "2026-06-30-keiko-0.2.11-governed-release-impact-baseline-correction-1",
      releaseNoteBullets: ["Correction: release-impact metadata is source-controlled."],
    });

    const result = validateReleaseImpactCatalog(catalog([entry(), correction]), rootManifest());

    expect(result).toEqual({ failures: [], ok: true });
  });

  it("rejects correction records that reference missing or self ids", () => {
    const missingTarget = entry({
      correctionOf: "missing-entry",
      correctionRationale: "Attempts to correct a missing row.",
      defaultPatchNotes: false,
      id: "2026-06-30-keiko-0.2.11-missing-correction",
      releaseNoteBullets: ["Correction: missing target."],
    });
    const selfTarget = entry({
      correctionOf: "2026-06-30-keiko-0.2.11-self-correction",
      correctionRationale: "Attempts to correct itself.",
      defaultPatchNotes: false,
      id: "2026-06-30-keiko-0.2.11-self-correction",
      releaseNoteBullets: ["Correction: self target."],
    });

    const result = validateReleaseImpactCatalog(
      catalog([entry(), missingTarget, selfTarget]),
      rootManifest(),
    );

    expect(result.ok).toBe(false);
    expect(messages(result)).toContain("correctionOf references unknown id missing-entry");
    expect(messages(result)).toContain("correctionOf must not reference itself");
  });

  it("rejects superseding records that point outside the same package release", () => {
    const result = validateReleaseImpactCatalog(
      catalog([
        entry(),
        oldEntry(),
        entry({
          correctionRationale: "Attempts to supersede a different release.",
          defaultPatchNotes: false,
          id: "2026-06-30-keiko-0.2.11-wrong-release-superseding",
          releaseNoteBullets: ["Correction: wrong release target."],
          supersedes: ["2026-05-01-keiko-0.2.10-baseline"],
        }),
      ]),
      rootManifest(),
    );

    expect(result.ok).toBe(false);
    expect(messages(result)).toContain("supersedes must reference the same package release");
  });

  it("rejects in-place edits or deletions of previously published entries", () => {
    const previousCatalog = catalog([oldEntry()]);
    const changedOldEntry = oldEntry({ userVisibleSummary: "Edited after publication." });

    const changed = validateReleaseImpactCatalog(
      catalog([entry(), changedOldEntry]),
      rootManifest(),
      { previousCatalog },
    );
    const deleted = validateReleaseImpactCatalog(catalog([entry()]), rootManifest(), {
      previousCatalog,
    });

    expect(changed.ok).toBe(false);
    expect(messages(changed)).toContain(
      "published entry 2026-05-01-keiko-0.2.10-baseline changed in place",
    );
    expect(deleted.ok).toBe(false);
    expect(messages(deleted)).toContain(
      "published entry 2026-05-01-keiko-0.2.10-baseline must remain",
    );
  });

  it("requires baseline supported-from coverage", () => {
    const result = validateReleaseImpactCatalog(
      catalog([entry({ supportedFrom: ["0.2.5"] })]),
      rootManifest(),
    );

    expect(result.ok).toBe(false);
    expect(messages(result)).toContain("must include supportedFrom 0.2.0");
  });

  it("requires affected state records to declare remediation", () => {
    const result = validateReleaseImpactCatalog(
      catalog([
        entry({
          affectedStateStores: ["local-knowledge"],
          releaseNoteCategory: "state-or-compatibility-changes",
          remediation: "restart-required",
          stateImpact: [
            {
              description: "Indexes must be rebuilt.",
              store: "local-knowledge",
              userActionRequired: true,
            },
          ],
        }),
      ]),
      rootManifest(),
    );

    expect(result.ok).toBe(false);
    expect(messages(result)).toContain("stateImpact[0].remediation");
  });

  it("requires human approval and carry-forward proof for critical breaking entries", () => {
    const result = validateReleaseImpactCatalog(
      catalog([
        entry({
          breakingException: {
            rationale: "Security patch requires explicit warning.",
            warningText: "Update changes local state compatibility.",
          },
          releaseNoteCategory: "critical-security",
          releaseNotePriority: "critical",
          review: {
            approvalReference: "issue:#1690",
            humanApproved: false,
            rationale: "Pending release-owner review.",
            reviewedAt: "2026-06-30",
            reviewer: "release-owner",
            status: "pending",
          },
        }),
      ]),
      rootManifest(),
    );

    expect(result.ok).toBe(false);
    expect(messages(result)).toContain("must have human release-owner review");
    expect(messages(result)).toContain("cannot be one-click eligible without carry-forward proof");
  });

  it("requires trusted release-owner review and complete stable publish gates", () => {
    const result = validateReleaseImpactCatalog(
      catalog([
        entry({
          publishGates: ["release-impact"],
          review: {
            approvalReference: "issue:#1690",
            humanApproved: true,
            rationale: "Untrusted reviewer should not be enough.",
            reviewedAt: "2026-06-30",
            reviewer: "mallory",
            status: "reviewed",
          },
        }),
      ]),
      rootManifest(),
    );

    expect(result.ok).toBe(false);
    expect(messages(result)).toContain("review.reviewer must be a trusted release owner");
    expect(messages(result)).toContain("must record publish gate version-consistency");
  });

  it("requires external approval references on the publish path", () => {
    const result = withEnv("KEIKO_REQUIRE_RELEASE_APPROVAL_REFERENCE", "1", () =>
      validateReleaseImpactCatalog(catalog([entry()]), rootManifest()),
    );

    expect(result.ok).toBe(false);
    expect(messages(result)).toContain(
      "approvalReference must use github-pr-review:<owner>/<repo>#<pr>#<review> or github-issue-comment:<owner>/<repo>#<issue>#<comment> for publish",
    );
  });

  it("rejects publish approval references outside the current repository", () => {
    const result = withEnv("KEIKO_REQUIRE_RELEASE_APPROVAL_REFERENCE", "1", () =>
      validateReleaseImpactCatalog(
        catalog([
          entry({
            review: {
              approvalReference: "github-pr-review:fake-owner/fake-repo#999999#888888",
              humanApproved: true,
              rationale: "Fake approval must not satisfy publish trust.",
              reviewedAt: "2026-06-30",
              reviewer: "release-owner",
              status: "reviewed",
            },
          }),
        ]),
        rootManifest(),
      ),
    );

    expect(result.ok).toBe(false);
    expect(messages(result)).toContain(
      "approvalReference must reference the current GitHub repository",
    );
  });

  it("rejects issue-comment publish approvals outside the current repository", () => {
    // The owner-directed second evidence form is held to the same strictness as the pr-review
    // form: a comment in a foreign repository can never satisfy publish trust.
    const result = withEnv("KEIKO_REQUIRE_RELEASE_APPROVAL_REFERENCE", "1", () =>
      validateReleaseImpactCatalog(
        catalog([
          entry({
            review: {
              approvalReference: "github-issue-comment:fake-owner/fake-repo#2802#123456",
              humanApproved: true,
              rationale: "Foreign comment approval must not satisfy publish trust.",
              reviewedAt: "2026-06-30",
              reviewer: "release-owner",
              status: "reviewed",
            },
          }),
        ]),
        rootManifest(),
      ),
    );

    expect(result.ok).toBe(false);
    expect(messages(result)).toContain(
      "approvalReference must reference the current GitHub repository",
    );
  });

  describe("issue-comment publish approvals (hermetic, injected GitHub reader)", () => {
    const REFERENCE = "github-issue-comment:oscharko-dev/Keiko#2802#4242";

    function commentEntry() {
      return entry({
        review: {
          approvalReference: REFERENCE,
          humanApproved: true,
          rationale: "Owner-recorded issue-comment approval.",
          reviewedAt: "2026-08-08",
          reviewer: "release-owner",
          status: "reviewed",
        },
      });
    }

    // The fixture phrase derives from the exported production template applied to the entry under
    // validation — never a hand-rebuilt copy that could drift silently (review finding on #3037).
    const approvalPhrase = () => publishApprovalPhrase(commentEntry());

    function approvalComment(overrides = {}) {
      return {
        issue_url: "https://api.github.com/repos/oscharko-dev/Keiko/issues/2802",
        body: approvalPhrase(),
        user: { login: "release-owner-login" },
        ...overrides,
      };
    }

    function validateWith(comment) {
      return withEnv("KEIKO_REQUIRE_RELEASE_APPROVAL_REFERENCE", "1", () =>
        withEnv("KEIKO_RELEASE_OWNER_GITHUB_LOGINS", "release-owner-login", () =>
          withEnv("GITHUB_REPOSITORY", "oscharko-dev/Keiko", () =>
            withGithubResourceReader(
              () => comment,
              () => validateReleaseImpactCatalog(catalog([commentEntry()]), rootManifest()),
            ),
          ),
        ),
      );
    }

    it("accepts a verified owner comment carrying the entry-bound approval phrase", () => {
      const result = validateWith(approvalComment());

      expect(messages(result)).not.toContain("approvalReference");
      expect(result.ok).toBe(true);
    });

    it("rejects a comment that belongs to a different issue", () => {
      const result = validateWith(
        approvalComment({
          issue_url: "https://api.github.com/repos/oscharko-dev/Keiko/issues/999",
        }),
      );

      expect(result.ok).toBe(false);
      expect(messages(result)).toContain(
        "approvalReference comment must belong to the referenced issue",
      );
    });

    it("rejects a comment without the entry-bound approval phrase", () => {
      const result = validateWith(approvalComment({ body: "Looks good to me." }));

      expect(result.ok).toBe(false);
      expect(messages(result)).toContain("approvalReference comment must carry");
      // The demanded phrase binds to the exact entry under validation — package name AND version
      // come from the record being approved, never from a second manifest read.
      expect(messages(result)).toContain(approvalPhrase());
    });

    it("rejects a comment authored outside the release-owner allow-list", () => {
      const result = validateWith(approvalComment({ user: { login: "somebody-else" } }));

      expect(messages(result)).toContain(
        "approvalReference comment author must be an allowed release owner",
      );
    });

    it("fails closed when the comment cannot be read from GitHub", () => {
      const result = validateWith(undefined);

      expect(messages(result)).toContain("approvalReference could not be verified through GitHub");
    });

    it("rejects a comment that only QUOTES the phrase inside a denial", () => {
      // Review finding on #3028: a substring match would read "DO NOT use Approved-for-publish:
      // ..." as an affirmative approval. The phrase must stand on a line of its own.
      const denial = validateWith(approvalComment({ body: `DO NOT use ${approvalPhrase()} yet.` }));
      expect(messages(denial)).toContain("on a line of its own");

      const inline = validateWith(
        approvalComment({ body: `I think ${approvalPhrase()} applies.` }),
      );
      expect(messages(inline)).toContain("on a line of its own");
    });

    it("rejects a phrase that appears only inside a Markdown code fence", () => {
      // Review finding on #3037: a fenced example ("here is what the gate expects") documents
      // the phrase — it never grants the approval. Backtick and tilde fences alike.
      const phrase = approvalPhrase();
      const backtickFenced = validateWith(
        approvalComment({ body: `The gate expects:\n\n\`\`\`\n${phrase}\n\`\`\`` }),
      );
      expect(messages(backtickFenced)).toContain("on a line of its own");

      const tildeFenced = validateWith(approvalComment({ body: `~~~\n${phrase}\n~~~` }));
      expect(messages(tildeFenced)).toContain("on a line of its own");
    });

    it("rejects a mismatched fence delimiter posing as a closer", () => {
      // Review finding on #3037: a fence closes only on the SAME marker at the same-or-greater
      // length (CommonMark) — a `~~~` line inside a backtick fence, or a shorter ``` inside a
      // ```` fence, is fenced CONTENT. Treating either as a closer would let the fenced example
      // that follows it approve a publish.
      const phrase = approvalPhrase();
      const tildeInsideBackticks = validateWith(
        approvalComment({ body: `\`\`\`\n~~~\n${phrase}\n\`\`\`` }),
      );
      expect(tildeInsideBackticks.ok).toBe(false);
      expect(messages(tildeInsideBackticks)).toContain("on a line of its own");

      const shorterInsideLonger = validateWith(
        approvalComment({ body: `\`\`\`\`\n\`\`\`\n${phrase}\n\`\`\`\`` }),
      );
      expect(shorterInsideLonger.ok).toBe(false);
      expect(messages(shorterInsideLonger)).toContain("on a line of its own");
    });

    it("rejects an over-indented closing fence posing as a closer", () => {
      // Review finding on #3037: CommonMark allows at most three columns of indentation before
      // a closing fence — four-plus columns (or a tab) make the would-be closer fenced CONTENT.
      // Trimming before judging closed the fence early and let the column-zero phrase that
      // follows approve while GitHub still renders it inside the fence.
      const phrase = approvalPhrase();
      const overIndentedCloser = validateWith(
        approvalComment({ body: `\`\`\`\n    \`\`\`\n${phrase}\n\`\`\`` }),
      );
      expect(overIndentedCloser.ok).toBe(false);
      expect(messages(overIndentedCloser)).toContain("on a line of its own");

      const tabbedCloser = validateWith(
        approvalComment({ body: `\`\`\`\n\t\`\`\`\n${phrase}\n\`\`\`` }),
      );
      expect(tabbedCloser.ok).toBe(false);
      expect(messages(tabbedCloser)).toContain("on a line of its own");

      // A closer indented up to three spaces IS a closer (CommonMark) — the phrase after the
      // closed fence stands on a plain line and approves.
      const threeSpaceCloser = validateWith(
        approvalComment({ body: `\`\`\`\nexample\n   \`\`\`\n\n${phrase}` }),
      );
      expect(threeSpaceCloser.ok).toBe(true);
    });

    it("rejects a lazy blockquote continuation carrying the phrase", () => {
      // Review finding on #3037 (CommonMark lazy continuation): a non-blank line directly after
      // a "> ..." line still renders INSIDE the blockquote — an instructional quote followed
      // immediately by the phrase must not authorize a publish. A blank line ends the quote, so
      // the same phrase separated by one empty line approves.
      const phrase = approvalPhrase();
      const lazy = validateWith(approvalComment({ body: `> Example approval marker:\n${phrase}` }));
      expect(lazy.ok).toBe(false);
      expect(messages(lazy)).toContain("on a line of its own");

      const separated = validateWith(
        approvalComment({ body: `> Example approval marker:\n\n${phrase}` }),
      );
      expect(separated.ok).toBe(true);
    });

    it("rejects a space-prefixed tab indent as indented code", () => {
      // Review finding on #3037: CommonMark expands a tab to the next 4-column stop, so
      // " \t<phrase>" reaches column 4 exactly like four spaces and renders as indented code —
      // indentation is judged in columns, not characters. Three plain spaces stay a paragraph.
      const phrase = approvalPhrase();
      const spaceTab = validateWith(approvalComment({ body: ` \t${phrase}` }));
      expect(spaceTab.ok).toBe(false);
      expect(messages(spaceTab)).toContain("on a line of its own");

      // STRENGTHENED (review finding on #3037): the marker must start at column zero — ANY
      // leading indentation can be list-item continuation context, so it never approves now.
      const threeSpaces = validateWith(approvalComment({ body: `   ${phrase}` }));
      expect(threeSpaces.ok).toBe(false);
    });

    it("rejects a phrase hidden inside an HTML comment", () => {
      // Review finding on #3037: `<!-- ... -->` renders NOTHING on GitHub — an invisible phrase
      // must never authorize a publish. A real phrase after a CLOSED comment still approves.
      const phrase = approvalPhrase();
      const hidden = validateWith(approvalComment({ body: `<!--\n${phrase}\n-->` }));
      expect(hidden.ok).toBe(false);
      expect(messages(hidden)).toContain("on a line of its own");

      const afterComment = validateWith(
        approvalComment({ body: `<!--\nexample\n-->\n\n${phrase}` }),
      );
      expect(afterComment.ok).toBe(true);
    });

    it("rejects an indented marker in a list item's blank-separated child paragraph", () => {
      // Review finding on #3037: "- Example approval:" + blank line + a two-space-indented
      // marker is a SECOND paragraph inside the same list item. Column-zero anchoring makes the
      // whole indentation class unreachable; the unindented phrase after the list approves.
      const phrase = approvalPhrase();
      const child = validateWith(approvalComment({ body: `- Example approval:\n\n  ${phrase}` }));
      expect(child.ok).toBe(false);

      const plain = validateWith(approvalComment({ body: `- Example approval:\n\n${phrase}` }));
      expect(plain.ok).toBe(true);
    });

    it("rejects a marker nested in a list item, including its lazy continuation", () => {
      // Review finding on #3037: "- To approve, use:" followed by the (indented or lazy)
      // marker keeps the marker inside the list item — only a blank line ends the container.
      const phrase = approvalPhrase();
      const indented = validateWith(approvalComment({ body: `- To approve, use:\n  ${phrase}` }));
      expect(indented.ok).toBe(false);

      const lazy = validateWith(approvalComment({ body: `1. Steps:\n${phrase}` }));
      expect(lazy.ok).toBe(false);

      const afterList = validateWith(approvalComment({ body: `- checklist item\n\n${phrase}` }));
      expect(afterList.ok).toBe(true);
    });

    it("rejects a phrase inside raw-HTML blocks", () => {
      // Review finding on #3037: <pre> renders its content as a code example (blank lines
      // included, until the closing tag); any other "<"-opened block runs to the next blank
      // line. Neither may approve; a phrase after the closed/ended block still approves.
      const phrase = approvalPhrase();
      const pre = validateWith(approvalComment({ body: `<pre>\n${phrase}\n</pre>` }));
      expect(pre.ok).toBe(false);

      const preWithBlank = validateWith(approvalComment({ body: `<pre>\n\n${phrase}\n</pre>` }));
      expect(preWithBlank.ok).toBe(false);

      const divNoBlank = validateWith(approvalComment({ body: `<div>\n${phrase}` }));
      expect(divNoBlank.ok).toBe(false);

      const afterBlock = validateWith(approvalComment({ body: `<div>note</div>\n\n${phrase}` }));
      expect(afterBlock.ok).toBe(true);
    });

    it("rejects a close-then-reopen comment line hiding the phrase", () => {
      // Review finding on #3037: "--> <!--" on one line closes a comment AND opens the next, so
      // the following phrase still renders invisibly — every marker on the line is walked in
      // order. An INLINE comment line leaves no open state: the phrase after it approves.
      const phrase = approvalPhrase();
      const reopened = validateWith(approvalComment({ body: `<!--\nx --> <!--\n${phrase}\n-->` }));
      expect(reopened.ok).toBe(false);
      expect(messages(reopened)).toContain("on a line of its own");

      const inline = validateWith(approvalComment({ body: `<!-- note -->\n\n${phrase}` }));
      expect(inline.ok).toBe(true);

      // Ordering pin: an UNCLOSED comment inside a fence is fenced content — the fence check
      // runs first, so the comment state never opens and the phrase after the fence approves.
      const fencedComment = validateWith(
        approvalComment({ body: `\`\`\`\n<!-- example\n\`\`\`\n\n${phrase}` }),
      );
      expect(fencedComment.ok).toBe(true);
    });

    it("rejects a phrase that appears only inside a blockquote", () => {
      // Review finding on #3037: a quoted line ("> Approved-for-publish: ...") cites the phrase,
      // typically while discussing it — it is not the owner's own standalone statement.
      const result = validateWith(
        approvalComment({ body: `Quoting:\n\n> ${approvalPhrase()}\n\nHm.` }),
      );

      expect(messages(result)).toContain("on a line of its own");
    });

    it("rejects a phrase on a CommonMark indented code line (four spaces or a tab)", () => {
      // Review finding on #3037: a four-space-indented (or tab-indented) line is an indented
      // CODE BLOCK — a documented example, exactly like a fenced one. Trimming before judging
      // erased the indentation and let the example approve a publish.
      const phrase = approvalPhrase();
      const fourSpaces = validateWith(
        approvalComment({ body: `The gate expects:\n\n    ${phrase}` }),
      );
      expect(fourSpaces.ok).toBe(false);
      expect(messages(fourSpaces)).toContain("on a line of its own");

      const tabbed = validateWith(approvalComment({ body: `The gate expects:\n\n\t${phrase}` }));
      expect(tabbed.ok).toBe(false);
      expect(messages(tabbed)).toContain("on a line of its own");
    });

    it("rejects any leading indentation on the marker (strengthened to column zero)", () => {
      // STRENGTHENED relocation of the former three-space paragraph tolerance (review finding
      // on #3037): leading indentation can be list-item continuation context, so the marker
      // must start at column zero. Trailing whitespace stays tolerated.
      const indented = validateWith(approvalComment({ body: `   ${approvalPhrase()}` }));
      expect(indented.ok).toBe(false);

      const trailing = validateWith(approvalComment({ body: `${approvalPhrase()}  ` }));
      expect(trailing.ok).toBe(true);
    });

    it("accepts a real standalone phrase even when a fenced example precedes it", () => {
      // The fence toggles closed again: a documented example above must not poison the owner's
      // actual approval line below it.
      const phrase = approvalPhrase();
      const result = validateWith(
        approvalComment({
          body: `The gate expects:\n\n\`\`\`\n${phrase}\n\`\`\`\n\nAnd here it is for real:\n\n${phrase}`,
        }),
      );

      expect(messages(result)).not.toContain("approvalReference");
      expect(result.ok).toBe(true);
    });

    it("rejects one issue-comment artifact reused by two catalog records", () => {
      // Review finding on #3028: copying an existing owner approval into a newly appended entry
      // would smuggle unreviewed metadata past the gate.
      const second = {
        ...commentEntry(),
        id: "2026-06-30-keiko-0.2.11-second-record",
        defaultPatchNotes: false,
      };
      const result = withEnv("KEIKO_REQUIRE_RELEASE_APPROVAL_REFERENCE", "1", () =>
        withEnv("KEIKO_RELEASE_OWNER_GITHUB_LOGINS", "release-owner-login", () =>
          withEnv("GITHUB_REPOSITORY", "oscharko-dev/Keiko", () =>
            withGithubResourceReader(
              () => approvalComment(),
              () => validateReleaseImpactCatalog(catalog([commentEntry(), second]), rootManifest()),
            ),
          ),
        ),
      );

      expect(messages(result)).toContain(
        "one approval artifact cannot authorize two catalog records",
      );
    });

    it("never re-fetches historical approvals for a past release", () => {
      // Review finding on #3028: GitHub comments are mutable — a later edit or deletion of a
      // historical approval must not brick every future publish of an append-only catalog. Only
      // the release being published NOW is verified live.
      const historical = {
        ...commentEntry(),
        id: "2026-05-01-keiko-0.2.9-historical-record",
        packageVersion: "0.2.9",
        releaseTag: "v0.2.9",
        defaultPatchNotes: false,
        review: {
          ...commentEntry().review,
          approvalReference: "github-issue-comment:oscharko-dev/Keiko#2802#9999",
        },
      };
      const fetchedPaths = [];
      const result = withEnv("KEIKO_REQUIRE_RELEASE_APPROVAL_REFERENCE", "1", () =>
        withEnv("KEIKO_RELEASE_OWNER_GITHUB_LOGINS", "release-owner-login", () =>
          withEnv("GITHUB_REPOSITORY", "oscharko-dev/Keiko", () =>
            withGithubResourceReader(
              (path) => {
                fetchedPaths.push(path);
                return approvalComment();
              },
              () =>
                validateReleaseImpactCatalog(catalog([commentEntry(), historical]), rootManifest()),
            ),
          ),
        ),
      );

      expect(fetchedPaths.some((path) => path.includes("9999"))).toBe(false);
      expect(messages(result)).not.toContain("9999");
      // The CURRENT release's artifact was still verified live.
      expect(fetchedPaths.some((path) => path.includes("4242"))).toBe(true);
    });
  });

  it("requires exception metadata for critical or manual-review one-click updates", () => {
    const result = validateReleaseImpactCatalog(
      catalog([
        entry({
          releaseNoteCategory: "critical-security",
          releaseNotePriority: "critical",
          remediation: "manual-review-required",
          userActionRequired: true,
        }),
      ]),
      rootManifest(),
    );

    expect(result.ok).toBe(false);
    expect(messages(result)).toContain(
      "requires breakingException metadata for critical or manual-review updates",
    );
  });

  it("keeps non-observable internal-only entries out of default patch notes", () => {
    const result = validateReleaseImpactCatalog(
      catalog([
        entry({
          defaultPatchNotes: true,
          internalOnly: true,
          observableImpact: false,
          releaseNoteCategory: "internal-only",
          releaseNotePriority: "internal",
          userVisibleChange: "none",
        }),
      ]),
      rootManifest(),
    );

    expect(result.ok).toBe(false);
    expect(messages(result)).toContain(
      "internal-only metadata must stay out of default patch notes",
    );
  });

  it("requires the bundled root catalog to be included in package files", () => {
    const result = validateReleaseImpactCatalog(
      catalog(),
      rootManifest({ files: ["dist", "README.md"] }),
    );

    expect(result.ok).toBe(false);
    expect(messages(result)).toContain(
      "package.json files must include release-impact.catalog.json",
    );
  });

  it("rejects stable untagged publish and credential-bearing registry URLs", () => {
    const untagged = releasePublish(["--plan-only", "--tag", "latest", "--allow-untagged"]);
    const credentialRegistry = releasePublish([
      "--plan-only",
      "--tag",
      "latest",
      "--registry",
      "https://user:secret@example.invalid/npm/",
    ]);

    expect(untagged.status).toBe(1);
    expect(untagged.stderr).toContain("--allow-untagged cannot be used with --tag latest");
    expect(credentialRegistry.status).toBe(1);
    expect(credentialRegistry.stderr).toContain("registry URL must not include credentials");
    expect(credentialRegistry.stderr).not.toContain("secret");
  });
});
