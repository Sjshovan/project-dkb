FROM python:3.11-slim-bookworm

ARG DKB_VERSION=0.1.0
ARG DKB_COMMIT=development

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PIP_NO_CACHE_DIR=1
ENV FASTEMBED_CACHE_PATH=/cache/fastembed

WORKDIR /embedder
COPY requirements.txt ./
RUN python -m pip install --upgrade pip && python -m pip install -r requirements.txt
COPY embedder.py ./

LABEL org.opencontainers.image.title="DKB FastEmbed Provider" \
      org.opencontainers.image.version="${DKB_VERSION}" \
      org.opencontainers.image.revision="${DKB_COMMIT}" \
      org.opencontainers.image.source="https://github.com/Sjshovan/project-dkb" \
      org.dkb.embedding.service.version="1"

EXPOSE 8090
CMD ["python", "-m", "uvicorn", "embedder:app", "--host", "0.0.0.0", "--port", "8090"]
