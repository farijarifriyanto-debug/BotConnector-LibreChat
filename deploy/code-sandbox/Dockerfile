FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HOME=/tmp

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      libreoffice-core-nogui \
      libreoffice-writer-nogui \
      libreoffice-calc-nogui \
      libreoffice-impress-nogui \
      libreoffice-draw-nogui \
      fonts-dejavu-core \
      fonts-liberation \
      fonts-noto-core \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir \
      python-docx \
      openpyxl \
      xlsxwriter \
      python-pptx \
      reportlab \
      pypdf \
      pillow \
      pandas \
      numpy \
      matplotlib

WORKDIR /workspace
CMD ["sleep", "infinity"]
