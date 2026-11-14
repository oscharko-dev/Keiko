# Jira Pod Release 1: acceptance walk

This page is the procedure for the human acceptance of Release 1 of epic #4351 (child #4359). A
person walks the ordinary Keiko UI against a real Jira Data Center, on macOS and on Windows, and
fills the trace table in section 4. Nothing here is automated; the walk is the evidence.

| Field               | Value                                                    |
| ------------------- | -------------------------------------------------------- |
| Build under test    | _release artifact name and git head, filled at the walk_ |
| Model               | _filled at the walk_                                     |
| Jira version        | _filled at the walk_                                     |
| Walker (macOS)      | _filled at the walk_                                     |
| Walker (Windows)    | _filled at the walk_                                     |
| Independent auditor | _filled at the walk_                                     |

**Last checked against integration head `a60fe469a`** (`feat/jira-pod-release-1`, 2026-11-14). The
write-path steps (W06 to W13 and W19) are written against the product texts of that head. Texts that
come from a catalog are quoted as the catalog has them; a sentence the model says (for example the
notice on an edit) is described in words, because the model words it.

The build must be one that contains the whole Release 1 scope: the template rule for Jira writes
(#4354), attachments switched off, the connection and credential repairs (#4353), the Windows
install notice and hand-over (#4358), the two-hour browser session (#4370), the Release 1 lab
fixtures (#4369) and the model tool-calling check (#4351 model compatibility). Record the head; a
walk on a build that lacks one of them proves nothing about it.

## 1. Scope in five lines

1. **Release 1 promises** that a person creates and changes Epics, Stories or Tasks, Sub-tasks and
   Bugs in Jira from the composer in Chat and in the Coding Workbench.
2. **Create** needs a governing template and must conform to it fully; with no template it is
   refused with a hint to create one. **Edit** works on any issue and never makes it worse; a rule
   the issue already broke in a field the edit does not touch is reported as a notice, not a refusal.
3. **A status change is free** (only an explicit entry rule of a template applies). **Comments and
   watchers are never checked** against a template. **Attachments are off** in this release.
4. **The template rule is the same in all three modes**: **Ask for approval**, **Supervised
   workspace** and **Full access** differ only in whether the person approves the concrete action.
5. **It does not promise** the path that turns a requirements document or a Knowledge Pod into Jira
   issues, nor a report of requirement coverage from a document; that path is Release 2.

## 2. Prerequisites

### 2.1 Keiko

- A **clean installation from the release artifact**, not from a source checkout, with an empty state
  folder (`~/.keiko` on macOS, `%USERPROFILE%\.keiko` on Windows).
- **The operating-system credential store is on.** On macOS leave `KEIKO_OS_KEYCHAIN` unset: the
  walk must use the login keychain. The value `off` is for laboratory runs only and makes a keyfile
  hold the key; a walk with `off` does not count for AC10. On Windows the credential key is held in
  a keyfile whose protection Keiko checks; there is no Windows credential-store tier in this release.
- The browser you walk in is opened by Keiko itself (launcher or `npx keiko start`), so the session is
  paired. Do not copy a pairing address into another browser.

### 2.2 A Jira Data Center

- Jira Data Center **10.3.0 or later**, reached over HTTPS, with a project for each of the four types.
  For a private certificate authority set `KEIKO_CA_BUNDLE_PATH` to its PEM file and restart Keiko;
  never turn certificate verification off.
- **A personal access token (PAT)** of the user Keiko acts as. In Jira's own UI (the menu names depend
  on the Jira version): profile menu → **Profile** → **Personal Access Tokens** → **Create token**; copy
  the token once, it is not shown again.
- **Jira permissions of that user: at least what the laboratory's working account has.** In the
  project: Browse Projects, Create Issues, Edit Issues, Assign Issues, Assignable User, Add Comments,
  Edit Own Comments, Transition Issues, Link Issues, Manage Watchers and View Voters and Watchers
  (the keys are `BROWSE_PROJECTS`, `CREATE_ISSUES`, `EDIT_ISSUES`, `ASSIGN_ISSUES`, `ASSIGNABLE_USER`,
  `ADD_COMMENTS`, `EDIT_OWN_COMMENTS`, `TRANSITION_ISSUES`, `LINK_ISSUES`, `MANAGE_WATCHERS`,
  `VIEW_VOTERS_AND_WATCHERS`; source: `scripts/testing/jira-chat-lab/seed-permissions.mjs`). A user
  with fewer permissions makes Jira refuse the write; that refusal is Jira's answer, not a defect.
- A contributor without such a Jira sets up the repository's laboratory. It holds synthetic data
  only and is described in `scripts/testing/jira-chat-lab/README.md`; read its sections on starting
  an isolated session and on seeding before you begin. From a built checkout, one command per line:

```bash
npm install
npm run build:packages
node scripts/testing/jira-chat-lab/session.mjs init "$HOME/.local/share/keiko-jira-acceptance"
node scripts/testing/jira-chat-lab/session.mjs start "$HOME/.local/share/keiko-jira-acceptance"
node scripts/testing/jira-chat-lab/setup.mjs "$HOME/.local/share/keiko-jira-acceptance" /absolute/private/test-license
node scripts/testing/jira-chat-lab/seed.mjs "$HOME/.local/share/keiko-jira-acceptance"
node scripts/testing/jira-chat-lab/preflight.mjs "$HOME/.local/share/keiko-jira-acceptance"
```

- The lab uses Docker Compose, OpenSSL and a headless Chromium for the first-run forms. The licence
  file is Atlassian's published test licence, kept by you in a private file outside the repository;
  it lasts **three hours**, so do each group of steps inside one such window and repeat a group that
  outlived it. Never change a clock or licence data. Stop a session with `session.mjs stop <directory>`.
- The lab listens on loopback only (HTTP 18081 and HTTPS 18443 by default) and its certificate names
  `localhost` and `127.0.0.1` only. Its CA and server certificate last 365 days, and `session.mjs start`
  renews them when seven days or less remain. Trust its `secrets/tls/ca.pem` through
  `KEIKO_CA_BUNDLE_PATH`.
  Its fixture tokens expire one day after creation; an "authentication failed" after that is Jira's
  answer, not a defect. Everything under the session's `secrets/` directory except `ca.pem` is secret:
  type a token into Keiko by hand and never put one into an issue, a log or a screenshot.
- The German-language run (step W15) needs a lab Jira whose session language is German; the lab
  carries a seed for that.

### 2.3 Templates and model

- **One template per issue type** under test (Epic, Story or Task, Sub-task, Bug) in the project you
  walk in. Step W06 creates them; the lab's baseline templates may be used instead.
- **One model.** For the binding walk use the local reference model through the gateway. A second walk
  with an OpenAI model is the functional pre-pass: it finds problems of the walk early and does not
  replace the walk on the reference model. Run the model's readiness check first (section 6).

## 3. The walk

Do the steps in order inside one clean installation. Where macOS and Windows differ, the step says so;
otherwise the steps are identical. **Do** is what you do in the UI; **Expect** is what you must see;
**Jira** is the check in Jira's own UI (or its issue search) that the UI did not lie; **Proves** names
the epic criterion (AC) and the step of #4359 the step carries.

The #4359 walk steps and conditions that the **Proves** lines refer to (the issue's own numbering and
wording, first words quoted):

| Reference   | First words in #4359                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------- |
| step 1      | "Create and connect a Jira Pod, and index. Confirm in Chat which user and which instance…"              |
| step 2      | "A project lead defines and activates Epic, Task and Bug templates. Violations are refused…"            |
| step 4      | "A technical lead creates Tasks, Bugs and Sub-tasks with the intended relations (AC4)."                 |
| step 5      | "Everyday edits from the composer: comment, add a watcher, edit a comment, link two issues…"            |
| step 6      | "A project lead gets the progress and compliance report. Its totals equal an independent JQL readback…" |
| step 7      | "Reload and interruption never duplicate a write, for issues created from the composer (AC8)."          |
| step 8      | "Results are readable in English and German, accessible, and persist across reload (AC9)."              |
| two hours   | "One browser session of at least two hours with reloads needs no re-pairing."                           |
| German Jira | "Run the core steps 4 to 6 once against the German-language lab Jira."                                  |
| Workbench   | "The Jira Pod inside a Coding Workbench run is walked once and its result recorded…"                    |

Step 3 and the attachment part of step 5 moved to Release 2 and are not walked.

Windows differences, once, for all steps: install with `keiko-windows-x64-setup.exe` or
`keiko-windows-x64.zip`; SmartScreen asks once (**More info → Run anyway**); the first start can take
minutes and shows no window until the browser opens; the Coding Workbench is not available on Windows,
so step W21 is macOS only; run commands in PowerShell, one per line.

### W01 Install and start

- **Do:** macOS: unzip `keiko-macos-arm64.zip` (or `keiko-macos-x64.zip`), open `Keiko.app`; if macOS
  refuses, **System Settings → Privacy & Security → Open Anyway**. Windows: run the setup or open
  `Keiko.exe` from the extracted ZIP. Note how long the first start takes.
  The npm route (a Node.js `>=24.18.0 <25 || >=26.3.0 <27` is required; the desktop packages bring
  their own) is not the release artifact, but if you use it, run the lines one at a time. Windows
  PowerShell 5.1 does not accept `&&`:

  ```powershell
  mkdir keiko
  cd keiko
  npm init -y
  npm install @oscharko-dev/keiko
  npx keiko start
  ```

- **Expect:** the browser opens Keiko at `http://127.0.0.1:1983` without a pairing step.
- **Jira:** not applicable.
- **Proves:** AC10 (a clean install runs on the platform); #4359 step 1.

### W02 Create the Jira Pod and confirm user and instance

- **Do:** open **Local Knowledge**, section **Jira Live Pods**, select **Create Jira Pod**. Enter a
  **Label**, the **Base URL** (HTTPS, with any context path) and the **API token**, then select
  **Create Jira Pod** once. Then ask in a Chat which Jira account you are connected as (Keiko answers
  through "Read the current Jira account"). Jira Pods are created only here, under **Local
  Knowledge**, section **Jira Live Pods**; **Manage** in the Chat's **Connectors** menu leads to the
  same place by design. Without a configured model the workspace stays behind **Model gateway
  setup**: finish that first.
- **Expect:** the form shows **Verifying…** and closes; the Pod card shows **Connection verified** and
  the status **Ready**. The Pod card itself shows no user: the account is read in Chat. The answer
  names the user and instance you expect.
- **Jira:** the named user exists on that instance.
- **Proves:** AC10 (credential custody and TLS trust on the platform); #4359 step 1.

### W03 Connect the Pod to a Chat

- **Do:** in the composer open **Connectors**, switch the Pod on under **Jira Pods**, and look at
  **Access**.
- **Expect:** the trigger reads **Connectors: 1 active**; **Access** offers **Ask for approval**,
  **Supervised workspace** and **Full access**, and shows the effective mode the deployment allows.
- **Jira:** not applicable.
- **Proves:** AC1, AC4 (precondition); #4359 step 1.

### W04 Restart without entering the token again

- **Do:** stop Keiko (`npx keiko stop`, or close the app) and start it again from the launcher.
- **Expect:** if the browser asks, **Connect this browser** appears with **Connect browser**; one click
  reconnects and the open chat and its draft are kept. The Pod still shows **Connection verified** or
  **Ready**; no token is asked for. A Pod that asks for **Verify connection** after a restart is a finding.
- **Jira:** not applicable.
- **Proves:** AC8, AC10 (the credential survives a restart on the platform).

### W05 The two-hour session

- **Do:** keep one paired browser open for two hours. Reload it at about 25, 50, 70, 90, 110 and 120
  minutes, and send a message in the Chat at least every 25 minutes.
- **Expect:** no re-pairing and no **Connect this browser** dialog. (A browser left idle longer than
  30 minutes with no message and no reload is expected to need **Connect browser**; do not count that.)
- **Jira:** not applicable.
- **Proves:** AC8; #4359 "two hours".

### W06 Define and save one template per issue type

- **Do:** in the Chat open **Skills**, group **Jira templates**. Choose the Jira Pod, enter the
  **Project key**, select **Propose from project**. For each proposal select **Open in editor**,
  review it, and select **Save**. Repeat until each of the four types has a template. A template that
  governs creation lists `create` in its `activateOn`.
- **Expect:** each proposal shows **Matches Jira.**; a template that does not match shows **Needs
  repair**. A saved template appears in the group.
- **Jira:** the project and issue types named in the templates exist.
- **Proves:** epic AC1; #4354 "A Task or Sub-task template validates the actual parent relation of
  the instance"; #4359 step 2.

### W06a A template for a project Jira does not have

- **Do:** save a template whose `project` names a key that the connected Jira does not have (or that
  this account cannot see), then look at its check line in **Jira templates**.
- **Expect:** the template is marked **Not applied:** with the reason "Project {subject} does not
  exist or is not visible."; it is never silently ignored.
- **Jira:** the project key does not exist, or the account cannot browse it.
- **Proves:** epic AC1; #4354 "Templates that name a project the target Jira does not have produce a
  visible message."

### W07 A violating create is refused, in all three modes

- **Do:** for each of **Ask for approval**, **Supervised workspace** and **Full access**, ask Keiko to
  create an issue that breaks a rule (for example a summary below the template's minimum, or a missing
  required section).
- **Expect:** the result card shows **Template rules not met** and one line per rule, for example
  "The summary is too short." or "The description lacks the section “{subject}”." In **Ask for
  approval** and **Supervised workspace** no **Review Jira action** card appears, because a request
  that would be refused is never put to the person. In **Full access** nothing was asked either. Keiko
  tells you what to change and, when you agree, creates the corrected issue without you repairing the
  draft by hand.
- **Jira:** search the project: no issue was created by the refused request.
- **Proves:** epic AC1; #4354 "In all three autonomy modes a violating write is refused before any
  effect, and the corrected write satisfies the saved rules" and template rule 1; #4359 step 2.

### W08 A create with no governing template is refused with a hint

- **Do:** ask Keiko to create an issue of a type that has no saved template (delete or rename the
  template of one type, or use a second project). Repeat once with a type whose only template is for
  entering a status (activation `transition:<status>`).
- **Expect:** the result card shows **Template rules not met** and, for no template at all: "No
  template exists for the issue type “{subject}”, so nothing was created. Open Skills, choose
  “Propose from project”, review and save the template, then ask again." For the status-only template
  the line reads: "Only rules for entering a status exist for “{subject}”, so nothing was created.
  Open Skills, choose “Propose from project”, review and save a template for creating, then ask
  again." (`{subject}` is `PROJECT/Issue type`.) Following the hint creates the template and the
  repeated request then passes.
- **Jira:** no issue was created.
- **Proves:** epic AC1; #4354 template rule 1 ("With no template it is refused before any effect, with
  the hint to create one").

### W09 The corrected create passes, for each of the four types

- **Do:** with the templates of W06 in place, ask Keiko to create, in this order: an Epic; a Story or
  Task that belongs to it; a Sub-task of that Story or Task; a Bug. State each summary and the
  required fields. In **Ask for approval** and **Supervised workspace**, read the **Review Jira
  action** card (**Proposed action details**) and select **Approve this action**. In **Full access**
  no approval card appears. Use one summary with a German umlaut.
- **Expect:** the result card lists each issue as a link with **Created**; the issues carry the
  relations you asked for. After approval the card shows **Approval used for this action**.
- **Jira:** each issue exists with the right type, parent or Epic, and fields; the umlaut is exact.
- **Proves:** epic AC1, AC4, and AC10 (encoding on the platform); #4354 template rule 1; #4359 step 4.

### W09a An Epic Link whose target is not an Epic

- **Do:** in **Ask for approval**, ask Keiko to create a Task whose Epic Link is the key of another
  Task (not an Epic).
- **Expect:** the request is refused before any approval: no **Review Jira action** card, and the
  result card says "The Epic Link points to an issue that is not an Epic, or that this account cannot
  see." and "Nothing was sent to Jira." Keiko offers to use an Epic instead.
- **Jira:** no issue was created, and Jira never answered with a "not found" for the Epic.
- **Proves:** epic AC4; #4354 "An Epic Link target that is not an Epic is refused before the review
  card."

### W10 An edit on an issue that already violates its template

- **Do:** in Jira, create or edit an issue so that it breaks a template rule in one field (for example
  remove a required section from its description). In Keiko ask for an edit of a different field of
  that issue (for example the priority).
- **Expect:** the edit is made, not refused. In its answer Keiko says the change was made, names in its
  own words the template rule the issue still breaks, and offers to repair it; it does not repeat the
  change. (The notice is told to the model with fixed guidance; the card shows no separate notice, so
  this reaches you through Keiko's answer.)
- **Jira:** the edited field changed; the field that violated the rule is as it was.
- **Proves:** epic AC1; #4354 template rule 2 ("Pre-existing violations in untouched fields do not
  block and are named as a notice").

### W11 An edit that makes the issue worse is refused

- **Do:** ask Keiko to change a field of a conforming issue so that it breaks a rule (for example
  remove a required label). Then ask for an edit of the issue's project or issue type.
- **Expect:** the first edit is refused under **Template rules not met** with the rule lines. The
  second is refused too: Keiko says an edit does not change the project or issue type and points to
  Jira's Move or to creating the issue again.
- **Jira:** both issues are unchanged.
- **Proves:** epic AC1; #4354 template rule 2 ("the change must not make it worse").

### W12 A status change needs no template

- **Do:** for a type that has no template, ask Keiko to move an issue to another status.
- **Expect:** the issue moves; no template was needed.
- **Jira:** the issue is in the new status.
- **Proves:** epic AC4; #4354 template rule 3.

### W12a A transition that carries a field, and an entry rule

- **Do:** ask Keiko to move an issue to a status while setting a field that Jira asks for on that
  transition (for example a resolution), once with a value that keeps the template satisfied and once
  with a value that breaks one of its rules. If a template has a rule for entering that status
  (activation `transition:<status>`), move an issue into that status without meeting the rule. A
  Jira in another language needs the status name as Jira reports it, for example "In Bearbeitung",
  in that rule.
- **Expect:** the first move happens. The second is refused under **Template rules not met** with the
  rule lines (a field carried by a transition follows the edit rule). The entry-rule move is refused
  the same way, naming the rule.
- **Jira:** the issues are in the statuses you expect; the refused ones did not move.
- **Proves:** epic AC1, AC4; #4354 template rule 3 ("Only a template's explicit rules for entering a
  status apply") and rule 2 for the carried field.

### W13 Comment, watcher, link, assignee, and the switched-off attachment

- **Do:** ask Keiko to add a comment, edit that comment, add a watcher, link two issues, and assign an
  issue to a person found by name. Then ask it to attach a file to an issue.
- **Expect:** the comment, its edit and the watcher are done without any template rule. Assigning
  and linking follow the issue's template like any other change: they work unless they would break a
  saved rule (link behaviour is to be confirmed at the first rehearsal of the walk). The card shows
  **Jira change confirmed** for each. Keiko does not offer attachments: asked anyway, it says in its
  own words what the product tells it: "Attachments are not part of this release, so nothing was
  changed in Jira. Describe the file in a comment instead, or add it in Jira itself."
- **Jira:** the comment (in its edited form), watcher, link and assignee are there; no attachment was
  added.
- **Proves:** epic AC4; #4354 template rule 4 (comments and watchers never template-checked) and
  rule 5 (attachments are blocked and left out in Release 1); #4359 step 5.

### W14 The progress and compliance report

- **Do:** ask Keiko for a progress and compliance report of a project that holds more issues than one
  Jira result page, and then of one Epic. Select **Export Markdown** and **Export CSV**. (How many
  issues one result page holds, and so how large that project must be, is to be confirmed at the first
  rehearsal of the walk; #4359 asks for a readback over at least two pages.)
- **Expect:** the card shows **Complete: {read} issues read**, the counts **To do**, **In progress**,
  **Done** and the percentage, and a line "{issues} of {checked} issues deviate ({count}
  deviations)". An unfinished read shows **Incomplete ({reason}): …** and the figures then describe
  only the issues read; an incomplete report is never shown as complete. The card states the figures
  are computed by Keiko, not by the model.
- **Jira:** run the same scope as an issue search in Jira over every result page. The total and the
  status counts equal the report. Record the JQL, the total, and the per-status counts.
- **Proves:** AC3; #4359 step 6.

### W15 The report in an English and in a German session

- **Do:** ask for the same report once with the interface in English and once in German (**Settings →
  General → Language → Interface language**: **English** or **Deutsch**), the second against a lab Jira
  whose session language is German.
- **Expect:** both reports have the same figures; labels, field names and notes are in the session's
  language; the German Jira's status names are matched correctly.
- **Jira:** the German Jira's own status and field names appear unchanged in the report.
- **Proves:** AC9, AC3; #4359 step 8 and "German Jira".

### W16 The result card after a reload

- **Do:** after W09 and W14, reload the browser (and, once, restart Keiko) and open the same Chat.
- **Expect:** the result cards and the report are still there and readable; **View Jira result** opens
  the stored result; no write is repeated.
- **Jira:** the issue count is unchanged.
- **Proves:** AC9, AC8; #4359 steps 7 and 8.

### W17 A reload or interruption never writes twice

- **Do:** ask for a create. While the turn runs, reload the browser. In **Ask for approval**, repeat
  with the reload between the request and your approval; once close the tab after approving.
- **Expect:** the Chat comes back; the card shows one settled outcome for the action and never asks
  again for an approval already used; a possibly sent write is not sent again.
- **Jira:** exactly one issue exists for each request.
- **Proves:** AC8; #4359 step 7.

### W18 An expired approval

- **Do:** in **Ask for approval**, ask Keiko to draft several issues (so that the draft stays the Chat's
  open draft) and leave the **Review Jira action** card undecided for more than ten minutes. Then
  tell Keiko to ask again.
- **Expect:** the card shows **Action approval expired**. Keiko says in plain language that the
  approval expired, that nothing was changed and that this was not a refusal by you. It does not draft
  the issues anew: the same draft comes back with a new **Review Jira action** card. For a single
  create without a draft, asking again makes a new card.
- **Jira:** no issue was created by the expired request; after the new approval, each issue exists once.
- **Proves:** epic AC8; #4354 "An expired approval says that it expired. The draft remains the Chat's
  open draft and can be resubmitted."; #4359 step 7.

### W19 A Pod switch with an open draft

- **Do:** (the two preparations here, a draft left open and a second verified Jira Pod, are to be
  confirmed at the first rehearsal of the walk) with a second verified Jira Pod available, ask Keiko
  to draft several issues and leave the draft undecided. In **Connectors** switch the second Pod on
  (one Chat binds one Pod). Then approve or resubmit the draft.
- **Expect:** nothing is sent to Jira. The result card says "The Jira connection changed since this
  draft was made, so nothing was changed. Create the draft again for the current Jira." A message
  sent after the switch without choosing the Pod again shows the notice **Jira connection changed**
  with "Choose the Jira Pod again" and the hint to open the Connectors menu above the conversation.
  The Chat and its draft text stay.
- **Jira:** nothing was created.
- **Proves:** epic AC8; #4359 step 7.

### W20 Support export

- **Do:** at any error notice select **Create error report**, then **Download report**; note the
  **Support ID**. Then run the offline reading of the file.
- **Expect:** the card shows **Report ready. Download it and send it to support.**; the file arrives
  in the browser's download folder. The analysis names the operations of the walk without any issue
  text, path or token.

```bash
keiko support analyze <report.json> --json
```

- **Jira:** not applicable.
- **Proves:** AC8, AC9 (the log lets a defect be rebuilt); #4359 documentation items.

### W21 The same in the Coding Workbench (macOS)

- **Do:** open the Coding Workbench, switch the Pod on in **Connectors**, and in a task ask Keiko to
  read an issue, add a comment and move an issue to another status.
- **Expect:** the three operations work as in Chat; a run with no Pod switched on uses no Jira Pod.
  This step is a walk once; it does not block.
- **Jira:** the comment and status are there.
- **Proves:** AC4; #4359 "Workbench". Not available on Windows.

### W22 Platform checks (each platform)

- **Do:** note where the credential key is held. macOS: the login keychain (no keyfile beside the
  stores). Windows: with an npm install run `npx keiko status` and read the credential custody line; a
  portable install documents no `keiko` command on the path, so there read the notices instead (a
  stored-credentials notice appears only when the key is exposed or could not be checked; see
  `docs/troubleshooting/windows-portable-first-launch.md` for the bundled `runtime\node\node.exe` and
  `app\dist\cli\index.js` the launcher itself runs). Confirm that a private certificate authority is trusted only through
  `KEIKO_CA_BUNDLE_PATH`.
- **Expect:** macOS shows no keychain refusal; Windows reports "Credential custody: attested" (npm
  install) or shows no notice that the key protecting your stored credentials was readable by another
  account or could not be checked (portable install). A
  connection to a Jira with an untrusted certificate is refused with the message that names
  `KEIKO_CA_BUNDLE_PATH`.
- **Jira:** not applicable.
- **Proves:** AC10.

## 4. Trace table

Fill one row per epic criterion for each platform. A verdict is **pass**, **fail** or **not run**; the
evidence cell names the run, the file and the comment link. The Windows run that binds is the x64
release under emulation or on real hardware, whichever is recorded in the evidence.

| Epic criterion        | Walk steps                                    | macOS verdict | Windows verdict | Evidence (run, file, comment link) | Auditor |
| --------------------- | --------------------------------------------- | ------------- | --------------- | ---------------------------------- | ------- |
| AC1 Structures        | W03, W06, W06a, W07, W08, W09, W10, W11, W12a |               |                 |                                    |         |
| AC3 Evaluation        | W14, W15                                      |               |                 |                                    |         |
| AC4 Development tasks | W03, W09, W09a, W12, W12a, W13, W21           |               |                 |                                    |         |
| AC8 Reliability       | W04, W05, W16, W17, W18, W19, W20             |               |                 |                                    |         |
| AC9 Readable results  | W15, W16, W20                                 |               |                 |                                    |         |
| AC10 Platforms        | W01, W02, W04, W09, W22                       |               |                 |                                    |         |

Disclosed limitations that bound these verdicts (the long text is section 5):

| Limitation                                                       | Epic criterion it bounds                     | Where it is disclosed                         |
| ---------------------------------------------------------------- | -------------------------------------------- | --------------------------------------------- |
| S14 edit items are not in Release 1                              | AC4 (edits driven by a changed document)     | Section 5; #4359 narrowings                   |
| The S19 oracle credits a refused create onto its twin            | AC1 (refused creates)                        | Section 5; #4359 narrowings                   |
| The Pod card does not show the connected account                 | AC10 (W02)                                   | Section 5; W02                                |
| The notice on an edit of a violating issue is only in the answer | AC1 (W10)                                    | Section 5; W10                                |
| No detection of the same summary across chats                    | AC8                                          | Section 5; epic #4351 decision 2026-11-13     |
| Attachments are off                                              | AC4 (W13)                                    | Section 5; W13                                |
| A model without tool calling gets no tool tasks                  | AC1, AC3, AC4                                | Section 5; section 6                          |
| Windows results come from an emulated x64 virtual machine        | AC10 and every Windows verdict               | Section 5; `windows-vm-cross-test-machine.md` |
| Linux is a community tier                                        | AC10                                         | Section 5; ADR-0183                           |
| The requirements-document path is Release 2                      | AC2 (not walked), AC3 (requirement coverage) | Section 5; section 1                          |

## 5. Disclosed limitations

Each one is part of what Release 1 delivers; a verdict does not hide it.

- **S14 edit items are not in Release 1.** #4359 names it: "S14 edit items. The owner moved them out
  on 2026-11-02; the change-impact child of Release 2 delivers them" (#4359, narrowings).
- **The S19 oracle credits a refused create onto its twin.** #4359 names it as the second narrowing:
  "the S19 oracle that credits a refused create onto its twin" (#4359, narrowings).
- **The Pod card does not show the connected account.** For Release 1 the account is confirmed by
  asking in Chat (W02).
- **The notice on an edit of an already-violating issue reaches the person only through Keiko's
  answer, not on a card** (W10). The product tells the model to say which rule is still broken; a card
  sentence for it is routed to the owning child, and this page changes when the product shows it.
- **No detection of the same summary across chats.** The same order given in two fresh chats creates
  two issues by design (epic #4351, decision of 2026-11-13).
- **Attachments are off** until Release 2 (epic #4351, template rule; `jira.attach` and
  `jira.delete-attachment` are refused).
- **A model that neither calls the check tool nor accepts a forced call gets no tool tasks.** Tool
  turns need a confirmed tool-calling check; see section 6 and
  `docs/troubleshooting/model-does-not-call-tools.md`.
- **The Windows results come from a Windows 11 ARM64 virtual machine running the x64 release under
  emulation** unless a real-hardware run is recorded. They prove the Windows operating system, not an
  Intel or AMD computer, and their timings are emulated (`docs/qa/windows-vm-cross-test-machine.md`).
  The Coding Workbench is not available on Windows, so its steps are macOS only.
- **Linux is a community tier** (ADR-0183): no Linux walk is part of this acceptance.
- **The requirements-document path** (a Knowledge Pod that becomes issues, and the requirement
  coverage of a report) is Release 2.

## 6. Add a new model (customer procedure)

Three steps for a person who adds a model to a Keiko that already uses a Jira Pod.

1. **Add the model.** Add it to the gateway configuration, directly or through a proxy such as
   LiteLLM (`docs/troubleshooting/litellm-production-gateway.md`). A model that offers no tool calling
   at its endpoint cannot be used for Jira tasks.
2. **Run the check in Settings > Models** and read the result. Open **Settings → Models**, select
   **Run readiness check**, and read the model's capability line (`tools yes` or `tools no`) and the
   sentence under it. The check first offers a tool the way production does and, only if the model
   called none, asks again with the call forced. It ends in one of six closed outcomes, and Settings
   words each one:
   - `called-unforced`: "Tools work: the model called the test tool on its own."
   - `called-only-forced`: "Calls a tool only when forced. In conversations it may not use tools.
     Choose a model that calls tools on its own, or turn its thinking mode off, then check again."
   - `forced-refused`: "The model did not call the tool on its own, and the provider refused the
     forced call (a thinking mode often does). That does not prove the model cannot call tools, but it
     is not confirmed either, so tool tasks are not available for it. Turn its thinking mode off and
     check again."
   - `no-call`: "The model answered in words, also when the call was forced. It does not call tools
     through this endpoint, so tool tasks are not available for it. Choose a model that supports tool
     calling, or ask your administrator to enable tool-call support for it."
   - `tools-refused`: "The endpoint refused the request that offers a tool, so tool tasks are not
     available for this model. Ask your administrator to enable tool calling for it, or choose another
     model."
   - `inconclusive`: "Tool calling could not be confirmed: the gateway timed out, was busy or answered
     with an error, or the model did not complete the test steps. Check again in a few minutes."
3. **Run one three-step Jira task** in a Chat with the Pod on, for example: list the projects, find
   the three newest issues of one project, and name the status of each. A model that answers in words
   and calls no tool fails this step even when the check passed.

If a step fails, export what Keiko recorded and read the outcome without raw logs: at the error
notice select **Create error report** and **Download report**, or, where the `keiko` command is
available (an npm install; a portable install documents none on the path), run `keiko support export`
and then `keiko support analyze <report.json> --json`. Look for `toolCallingOutcome` on
`gateway.readiness.completed` and for `gateway.retry.scheduled` lines with the reason
`reasoning-restore-repair`. The report holds counts and closed outcomes only.

<!--
Catalog check for the walk (every quoted UI label, with its message key). Paths are under
packages/keiko-ui/src. Every key below was read on integration head a60fe469a; keys marked
[not a label] are not UI labels.

Catalogs: CORE = lib/i18n-messages.en.ts, OPT = lib/i18n-messages.optional.en.ts,
SET = app/components/desktop/widgets/panels/settings-i18n.messages.json,
WB = app/components/desktop/widgets/coding-workbench/coding-workbench-i18n.en.ts.
"English", "Deutsch": lib/i18n.tsx LOCALE_LABELS.

Local Knowledge: window.type.localKnowledge.title (CORE)
Jira Live Pods: atlassianConnectors.live.title (OPT)
Create Jira Pod: atlassianConnectors.live.add (OPT)
Label: atlassianConnectors.add.displayName (OPT)
Base URL: atlassianConnectors.add.baseUrl (OPT)
API token: atlassianConnectors.add.token (OPT)
Verifying…: atlassianConnectors.verify.verifying (OPT)
Connection verified: atlassianConnectors.verify.ok.label (OPT)
Ready: atlassianConnectors.live.state.ready (OPT)
Verify connection: atlassianConnectors.verify.button (OPT)
Read the current Jira account: atlassianConnectors.action.jira.myself (OPT)
Connectors: chat.connectors.title (OPT)
Connectors: 1 active: chat.connectors.active (OPT) "Connectors: {count} active"
Jira Pods: chat.connectors.jira (OPT)
Manage: chat.connectors.manage (OPT)
Model gateway setup: gatewaySetup.badge.setup (OPT)
Access: chat.connectors.access (OPT)
Ask for approval / Supervised workspace / Full access:
  codingWorkbench.mode.governed-assist.label, ...supervised-coding.label, ...autonomous-delivery.label
  (lib/autonomy-mode-labels.ts, spread into OPT and WB)
Connect this browser: browserApproval.title (OPT)
Connect browser: browserApproval.open (OPT)
Skills: chat.skills.title (OPT)
Jira templates: chat.skills.jira.title (OPT)
Project key: chat.skills.jira.projectKey (OPT)
Propose from project: chat.skills.jira.propose (OPT)
Open in editor: chat.skills.jira.openProposal (OPT)
Save: chat.skills.save (OPT)
Matches Jira.: chat.skills.jira.valid (OPT)
Needs repair: chat.skills.jira.invalid (OPT)
Template rules not met: chat.jira.outcome.rules (OPT)
The summary is too short.: chat.jira.outcome.rule.summary-too-short (OPT)
The description lacks the section “{subject}”.: chat.jira.outcome.rule.section-missing (OPT)
No template exists for the issue type “{subject}”, ...: chat.jira.outcome.rule.template-missing (OPT)
Only rules for entering a status exist for “{subject}”, ...: chat.jira.outcome.rule.template-not-activated (OPT)
Project {subject} does not exist or is not visible.: chat.skills.jira.finding.unknown-project (OPT)
Not applied: {reasons}: chat.skills.jira.notApplied (OPT)
The Epic Link points to an issue that is not an Epic, ...: chat.jira.outcome.validation.invalid-epic-link (OPT)
Nothing was sent to Jira.: chat.jira.outcome.nothingSent (OPT)
The Jira connection changed since this draft was made, ...: chat.jira.outcome.draftRefusal.connection-changed (OPT)
Review Jira action: chat.jira.writeApproval.title (OPT)
Proposed action details: chat.jira.writeApproval.preview (OPT)
Approve this action: chat.jira.writeApproval.allow (OPT)
Approval used for this action: chat.jira.writeApproval.claimed (OPT)
Action approval expired: chat.jira.writeApproval.expired (OPT)
Created: chat.jira.outcome.state.created (OPT)
Jira change confirmed: chat.jira.write.succeeded (OPT)
View Jira result: chat.jira.details (OPT)
Attachments are not part of this release, ...: the Jira refusal text of child/4354-jira-write-path
  (packages/keiko-contracts/src/jira-release-scope.ts, JIRA_ATTACHMENTS_UNAVAILABLE_MESSAGE)
  [not a catalog label: the product's own refusal sentence, shown through Keiko's answer]
Complete: {read} issues read: chat.jira.report.complete (OPT)
Incomplete ({reason}): chat.jira.report.incomplete (OPT)
To do / In progress / Done: chat.jira.report.todo, chat.jira.report.inProgress, chat.jira.report.done (OPT)
{issues} of {checked} issues deviate ({count} deviations): chat.jira.report.compliance (OPT)
Export Markdown / Export CSV: chat.jira.report.exportMarkdown, chat.jira.report.exportCsv (OPT)
Settings → General → Language → Interface language: settings.title, settings.tabs.general,
  settings.language.title, settings.language.label (SET)
Jira connection changed: chat.error.jiraPodConnectionChanged.title (CORE)
Choose the Jira Pod again / Connectors menu above the conversation:
  chat.error.jiraPodConnectionChanged.message and .remediation (CORE)
  The picker itself is labelled "Connectors" (chat.connectors.title); the "Sources" label
  (chat.grounding.label, OPT) is the knowledge-scope control above the conversation. With a Jira
  Pod on, its "none" entry reads "Jira Pod only" (chat.grounding.jiraOnly, OPT).
Create error report / Download report: supportReport.create, supportReport.download (CORE)
Support ID: chat.error.supportId (CORE) "Support ID: {correlationId}"
Report ready. Download it and send it to support.: supportReport.saved (CORE)
Settings → Models / Run readiness check: settings.tabs.models, settings.models.runReadiness (SET)
The six sentences of section 6: settings.models.toolOutcome.called-unforced, ...called-only-forced,
  ...forced-refused, ...no-call, ...tools-refused, ...inconclusive (SET)
tools yes / tools no: settings.models.capabilitySummary, settings.models.yes, settings.models.no (SET)
Windows SmartScreen "More info → Run anyway", macOS "Open Anyway": README.md (Download), operating-system
  text, not a Keiko catalog label [not a label]
`create`, `activateOn`, the outcome names of section 6, `toolCallingOutcome`: contract values, not labels [not a label]
Profile / Personal Access Tokens / Create token: Jira's own UI, version dependent [not a Keiko label]
Credential custody: attested: output of `keiko status` (packages/keiko-cli/src/lifecycle.ts) [not a label]
-->
