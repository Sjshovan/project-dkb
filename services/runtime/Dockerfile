FROM node:22-bookworm-slim AS build

WORKDIR /workspace
COPY package.json package-lock.json tsconfig*.json ./
COPY apps/cli/package.json apps/cli/package.json
COPY services/runtime/package.json services/runtime/package.json
COPY services/compiler/package.json services/compiler/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/library/package.json packages/library/package.json
COPY packages/pipeline/package.json packages/pipeline/package.json
COPY packages/registry-client/package.json packages/registry-client/package.json
COPY providers/bundled/package.json providers/bundled/package.json
RUN npm ci
COPY packages packages
COPY providers providers
COPY services/runtime services/runtime
RUN npm run build --workspace @sjshovan/dkb-runtime

FROM node:22-bookworm-slim AS runtime

ARG DKB_VERSION=0.1.0
ARG DKB_COMMIT=development
LABEL org.opencontainers.image.title="DKB Runtime" \
      org.opencontainers.image.version="${DKB_VERSION}" \
      org.opencontainers.image.revision="${DKB_COMMIT}" \
      org.opencontainers.image.source="https://github.com/Sjshovan/project-dkb"

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip \
    && python3 -m pip install --break-system-packages --no-cache-dir faiss-cpu==1.15.0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
COPY package.json package-lock.json ./
COPY apps/cli/package.json apps/cli/package.json
COPY services/runtime/package.json services/runtime/package.json
COPY services/compiler/package.json services/compiler/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/library/package.json packages/library/package.json
COPY packages/pipeline/package.json packages/pipeline/package.json
COPY packages/registry-client/package.json packages/registry-client/package.json
COPY providers/bundled/package.json providers/bundled/package.json
RUN npm ci --omit=dev --workspace @sjshovan/dkb-runtime --include-workspace-root=false
COPY --from=build /workspace/packages/protocol/dist packages/protocol/dist
COPY packages/protocol/schemas packages/protocol/schemas
COPY --from=build /workspace/packages/library/dist packages/library/dist
COPY --from=build /workspace/packages/pipeline/dist packages/pipeline/dist
COPY --from=build /workspace/packages/registry-client/dist packages/registry-client/dist
COPY --from=build /workspace/providers/bundled/dist providers/bundled/dist
COPY providers/bundled/python/faiss providers/bundled/python/faiss
COPY --from=build /workspace/services/runtime/dist services/runtime/dist

ENV NODE_ENV=production \
    DKB_RUNTIME_HOST=0.0.0.0 \
    DKB_RUNTIME_PORT=7331 \
    DKB_RUNTIME_STATE_ROOT=/state \
    DKB_RUNTIME_CONTAINER=1 \
    DKB_FAISS_PYTHON=python3 \
    DKB_MCP_HTTP_ENABLED=true

EXPOSE 7331
CMD ["node", "services/runtime/dist/bin.js"]
