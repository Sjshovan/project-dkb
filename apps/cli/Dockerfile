# The management image contains the same CLI, not a Runtime-admin API.
FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS build
WORKDIR /workspace
COPY package.json package-lock.json tsconfig*.json ./
COPY apps/cli/package.json apps/cli/package.json
COPY apps/console/package.json apps/console/package.json
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
COPY services/compiler services/compiler
COPY services/runtime services/runtime
COPY apps/cli apps/cli
COPY apps/console apps/console
COPY scripts scripts
COPY deploy/compose.yaml deploy/compose.yaml
RUN npm run build \
    && node scripts/generate-provider-integrity.mjs --verify --copy-to /provider-distribution

FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS cli
ARG DKB_VERSION=0.2.0
ARG DKB_COMMIT=development
LABEL org.opencontainers.image.title="DKB CLI" \
      org.opencontainers.image.version="${DKB_VERSION}" \
      org.opencontainers.image.revision="${DKB_COMMIT}" \
      org.opencontainers.image.source="https://github.com/Sjshovan/project-dkb" \
      dev.dkb.library-owner.protocol="dkb.library-owner.v1" \
      dev.dkb.library-install.protocol="dkb.library-install.v2" \
      dev.dkb.library-collection-install.protocol="dkb.library-collection-install.v1" \
      dev.dkb.stack-owner.protocol="dkb.stack-owner.v1" \
      dev.dkb.stack-snapshot.protocol="dkb.stack-snapshot-worker.v1"
WORKDIR /workspace
COPY package.json package-lock.json ./
COPY LICENSE LICENSE
COPY apps/cli/package.json apps/cli/package.json
COPY apps/console/package.json apps/console/package.json
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
RUN npm ci --omit=dev --workspace @sjshovan/dkb-cli --include-workspace-root=false --ignore-scripts
COPY --from=build /workspace/apps/cli/dist apps/cli/dist
COPY --from=build /workspace/apps/console/dist apps/console/dist
COPY --from=build /workspace/services/runtime/dist services/runtime/dist
COPY --from=build /workspace/services/compiler/dist services/compiler/dist
COPY --from=build /workspace/packages/protocol/dist packages/protocol/dist
COPY --from=build /workspace/packages/library/dist packages/library/dist
COPY packages/library/platform/windows-volume-probe.js packages/library/platform/windows-volume-probe.js
COPY --from=build /workspace/packages/pipeline/dist packages/pipeline/dist
COPY --from=build /workspace/packages/registry-client/dist packages/registry-client/dist
COPY --from=build /workspace/packages/distribution-default/dist packages/distribution-default/dist
COPY packages/protocol/schemas packages/protocol/schemas
COPY --from=build /provider-distribution/providers providers
COPY scripts/generate-provider-integrity.mjs scripts/generate-provider-integrity.mjs
RUN find apps services packages -type f -name '*.tsbuildinfo' -delete \
    && node scripts/generate-provider-integrity.mjs --verify
ENV NODE_ENV=production
ENTRYPOINT ["node", "/workspace/apps/cli/dist/cli/index.js"]
