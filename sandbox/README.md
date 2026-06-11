# Keiko Development Sandbox

This sandbox is intentionally versioned so every developer can run the current local Keiko
development build the same way.

The sandbox depends on the repository root package via:

```json
"@oscharko-dev/keiko": "file:.."
```

That keeps it tied to this checkout instead of the npm registry.

## Start

From this directory:

```bash
npm start
```

You can pass `keiko ui` flags after `--`:

```bash
npm start -- --port 1984
```

Without an explicit port, the sandbox starts on `127.0.0.1:1983` when it is free. If that default
port is already in use, it picks the next free loopback port before running the refresh/build work.
When you pass `--port` or `KEIKO_UI_PORT`, that port is treated as intentional and the start script
fails before the refresh if it is already occupied.

Every start refreshes the sandbox first:

1. installs root workspace dependencies,
2. builds the root package,
3. builds and packages the UI,
4. reinstalls the sandbox dependency from `file:..`,
5. starts the built `keiko ui` command from `sandbox/node_modules`.

Local runtime state is written to `sandbox/.keiko/` and is intentionally ignored by Git.

The start script stores the running UI process in `sandbox/.keiko/ui.pid.json`, so the matching
stop script can shut down the sandbox server from another terminal:

```bash
npm run stop
```

If the process ignores shutdown:

```bash
npm run stop -- --force
```

## Refresh Without Starting

```bash
npm run refresh
```
