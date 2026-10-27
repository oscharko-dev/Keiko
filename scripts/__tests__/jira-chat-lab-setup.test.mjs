import { URL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { applicationProperties, licenseSetup } from "../testing/jira-chat-lab/setup.mjs";

const origin = "http://127.0.0.1:18082";

function coldSetupFixture({ destination, unavailable = false } = {}) {
  const state = { databaseReady: false, applicationSubmissions: 0, licenseVisible: false };
  let url = origin;
  const page = {
    goto: vi.fn(async (target) => {
      if (unavailable) throw new Error("Database setup unavailable");
      // FIRST_RUN is already advertised. Only Jira's normal root entry completes its
      // database setup; direct legacy form GETs can render while the database is unready.
      url = destination ?? `${origin}/secure/SetupDatabase!default.jspa`;
      if (target !== `${origin}/`) throw new Error("Only normal setup entry is supported");
    }),
    waitForURL: vi.fn(async (predicate) => {
      state.databaseReady = true;
      url = `${origin}/secure/SetupApplicationProperties!default.jspa`;
      if (!predicate(new URL(url))) throw new Error("Expected normal application properties");
    }),
    url: () => url,
    locator: () => {
      const locator = {
        fill: vi.fn(async () => undefined),
        check: vi.fn(async () => undefined),
        click: vi.fn(async () => {
          if (!state.databaseReady)
            throw new Error("Database unavailable during application setup");
          state.applicationSubmissions += 1;
          state.licenseVisible = true;
        }),
        first: () => locator,
        waitFor: vi.fn(async () => {
          if (!state.licenseVisible) throw new Error("License form unavailable");
        }),
      };
      return locator;
    },
  };
  return { state, page };
}

describe("synthetic Jira cold setup", () => {
  it("completes normal database readiness before submitting application properties", async () => {
    const { page, state } = coldSetupFixture();
    await applicationProperties(page, { origin });
    expect(state).toEqual({
      databaseReady: true,
      applicationSubmissions: 1,
      licenseVisible: true,
    });
  });

  it.each([`${origin}/secure/WelcomeToJIRA.jspa`, "https://other.example.invalid/setup"])(
    "does not submit or replay setup after a different destination: %s",
    async (destination) => {
      const { page, state } = coldSetupFixture({ destination });
      await expect(applicationProperties(page, { origin })).rejects.toThrow(TypeError);
      expect(state.applicationSubmissions).toBe(0);
      expect(state.licenseVisible).toBe(false);
    },
  );

  it("keeps setup unsubmitted when normal database readiness fails", async () => {
    const { page, state } = coldSetupFixture({ unavailable: true });
    await expect(applicationProperties(page, { origin })).rejects.toThrow(
      "Database setup unavailable",
    );
    expect(state.applicationSubmissions).toBe(0);
  });
});

function licenseWizardFixture({ foreign = false, refusal = false } = {}) {
  const response = { status: 200 };
  const page = {
    url: () => `${origin}/secure/SetupLicense!default.jspa`,
    locator: () => ({ first: () => ({ inputValue: async () => "synthetic-csrf" }) }),
    request: {
      post: vi.fn(async (_url, options) => {
        // This is the existing Jira wizard's submitter. Its fallback license forms
        // do not include it and do not advance the normal first-run wizard.
        response.status = foreign || (Object.hasOwn(options.form, "next") && !refusal) ? 302 : 200;
        return {
          status: () => response.status,
          headers: () => ({
            location: `${foreign ? "https://other.example.invalid" : origin}/secure/SetupAdminAccount!default.jspa`,
          }),
        };
      }),
    },
    goto: vi.fn(async () => undefined),
  };
  return { page, response };
}

describe("synthetic Jira normal license wizard", () => {
  it("submits the real wizard's next control exactly once", async () => {
    const { page, response } = licenseWizardFixture();
    await licenseSetup(page, { origin }, "synthetic-license");
    expect(response.status).toBe(302);
    expect(page.request.post).toHaveBeenCalledTimes(1);
    expect(page.goto).toHaveBeenCalledTimes(1);
  });

  it.each([{ refusal: true }, { foreign: true }])(
    "does not navigate or retry an unconfirmed response %j",
    async (options) => {
      const { page } = licenseWizardFixture(options);
      await expect(licenseSetup(page, { origin }, "synthetic-license")).rejects.toThrow(TypeError);
      expect(page.request.post).toHaveBeenCalledTimes(1);
      expect(page.goto).not.toHaveBeenCalled();
    },
  );
});
