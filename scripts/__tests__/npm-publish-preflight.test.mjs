import { describe, expect, it } from "vitest";

import {
  artifactDownloadOutcome,
  npmAuthPreflightFailure,
  oidcTrustedPublishingAvailable,
  provenancePublishArgs,
  releaseImpactChildEnv,
  releaseOwnerPublishEnv,
} from "../lib/npm-publish-preflight.mjs";

const OIDC_ENV = {
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.example/exchange",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "runner-issued-value",
};

describe("oidcTrustedPublishingAvailable", () => {
  it("requires BOTH GitHub-issued values — the URL alone cannot mint a token", () => {
    expect(oidcTrustedPublishingAvailable(OIDC_ENV)).toBe(true);
    expect(
      oidcTrustedPublishingAvailable({
        ACTIONS_ID_TOKEN_REQUEST_URL: OIDC_ENV.ACTIONS_ID_TOKEN_REQUEST_URL,
      }),
    ).toBe(false);
    expect(
      oidcTrustedPublishingAvailable({
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: OIDC_ENV.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
      }),
    ).toBe(false);
    expect(oidcTrustedPublishingAvailable({})).toBe(false);
  });

  it("treats empty strings as absent, not as an OIDC provider", () => {
    expect(
      oidcTrustedPublishingAvailable({
        ACTIONS_ID_TOKEN_REQUEST_URL: "",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "",
      }),
    ).toBe(false);
  });
});

describe("provenancePublishArgs", () => {
  it("attests provenance exactly where the OIDC exchange can succeed", () => {
    expect(provenancePublishArgs(OIDC_ENV)).toEqual(["--provenance"]);
    // Outside OIDC the flag would make `npm publish` fail outright (the 0.3.1 outage) —
    // a token publish simply carries no attestation.
    expect(provenancePublishArgs({})).toEqual([]);
  });
});

describe("npmAuthPreflightFailure", () => {
  const failing = () => {
    throw new Error("dot-env must not be read on this path");
  };

  it("passes a dry run without touching any auth source", () => {
    expect(
      npmAuthPreflightFailure({ dryRun: true, env: {}, dotEnvToken: failing }),
    ).toBeUndefined();
  });

  it("accepts OIDC trusted publishing without consulting the dot-env fallback", () => {
    expect(
      npmAuthPreflightFailure({ dryRun: false, env: OIDC_ENV, dotEnvToken: failing }),
    ).toBeUndefined();
  });

  it("accepts each token source in precedence order", () => {
    expect(
      npmAuthPreflightFailure({
        dryRun: false,
        env: { NODE_AUTH_TOKEN: "node-auth" },
        dotEnvToken: failing,
      }),
    ).toBeUndefined();
    expect(
      npmAuthPreflightFailure({
        dryRun: false,
        env: { NPM_TOKEN: "npm-token" },
        dotEnvToken: failing,
      }),
    ).toBeUndefined();
    expect(
      npmAuthPreflightFailure({ dryRun: false, env: {}, dotEnvToken: () => "dot-env-token" }),
    ).toBeUndefined();
  });

  it("refuses a live publish with no auth path before the gate chain runs", () => {
    expect(
      npmAuthPreflightFailure({ dryRun: false, env: {}, dotEnvToken: () => undefined }),
    ).toMatch(/no npm auth path is available/u);
  });

  it("treats an empty token value as absent — it cannot authenticate a publish", () => {
    expect(
      npmAuthPreflightFailure({
        dryRun: false,
        env: { NODE_AUTH_TOKEN: "" },
        dotEnvToken: () => undefined,
      }),
    ).toMatch(/no npm auth path is available/u);
  });
});

describe("releaseOwnerPublishEnv", () => {
  it("refuses when the allowlist did not resolve — the approval verifier would refuse anyway", () => {
    const resolved = releaseOwnerPublishEnv({
      baseEnv: {},
      allowlist: undefined,
      repository: "owner/repo",
    });
    expect(resolved.env).toBeUndefined();
    expect(resolved.failure).toMatch(/release-owner allowlist did not resolve/u);
  });

  it("carries the allowlist and a repository identity into the child environment", () => {
    const resolved = releaseOwnerPublishEnv({
      baseEnv: { EXISTING: "kept" },
      allowlist: "owner-login",
      repository: "owner/repo",
    });
    expect(resolved.failure).toBeUndefined();
    expect(resolved.env.EXISTING).toBe("kept");
    expect(resolved.env.KEIKO_RELEASE_OWNER_GITHUB_LOGINS).toBe("owner-login");
    expect(resolved.env.GITHUB_REPOSITORY).toBe("owner/repo");
  });

  it("never overrides a repository identity the environment already carries", () => {
    const resolved = releaseOwnerPublishEnv({
      baseEnv: { GITHUB_REPOSITORY: "ci/checkout" },
      allowlist: "owner-login",
      repository: "owner/repo",
    });
    expect(resolved.env.GITHUB_REPOSITORY).toBe("ci/checkout");
  });
});

