# Jira Pods are gone after the configuration file moved

| Field             | Value                                                                                        |
| ----------------- | -------------------------------------------------------------------------------------------- |
| Severity          | Medium                                                                                       |
| Surface           | Local UI                                                                                     |
| Stable identifier | UI text "No Jira Pods yet"; Activity Log `atlassian.credential.listed` with `visibleCount=0` |

**Symptom**

The Local Knowledge window and the Chat Connectors menu say "No Jira Pods yet" although Jira Pods
were created and verified earlier. `GET /api/atlassian-connectors/credentials` answers `200` with an
empty `credentials` list, and the Activity Log records `atlassian.credential.listed` with
`visibleCount=0`. No error is shown. A Chat that was bound to a Pod before the change may report that
the Jira Pod is no longer available (`JIRA_POD_UNAVAILABLE`).

**Root Cause**

The Atlassian credential custody (the encrypted tokens, the Pod metadata and, when the key is kept in
a file, its key) lives in a `credentials` folder **beside the configuration file Keiko is using**. It
is not stored in a fixed location. The configuration file in use is the one named by `--config` or
`KEIKO_CONFIG_FILE` when either is set, otherwise `keiko.config.json` in the state directory. When
that setting is added, changed or dropped (an operator moves the configuration, or a start recipe
sets `KEIKO_CONFIG_FILE`), Keiko opens the `credentials` folder beside the **new** file. That folder
holds no Pods, so the list is legitimately empty; the Pods still exist beside the old
configuration. Keiko does not search other folders for a custody and never reads one outside the
configuration directory in use, so nothing in the product can tell an empty custody from one that is
elsewhere.

**Diagnostic Steps**

1. Find the configuration file Keiko was started with. Check the start command or recipe for
   `--config <path>`, then the environment for `KEIKO_CONFIG_FILE`. With neither, the file is
   `keiko.config.json` in the state directory that `keiko start` prints on its `Activity Log:` line
   (the state directory is the folder that contains `logs/`).

   ```bash
   # macOS / Linux: is the variable set for the process that starts Keiko?
   printenv KEIKO_CONFIG_FILE
   ```

   ```powershell
   # Windows PowerShell
   $env:KEIKO_CONFIG_FILE
   ```

2. Look, by name only, for the custody folder beside **that** file and beside the configuration you
   used before (`<config folder>/credentials/`). Do not open or copy the files.

   ```bash
   ls <config folder>/credentials
   ```

   The custody is the pair `atlassian-connector-credentials.metadata.json` and
   `atlassian-connector-credentials.vault`, plus `atlassian-connector-credentials-vault.key` when the
   key is kept in a file instead of the operating system's credential store.

3. Confirm the cause: the folder beside the configuration in use has no such files (or does not
   exist), and the folder beside the earlier configuration has them. If both have them, Keiko is
   showing the Pods of the configuration in use and the earlier set is a separate, unused custody.
   If neither has them, this entry does not apply; consult the
   [Atlassian connector runbook](./atlassian-connector.md).

**Resolution**

1. Stop Keiko.
2. Preferred: start Keiko again with the configuration it used before (the same `--config`,
   `KEIKO_CONFIG_FILE` and state directory). The Pods, their verification state and their Chat
   bindings are back, because nothing was deleted.
3. If the configuration is meant to stay at its new location: with Keiko stopped, copy the **whole**
   `credentials` folder from beside the old configuration to beside the new one, keeping it private to
   your own account (owner-only permissions). Start Keiko and verify each Pod with **Verify
   connection** in Local Knowledge. A Pod that is not verified again is not usable in Chat.
4. Do not recreate the Pods as a workaround and do not edit or merge the custody files: new Pods
   would land in the folder beside the new configuration and leave the old ones hidden, and a
   partial copy can separate a token from its key. Do not copy a custody from another user's or
   another machine's folder.
5. This keeps the existing protection of the tokens: the custody is read only from beside the
   configuration in use, and no step above weakens it. See
   [ADR-0128](../adr/ADR-0128-atlassian-connector-authority-and-security-design.md).
