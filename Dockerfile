# pi-phone server edition (PP-20): the server and web app, with the tools Pi uses, for Linux (x64 or arm64).
# deploy/compose.yaml runs it behind Caddy; deploy/README.md says how. Data (sessions, sign-ins, the home folder Pi works
# in) is all under /data, a volume. It runs as the image's `node` user, never root.
#
#   docker build -t pi-phone-server .
ARG NODE_IMAGE=node:26.12.0-trixie-slim
# A Debian mirror near the builder (http://debian.xtdv.net/debian in Vietnam, where deb.debian.org gives ~100 KB/s).
ARG DEBIAN_MIRROR=http://deb.debian.org/debian

# ─── Build: the Intelligent UI frame (dev dependencies), the pinned tools, then production dependencies only. Everything
# readable by all (the run stage runs as `node`), whatever modes the build context had. ───
FROM ${NODE_IMAGE} AS build
ARG DEBIAN_MIRROR
RUN sed -i "s|http://deb.debian.org/debian$|${DEBIAN_MIRROR}|" /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates unzip \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN node scripts/intelligent-ui.ts \
    && node scripts/server-tools.ts "linux-$(dpkg --print-architecture | sed 's/amd64/x64/')" \
    && npm ci --omit=dev --ignore-scripts \
    && find node_modules -type d \( -name .bin -o -name better-sqlite3 -o -name node-addon-api -o -regex '.*/tree-sitter-\(go\|javascript\|python\|rust\|typescript\)' \) -prune -exec rm -rf {} + \
    && find node_modules -type d -name node-llama-cpp -prune -exec sh -c 'echo "node-llama-cpp: pi-phone never runs a local model" >&2; exit 1' \; \
    && chmod -R a+rX /app

# ─── Run ───
FROM ${NODE_IMAGE}
ARG GH_VERSION=2.102.0
ARG GH_SHA256_AMD64=bb766f710eef8ede859c18578c72c327597cd4c8a85b06001b1f3843c6019386
ARG GH_SHA256_ARM64=7862c86c72f43df3a2d93ddde6f473285b4e2af61b494849846827e513ef6484
ARG DEBIAN_MIRROR
# git and ssh for Pi's work and machines; tini as PID 1; ICU for OfficeCLI (.NET); what Chrome headless shell needs, and
# fonts for pages (Japanese, Chinese and Korean too).
RUN sed -i "s|http://deb.debian.org/debian$|${DEBIAN_MIRROR}|" /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates curl git openssh-client tini less procps unzip libicu76 \
        libnss3 libnspr4 libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 libdrm2 libxkbcommon0 libxcomposite1 \
        libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2t64 libpango-1.0-0 libcairo2 libdbus-1-3 libexpat1 \
        fonts-liberation fonts-noto-color-emoji fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/* \
    && arch="$(dpkg --print-architecture)" \
    && sum="$([ "$arch" = arm64 ] && echo "$GH_SHA256_ARM64" || echo "$GH_SHA256_AMD64")" \
    && curl -fsSL -o /tmp/gh.tar.gz "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${arch}.tar.gz" \
    && echo "${sum}  /tmp/gh.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/gh.tar.gz -C /tmp \
    && mv "/tmp/gh_${GH_VERSION}_linux_${arch}/bin/gh" /usr/local/bin/gh \
    && rm -rf /tmp/gh*
WORKDIR /app
COPY --from=build /app/package.json /app/DESIGN.md /app/AGENTS.md ./
COPY --from=build /app/src ./src
COPY --from=build /app/web ./web
COPY --from=build /app/native ./native
COPY --from=build /app/third_party ./third_party
COPY --from=build /app/node_modules ./node_modules
COPY --chmod=755 deploy/entrypoint.sh /app/deploy/entrypoint.sh
RUN for tool in rg fd officecli; do ln -s /app/native/linux-*/"$tool"/"$tool" /usr/local/bin/"$tool"; done \
    && mkdir -p /data && chown node:node /data
ENV HOME=/data/home \
    PI_PHONE_PLATFORM=server \
    PI_CHROME_NO_SANDBOX=1 \
    NODE_ENV=production
USER node
VOLUME /data
EXPOSE 8787
ENTRYPOINT ["tini", "--", "/app/deploy/entrypoint.sh"]
