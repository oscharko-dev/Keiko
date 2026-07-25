# Local reproduction of the Linux gate environment (Issue #2699).
#
# Purpose: run the checks that most often turn our required CI red BEFORE pushing, on the same
# Linux userland the runners use. Two thirds of our failing CI runs were reproducible locally —
# each one cost a full ~123 weighted runner-minute cycle to discover.
#
# What this image is NOT: an authority for measurements. Wall-clock evidence (D12) is only
# comparable on the same architecture as the reference runner, and on Apple Silicon this image is
# arm64 while CI is x86_64. Emulation makes the numbers meaningless. Measurements stay CI-owned;
# see docs/qa/local-gates.md.
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

WORKDIR /repo
