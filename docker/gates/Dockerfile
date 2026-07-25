# Local reproduction of the Linux gate environment (Issue #2699).
#
# Purpose: run the checks that most often turn our required CI red BEFORE pushing, on the same
# Linux userland the runners use. Two thirds of our failing CI runs were reproducible locally —
# each one cost a full ~123 weighted runner-minute cycle to discover.
#
# Runs as the image's non-root `node` user: nothing here needs root, and a local gate container that
# writes into a bind-mounted checkout should not do so as uid 0.
#
# What this image is NOT: the D12 measurement environment. That one is its own pinned container
# (`npm run perf:evidence:regen`), and it is a developer machine rather than CI — the wall-clock
# budgets are calibrated for linux/arm64 with >=14 logical cores, which no hosted runner offers
# (ADR-0156 D6). This image runs the deterministic gates; see docs/qa/local-gates.md.
FROM node:24.18.0-bookworm

# Bubblewrap backs the mandatory network:none sandbox the egress proof and the #2215 verification
# E2E exercise. Without it those suites assert their fallback instead of the real boundary.
# The Playwright system dependencies mirror what `playwright install --with-deps chromium` pulls.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bubblewrap \
        ca-certificates \
        git \
        libasound2 \
        libatk-bridge2.0-0 \
        libatk1.0-0 \
        libcairo2 \
        libcups2 \
        libdbus-1-3 \
        libdrm2 \
        libgbm1 \
        libglib2.0-0 \
        libnspr4 \
        libnss3 \
        libpango-1.0-0 \
        libx11-6 \
        libxcb1 \
        libxcomposite1 \
        libxdamage1 \
        libxext6 \
        libxfixes3 \
        libxkbcommon0 \
        libxrandr2 \
        unzip \
    && rm -rf /var/lib/apt/lists/*

# Browsers live outside the bind-mounted workspace so a host checkout is never polluted and the
# download survives between runs through the named volume in docker-compose.yml.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
ENV NODE_OPTIONS=--max-old-space-size=8192
# Keep the container's install out of the host node_modules: the host may be macOS/arm64, and
# swapping platform-native binaries in a shared tree corrupts both sides.
ENV npm_config_cache=/opt/npm-cache

# The bind-mounted checkout belongs to the host user, not to root inside the container. Git refuses
# to operate on it ("dubious ownership") since 2.35.2, which makes every gate that inspects the
# index — dependency hygiene, the i18n guard, the D12 subject digest — fail with a status 128 that
# says nothing about the real cause.
RUN git config --global --add safe.directory /repo

# The gate suite runs unprivileged (S6471). The `node` image ships a non-root `node` user; the three
# named volumes are pre-created here so Docker copies this ownership into them on first use, and the
# git safe.directory entry is repeated for that user's own global config — the one above belongs to
# root and is not read by `node`.
RUN mkdir -p /repo/node_modules /opt/playwright /opt/npm-cache \
    && chown -R node:node /repo/node_modules /opt/playwright /opt/npm-cache
USER node
RUN git config --global --add safe.directory /repo \
    && git config --global --add safe.directory '*'

WORKDIR /repo
