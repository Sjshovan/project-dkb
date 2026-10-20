FROM python:3.11-slim-bookworm

ARG DKB_VERSION=0.1.0
ARG DKB_COMMIT=development

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PIP_NO_CACHE_DIR=1
ENV DKB_FAISS_ALLOWED_ROOTS=/context,/jobs,/state

WORKDIR /faiss
COPY requirements.txt ./
RUN python -m pip install --upgrade pip && python -m pip install -r requirements.txt
COPY faiss/faiss_helper.py service.py ./

LABEL org.opencontainers.image.title="DKB FAISS Provider" \
      org.opencontainers.image.version="${DKB_VERSION}" \
      org.opencontainers.image.revision="${DKB_COMMIT}" \
      org.opencontainers.image.source="https://github.com/Sjshovan/project-dkb" \
      org.dkb.index.service.version="1"

EXPOSE 8092
CMD ["python", "-m", "uvicorn", "service:app", "--host", "0.0.0.0", "--port", "8092"]
