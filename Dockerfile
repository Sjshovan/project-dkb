FROM node:22-bookworm-slim

WORKDIR /workspace

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m pip install --break-system-packages faiss-cpu==1.15.0
RUN npm run build

ENV DKB_RUNTIME_HOST=0.0.0.0
ENV DKB_RUNTIME_PORT=7331
ENV DKB_RUNTIME_STATE_ROOT=/state
ENV DKB_RUNTIME_CONTAINER=1
ENV DKB_FAISS_PYTHON=python3

EXPOSE 7331

CMD ["node", "dist/src/cli/index.js", "runtime", "serve"]
