import { render, screen, within } from "@testing-library/react";
import { axe } from "jest-axe";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import type { CodingWorkbenchNativeActionReview as NativeActionReview } from "@oscharko-dev/keiko-contracts";

import { translateCodingWorkbench, type CodingWorkbenchTranslate } from "./coding-workbench-i18n";
import { loadOptionalWidgetMessages } from "@/lib/optional-widget-i18n";
import {
  CodingWorkbenchNativeActionReview,
  nativeActionLabel,
  nativeActionTitle,
  nativePermissionLabel,
} from "./CodingWorkbenchNativeActionReview";
import styles from "./CodingWorkbenchWindow.module.css";

const en: CodingWorkbenchTranslate = (key, values) => translateCodingWorkbench("en", key, values);
const de: CodingWorkbenchTranslate = (key, values) => translateCodingWorkbench("de", key, values);

function review(action: NativeActionReview, t: CodingWorkbenchTranslate = en): ReactElement {
  return <CodingWorkbenchNativeActionReview action={action} t={t} />;
}

describe("CodingWorkbenchNativeActionReview", () => {
  // #4359 F27: the relayed Jira write read "Native action | jira_jira_create | *". It now reads as
  // Chat's approval of the same write does, from the call and the names the run's reads gave.
  describe("a Jira write of the run's Pod", () => {
    const action: NativeActionReview = {
      permission: "jira_jira_create",
      resources: ["*"],
      jira: {
        tool: "jira.create",
        input: {
          projectId: "10002",
          issueTypeId: "10003",
          fields: { summary: "Workbench-Freigabe Probe 4359", description: "Details" },
        },
        names: {
          projects: [["10002", "Anforderungen (REQ)"]],
          issueTypes: [["10003", "Task"]],
          fields: [],
        },
      },
    };

    it("names the operation, the project by name and key, the issue type and the summary", async () => {
      await loadOptionalWidgetMessages("en");
      render(review(action));

      expect(screen.getByText("Create Jira issue")).toBeInTheDocument();
      expect(screen.getByText("Anforderungen (REQ)")).toBeInTheDocument();
      expect(screen.getByText("Task")).toBeInTheDocument();
      expect(screen.getByText("Workbench-Freigabe Probe 4359")).toBeInTheDocument();
      expect(screen.getByText("Makes exactly this change in Jira, once.")).toBeInTheDocument();
      expect(document.body.textContent).not.toContain("jira_jira_create");
      expect(document.body.textContent).not.toContain("Native action");
      expect(nativeActionTitle(action, en)).toBe("Jira change");
    });

    it("puts the project, the issue type and the summary before a long description", async () => {
      await loadOptionalWidgetMessages("en");
      const { container } = render(
        review({
          ...action,
          jira: {
            ...action.jira!,
            input: {
              fields: { description: "A very long description", summary: "Probe" },
              issueTypeId: "10003",
              projectId: "10002",
            },
          },
        }),
      );
      const text = container.textContent ?? "";
      const order = ["Anforderungen (REQ)", "Task", "Probe", "A very long description"].map(
        (fact) => text.indexOf(fact),
      );
      expect(order.every((position) => position >= 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
    });

    it("keeps the ordinary title for every other native action", () => {
      expect(nativeActionTitle({ permission: "shell", resources: ["npm test"] }, en)).toBe(
        nativePermissionLabel("shell", en),
      );
    });
  });

  // #3897 review: the command rendered collapsed into one line (no pre-wrap), and a long list of
  // resources pushed Approve off screen. Model-selected text keeps its line breaks and scrolls in
  // one bounded, keyboard-focusable block that reuses the commit-message block pattern.
  it("keeps each resource's line breaks inside one bounded, focusable block", () => {
    const command = "npm run build\n  && npm test -- --run\n# done";
    render(review({ permission: "shell", resources: [command, "second command"] }));

    const block = screen.getByRole("list", { name: "Requested command, paths, or addresses" });
    expect(block).toHaveAttribute("tabindex", "0");
    expect(block).toHaveClass(styles["cmp-approval-commit-message"]!);
    const entries = within(block).getAllByRole("listitem");
    expect(entries).toHaveLength(2);
    expect(entries[0]?.textContent).toBe(command);
    expect(entries[1]).toHaveTextContent("second command");
  });

  it("renders a hostile resource as text, never as markup", () => {
    render(review({ permission: "webfetch", resources: ['<img src=x onerror="alert(1)">'] }));

    expect(screen.getByRole("listitem")).toHaveTextContent('<img src=x onerror="alert(1)">');
    expect(document.querySelector("img")).toBeNull();
  });

  it.each([
    ["shell", "Runs this command once in the task workspace."],
    ["edit", "Applies this change to the listed files once."],
    ["write", "Applies this change to the listed files once."],
    ["patch", "Applies this change to the listed files once."],
    ["webfetch", "Internet access exists only in Full access."],
    ["websearch", "Internet access exists only in Full access."],
    ["execute", "Runs this Code Mode program once"],
    ["opencode_worktree_create", "Creates a new task workspace on its own branch"],
    ["external_directory", "Allows exactly this action once."],
  ])("states what approving a %s ask does, per permission", (permission, expected) => {
    render(review({ permission, resources: ["x"] }));

    const help = screen.getByText(new RegExp(expected.replaceAll(".", "\\."), "u"));
    expect(help).toBeInTheDocument();
    // A native ask must never claim its command, prompt or file contents are hidden: the command
    // is the visible subject of the card.
    expect(screen.queryByText(/remain hidden/u)).toBeNull();
  });

  // #3897 review: a Code Mode program asks before it runs; the human reviews its own text, and the
  // help says what approving it can do (script sandbox, loopback only below Full access).
  it("shows a Code Mode program as the reviewed resource with its own help", () => {
    const program = "const files = await tools.opencode.worktree_list({});\nreturn files;";
    const { unmount } = render(review({ permission: "execute", resources: [program] }));
    const block = screen.getByRole("list", { name: "Requested command, paths, or addresses" });
    expect(within(block).getByRole("listitem").textContent).toBe(program);
    expect(screen.getByText(/Code Mode program once in OpenCode's script sandbox/u)).toBeVisible();
    expect(screen.queryByText(/task workspace/u)).toBeNull();
    unmount();
    render(review({ permission: "execute", resources: [program] }, de));
    expect(screen.getByText(/Code-Mode-Programm einmal/u)).toBeVisible();
  });

  // #3903 AC4: a Code Mode worktree is a new managed task workspace the human names and approves.
  // #3907: the permission titles the approval card, so the block itself carries the name and help.
  it("names a new task workspace by its requested name, in both languages", () => {
    expect(nativePermissionLabel("opencode_worktree_create", en)).toBe("New task workspace");
    expect(nativePermissionLabel("opencode_worktree_create", de)).toBe("Neuer Task-Workspace");
    const { unmount } = render(
      review({ permission: "opencode_worktree_create", resources: ["feature-x"] }),
    );
    expect(screen.getByRole("listitem")).toHaveTextContent("feature-x");
    unmount();
    render(review({ permission: "opencode_worktree_create", resources: ["feature-x"] }, de));
    expect(screen.getByText(/neuen Aufgaben-Workspace auf eigenem Branch/u)).toBeVisible();
  });

  it("claims the task workspace only for the shell command, never for web access", () => {
    render(review({ permission: "webfetch", resources: ["https://example.test"] }));

    expect(screen.queryByText(/task workspace/u)).toBeNull();
  });

  // A permission name is model-adjacent text (`[a-z][a-z_]{0,31}`): `constructor` must fall back to
  // the generic wording instead of resolving to an inherited Object member.
  it.each(["constructor", "toString", "hasOwnProperty"])(
    "falls back to the generic wording for the prototype name %s",
    (permission) => {
      render(review({ permission, resources: ["x"] }));

      expect(nativePermissionLabel(permission, en)).toBe("Native action");
      expect(screen.getByText(/Allows exactly this action once/u)).toBeInTheDocument();
    },
  );

  it("localizes the per-permission help and the empty-resource sentence in German", () => {
    const { unmount } = render(review({ permission: "shell", resources: ["ls"] }, de));
    expect(
      screen.getByText(/Führt diesen Befehl einmal im Aufgaben-Workspace aus/u),
    ).toBeInTheDocument();
    unmount();

    render(review({ permission: "shell", resources: [] }, de));
    expect(
      screen.getByText("Weder Befehl noch Pfad noch Adresse wurde genannt."),
    ).toBeInTheDocument();
  });

  it("states that nothing was named instead of rendering an empty block", () => {
    render(review({ permission: "shell", resources: [] }));

    expect(screen.getByText("No command, path, or address was named.")).toBeInTheDocument();
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("has no axe violations with a multi-line command", async () => {
    const { container } = render(
      review({ permission: "shell", resources: ["echo one\necho two", "src/a.ts"] }),
    );

    expect(await axe(container)).toHaveNoViolations();
  });

  it("localizes only the closed native labels and passes anything else through", () => {
    expect(nativeActionLabel("native-shell", en)).toBe("Native shell command");
    expect(nativeActionLabel("native-shell", de)).toBe("Nativer Shell-Befehl");
    expect(nativeActionLabel("constructor", en)).toBe("constructor");
  });
});
