FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PIP_NO_CACHE_DIR=1
ENV PYTHONPATH=/app
ENV A3_SOFFICE_PATH=/usr/bin/soffice

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    default-libmysqlclient-dev \
    fontconfig \
    fonts-noto-cjk \
    libreoffice-impress \
    libreoffice-writer \
    pkg-config \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./requirements.txt
RUN pip install --upgrade pip && pip install -r requirements.txt

COPY . ./backend

WORKDIR /app/backend

EXPOSE 8000

ENTRYPOINT ["python", "scripts/docker_entrypoint.py"]
CMD ["python", "manage.py", "runserver", "0.0.0.0:8000"]
