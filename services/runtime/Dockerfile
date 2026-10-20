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
COPY packages/distribution-default/package.json packages/distribution-default/package.json
COPY providers/evidence-docling-llamaindex/package.json providers/evidence-docling-llamaindex/package.json
COPY providers/embedding-fastembed/package.json providers/embedding-fastembed/package.json
COPY providers/embedding-tei/package.json providers/embedding-tei/package.json
COPY providers/index-faiss/package.json providers/index-faiss/package.json
COPY providers/index-meilisearch/package.json providers/index-meilisearch/package.json
COPY providers/retrieval-hybrid/package.json providers/retrieval-hybrid/package.json
RUN npm ci
COPY packages packages
COPY providers providers
COPY services/runtime services/runtime
COPY scripts/generate-provider-integrity.mjs scripts/generate-provider-integrity.mjs
RUN npm run build --workspace @sjshovan/dkb-runtime \
    && node scripts/generate-provider-integrity.mjs --verify --copy-to /provider-distribution

FROM node:22-bookworm-slim AS runtime

ARG DKB_VERSION=0.1.0
ARG DKB_COMMIT=development
LABEL org.opencontainers.image.title="DKB Runtime" \
      org.opencontainers.image.version="${DKB_VERSION}" \
      org.opencontainers.image.revision="${DKB_COMMIT}" \
      org.opencontainers.image.source="https://github.com/Sjshovan/project-dkb"

WORKDIR /workspace
COPY package.json package-lock.json ./
COPY apps/cli/package.json apps/cli/package.json
COPY services/runtime/package.json services/runtime/package.json
COPY services/compiler/package.json services/compiler/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/library/package.json packages/library/package.json
COPY packages/pipeline/package.json packages/pipeline/package.json
COPY packages/registry-client/package.json packages/registry-client/package.json
COPY packages/distribution-default/package.json packages/distribution-default/package.json
COPY providers/evidence-docling-llamaindex/package.json providers/evidence-docling-llamaindex/package.json
COPY providers/embedding-fastembed/package.json providers/embedding-fastembed/package.json
COPY providers/embedding-tei/package.json providers/embedding-tei/package.json
COPY providers/index-faiss/package.json providers/index-faiss/package.json
COPY providers/index-meilisearch/package.json providers/index-meilisearch/package.json
COPY providers/retrieval-hybrid/package.json providers/retrieval-hybrid/package.json
RUN npm ci --omit=dev --workspace @sjshovan/dkb-runtime --include-workspace-root=false
COPY --from=build /workspace/packages/protocol/dist packages/protocol/dist
COPY packages/protocol/schemas packages/protocol/schemas
COPY --from=build /workspace/packages/library/dist packages/library/dist
COPY --from=build /workspace/packages/pipeline/dist packages/pipeline/dist
COPY --from=build /workspace/packages/registry-client/dist packages/registry-client/dist
COPY --from=build /workspace/packages/distribution-default/dist packages/distribution-default/dist
COPY --from=build /provider-distribution/providers providers
COPY --from=build /workspace/services/runtime/dist services/runtime/dist
COPY scripts/generate-provider-integrity.mjs scripts/generate-provider-integrity.mjs
RUN node scripts/generate-provider-integrity.mjs --verify

ENV NODE_ENV=production \
    DKB_RUNTIME_HOST=0.0.0.0 \
    DKB_RUNTIME_PORT=7331 \
    DKB_RUNTIME_STATE_ROOT=/state \
    DKB_RUNTIME_CONTAINER=1 \
    DKB_FAISS_SERVICE_URL=http://dkb-faiss:8092 \
    DKB_MCP_HTTP_ENABLED=true

EXPOSE 7331
CMD ["node", "services/runtime/dist/bin.js"]
