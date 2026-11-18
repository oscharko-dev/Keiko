Keiko
=====

This folder holds everything Keiko needs to start. Keiko itself arrives from
the npm registry at the first start. Nothing is installed on your computer, and
you need no administrator rights.


Start
-----

macOS:   double-click "Start Keiko.command"
Windows: double-click "Start Keiko.cmd"

At the first start Keiko loads itself from the npm registry into this folder.
That can take a few minutes. Keiko then opens in your browser.

Before your first chat after each start, open Settings > Models and click
"Activate" on the model you want, or "Activate all" when it is shown.


Stop
----

macOS:   double-click "Stop Keiko.command"
Windows: double-click "Stop Keiko.cmd"

Closing only the browser tab leaves Keiko running.


Good to know
------------

- Put this folder on your own computer, for example in Documents. Do not start
  it from a network drive.
- Your chats and settings are kept in the ".keiko-standalone" folder of your
  user account. They stay when you replace this folder with a newer one.
- A new version arrives as a new folder. Stop Keiko, delete the old folder and
  use the new one.
- On Windows this form has no Coding Workbench. Chat, Knowledge Pods, Jira and
  the Editor work.


For administrators
------------------

Registry: if your organization loads npm packages through its own registry,
put a ".npmrc" file that names it next to "Start Keiko". Without one, npm
follows the person's own npm settings, else the public npm registry. "package-lock.json" fixes every version and its
checksum; npm checks them while it installs. A ".npmrc" that carries a registry
access token is as confidential as "keiko.config.json".

Provide the access for everyone, so that nobody enters a gateway address or
token:

1. Start Keiko from this folder and complete Gateway Setup with the address and
   token. Keiko verifies the gateway and its models.
2. Stop Keiko.
3. In the folder "system", double-click "Zugang speichern.command" (macOS) or
   "Zugang speichern.cmd" (Windows) and paste the token. This writes
   "keiko.config.json" next to "Start Keiko".
4. Before you pass the folder on, delete its "node_modules" folder and pack
   it. Everyone who starts it takes over the access at the first start.

"keiko.config.json" holds the token in plain text. Share the folder with your
team only, never publicly, and use a team token of its own with a budget and
an expiry date.


If Keiko does not start
-----------------------

- macOS shows "cannot be opened" or "cannot be verified", or Windows shows
  "Windows protected your PC": this copy still carries the mark of an internet
  download. Take the folder from the place your administrator named, or ask
  your administrator.
- "Keiko could not be loaded from the npm registry": check the network
  connection and the ".npmrc" file, or ask your administrator.
- The window says Keiko could not start: read the message in the window and
  start Keiko again. If it stays, pass the message to your administrator.
- Keiko asks for a gateway address and an API token: your administrator has
  them.
