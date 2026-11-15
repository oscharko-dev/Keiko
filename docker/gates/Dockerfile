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
# Git is built from the upstream release tarball in its own stage, because the product's lazy-fetch
# guard needs git 2.45 or newer (the release that honours GIT_NO_LAZY_FETCH, packages/keiko-tools
# git-worktree-snapshot-node.ts) and Debian bookworm ships 2.39 with no newer build in bookworm or
# bookworm-backports. CI's runners carry a current git, so a gates image on 2.39 refused promisor
# reads that CI accepts (five keiko-tools tests). Source: kernel.org's mirror of the upstream
# release. Pinned by version and SHA-256, which is checked at build time; the same digest is the one
# kernel.org lists in its sha256sums.asc, and the tarball's detached signature verifies against
# Junio C. Hamano's release key (fingerprint 96E0 7AF2 5771 9559 80DA D100 20D0 4E5A 7136 60A7).
# Raising the pin is a deliberate edit of these two arguments. NO_RUST=1 builds without the optional
# Rust subsystems of git 2.5x, which would need a Rust toolchain this image does not carry.
# The Node version is a build argument: the default lane is Node 24.18.0 and the optional Node 26
# lane (compose service `gates-node26`) builds the same image with the version CI's "Node 26
# compatibility" job runs. Both pins are the governed pair of scripts/check-runtime-toolchain.mjs.
ARG NODE_VERSION=24.18.0
FROM node:${NODE_VERSION}-bookworm AS git-build
ARG GIT_VERSION=2.56.1
ARG GIT_SHA256=f0b0bf89264b9bd2e1c640363e7529643989da76281600473c50745cd34a607f
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        ca-certificates \
        curl \
        gettext \
        libcurl4-openssl-dev \
        libexpat1-dev \
        libssl-dev \
        xz-utils \
        zlib1g-dev \
    && rm -rf /var/lib/apt/lists/* \
    && curl --proto "=https" --tlsv1.2 -fsSL \
        "https://mirrors.edge.kernel.org/pub/software/scm/git/git-${GIT_VERSION}.tar.xz" \
        -o /tmp/git.tar.xz \
    && echo "${GIT_SHA256}  /tmp/git.tar.xz" | sha256sum -c - \
    && tar -xJf /tmp/git.tar.xz -C /tmp \
    && make -C "/tmp/git-${GIT_VERSION}" -j"$(nproc)" \
        prefix=/usr/local NO_TCLTK=1 NO_PERL=1 NO_PYTHON=1 NO_RUST=1 \
        all \
    && make -C "/tmp/git-${GIT_VERSION}" \
        prefix=/usr/local NO_TCLTK=1 NO_PERL=1 NO_PYTHON=1 NO_RUST=1 \
        DESTDIR=/stage install

FROM node:${NODE_VERSION}-bookworm

# Bubblewrap backs the mandatory network:none sandbox the egress proof and the #2215 verification
# E2E exercise. Without it those suites assert their fallback instead of the real boundary.
# The Playwright system dependencies mirror what `playwright install --with-deps chromium` pulls.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bubblewrap \
        ca-certificates \
        git \
        iproute2 \
        libasound2 \
        libatk-bridge2.0-0 \
        libatk1.0-0 \
        libcairo2 \
        libcups2 \
        libcurl4 \
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

# The newer git, ahead of the distribution's in PATH (/usr/local/bin precedes /usr/bin). The
# distribution package stays installed for its own dependants. `iproute2` is the `ip` tool the
# keiko-sandbox unshare fallback needs to bring loopback up inside its namespace; without it that
# fallback fails closed (loopback-tool-unavailable), exactly as on any host that lacks it.
COPY --from=git-build /stage/usr/local/ /usr/local/

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
#
# The gate suite runs unprivileged (S6471). The `node` image ships a non-root `node` user; the three
# named volumes are pre-created here so Docker copies this ownership into them on first use. One RUN
# for the whole root stage: consecutive RUN instructions belong in a single layer (docker:S7031).
RUN git config --global --add safe.directory /repo \
    && mkdir -p /repo/node_modules /opt/playwright /opt/npm-cache \
    && chown -R node:node /repo/node_modules /opt/playwright /opt/npm-cache
USER node
# Repeated for the `node` user's own global config — the entry above belongs to root and is not
# read by `node`.
RUN git config --global --add safe.directory /repo \
    && git config --global --add safe.directory '*'

WORKDIR /repo
