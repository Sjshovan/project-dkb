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
COPY providers/bundled/package.json providers/bundled/package.json
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
RUN npm run build --workspace @sjshovan/dkb-compiler

FROM node:22-bookworm-slim AS runtime

ARG DKB_VERSION=0.1.0
ARG DKB_COMMIT=development
LABEL org.opencontainers.image.title="DKB Compiler" \
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
COPY packages/distribution-default/package.json packages/distribution-default/package.json
COPY providers/bundled/package.json providers/bundled/package.json
COPY providers/evidence-docling-llamaindex/package.json providers/evidence-docling-llamaindex/package.json
COPY providers/embedding-fastembed/package.json providers/embedding-fastembed/package.json
COPY providers/embedding-tei/package.json providers/embedding-tei/package.json
COPY providers/index-faiss/package.json providers/index-faiss/package.json
COPY providers/index-meilisearch/package.json providers/index-meilisearch/package.json
COPY providers/retrieval-hybrid/package.json providers/retrieval-hybrid/package.json
RUN npm ci --omit=dev --workspace @sjshovan/dkb-compiler --include-workspace-root=false
COPY --from=build /workspace/packages/protocol/dist packages/protocol/dist
COPY packages/protocol/schemas packages/protocol/schemas
COPY --from=build /workspace/packages/library/dist packages/library/dist
COPY --from=build /workspace/packages/pipeline/dist packages/pipeline/dist
COPY --from=build /workspace/packages/registry-client/dist packages/registry-client/dist
COPY --from=build /workspace/packages/distribution-default/dist packages/distribution-default/dist
COPY --from=build /workspace/providers/bundled/dist providers/bundled/dist
COPY --from=build /workspace/providers/evidence-docling-llamaindex/dist providers/evidence-docling-llamaindex/dist
COPY --from=build /workspace/providers/embedding-fastembed/dist providers/embedding-fastembed/dist
COPY --from=build /workspace/providers/embedding-tei/dist providers/embedding-tei/dist
COPY --from=build /workspace/providers/index-faiss/dist providers/index-faiss/dist
COPY providers/index-faiss/python/faiss providers/index-faiss/python/faiss
COPY --from=build /workspace/providers/index-meilisearch/dist providers/index-meilisearch/dist
COPY --from=build /workspace/providers/retrieval-hybrid/dist providers/retrieval-hybrid/dist
COPY --from=build /workspace/services/compiler/dist services/compiler/dist

ENV NODE_ENV=production \
    DKB_COMPILER_HOST=0.0.0.0 \
    DKB_COMPILER_PORT=7341 \
    DKB_CONTEXT_ROOT=/context \
    DKB_LLAMA_COMPILER_SERVICE_URL=http://dkb-compiler-worker:8091 \
    DKB_LLAMA_COMPILER_SERVICE_ROOT=/jobs \
    DKB_FAISS_PYTHON=python3

EXPOSE 7341
CMD ["node", "services/compiler/dist/bin.js"]
