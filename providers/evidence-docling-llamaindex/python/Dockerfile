FROM python:3.11-slim-bookworm

ARG DKB_VERSION=0.1.0
ARG DKB_COMMIT=development

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PIP_NO_CACHE_DIR=1

WORKDIR /compiler

COPY requirements.txt ./
RUN apt-get update \
    && apt-get install -y --no-install-recommends libglib2.0-0 libgl1 libxcb1 \
    && rm -rf /var/lib/apt/lists/* \
    && python -m pip install --upgrade pip \
    && python -m pip install --index-url https://download.pytorch.org/whl/cpu torch==2.13.0 torchvision==0.28.0 \
    && python -m pip install -r requirements.txt

COPY compile.py service.py worker.py worker_control.py model-pins.json model_assets.py assets.json ./
RUN python model_assets.py --backend torch
LABEL org.opencontainers.image.title="DKB Docling LlamaIndex Evidence Worker" \
      org.opencontainers.image.version="${DKB_VERSION}" \
      org.opencontainers.image.revision="${DKB_COMMIT}" \
      org.opencontainers.image.source="https://github.com/Sjshovan/project-dkb" \
      org.dkb.compiler.service.version="5"

EXPOSE 8091
CMD ["python", "-m", "uvicorn", "service:app", "--host", "0.0.0.0", "--port", "8091"]