describe("releaseImpactChildEnv", () => {
  const untouchable = {
    gh: () => {
      throw new Error("gh must not run on this path");
    },
    githubRepository: () => {
      throw new Error("the repository must not be resolved on this path");
    },
    loadDotEnvToken: () => {
      throw new Error("dot-env must not be read on this path");
    },
  };

  it("carries the environment unchanged for a plan-only run, resolving nothing", () => {
    const prepared = releaseImpactChildEnv(
      { planOnly: true, dryRun: false },
      { KEPT: "value" },
      untouchable,
    );
    expect(prepared.failure).toBeUndefined();
    expect(prepared.env).toEqual({ KEPT: "value" });
  });

  it("resolves the allowlist through the caller's gh seam and answers the auth question", () => {
    let seen;
    const prepared = releaseImpactChildEnv(
      { planOnly: false, dryRun: false },
      { NPM_TOKEN: "npm-token" },
      {
        gh: (args) => {
          seen = args;
          return { status: 0, stdout: JSON.stringify({ value: "owner-login" }) };
        },
        githubRepository: () => "owner/repo",
        loadDotEnvToken: untouchable.loadDotEnvToken,
      },
    );
    expect(prepared.failure).toBeUndefined();
    expect(seen).toEqual([
      "api",
      "repos/owner/repo/actions/variables/KEIKO_RELEASE_OWNER_GITHUB_LOGINS",
    ]);
    expect(prepared.env.KEIKO_RELEASE_OWNER_GITHUB_LOGINS).toBe("owner-login");
    expect(prepared.env.GITHUB_REPOSITORY).toBe("owner/repo");
    expect(prepared.env.NPM_TOKEN).toBe("npm-token");
  });

  it("prefers the environment-provided allowlist without spawning gh", () => {
    const prepared = releaseImpactChildEnv(
      { planOnly: false, dryRun: true },
      { KEIKO_RELEASE_OWNER_GITHUB_LOGINS: "owner-login" },
      { ...untouchable, githubRepository: () => "owner/repo" },
    );
    expect(prepared.failure).toBeUndefined();
    expect(prepared.env.KEIKO_RELEASE_OWNER_GITHUB_LOGINS).toBe("owner-login");
  });

  it("refuses when the allowlist does not resolve, before any auth question", () => {
    const prepared = releaseImpactChildEnv(
      { planOnly: false, dryRun: false },
      {},
      {
        gh: () => ({ status: 1, stdout: "" }),
        githubRepository: () => "owner/repo",
        loadDotEnvToken: untouchable.loadDotEnvToken,
      },
    );
    expect(prepared.env).toBeUndefined();
    expect(prepared.failure).toMatch(/release-owner allowlist did not resolve/u);
  });

  it("refuses a live publish with no npm auth path after the allowlist resolved", () => {
    const prepared = releaseImpactChildEnv(
      { planOnly: false, dryRun: false },
      { KEIKO_RELEASE_OWNER_GITHUB_LOGINS: "owner-login" },
      {
        ...untouchable,
        githubRepository: () => "owner/repo",
        loadDotEnvToken: () => undefined,
      },
    );
    expect(prepared.env).toBeUndefined();
    expect(prepared.failure).toMatch(/no npm auth path is available/u);
  });
});

describe("artifactDownloadOutcome", () => {
  const clean = { spawnError: undefined, exitStatus: 0, landedBytes: 1024, maxBytes: 4096 };

  it("accepts a clean transfer within the archive ceiling", () => {
    expect(artifactDownloadOutcome(clean)).toEqual({ status: 0 });
  });

  it("refuses a spawn failure, a nonzero exit, and a null exit (timeout kill) alike", () => {
    expect(artifactDownloadOutcome({ ...clean, spawnError: new Error("spawn gh ENOENT") })).toEqual(
      { status: 1 },
    );
    expect(artifactDownloadOutcome({ ...clean, exitStatus: 1 })).toEqual({ status: 1 });
    expect(artifactDownloadOutcome({ ...clean, exitStatus: null })).toEqual({ status: 1 });
  });

  it("refuses landed bytes beyond the portable archive ceiling", () => {
    expect(artifactDownloadOutcome({ ...clean, landedBytes: 4097 })).toEqual({ status: 1 });
    expect(artifactDownloadOutcome({ ...clean, landedBytes: 4096 })).toEqual({ status: 0 });
  });
});
