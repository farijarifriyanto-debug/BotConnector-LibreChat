FROM python:3.11-slim

WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1

COPY deploy/code-adapter/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY deploy/code-adapter/app.py /app/app.py
COPY deploy/code-adapter/ptc.py /app/ptc.py
COPY deploy/code-adapter/vendor /app/vendor

EXPOSE 18112
CMD ["uvicorn","app:app","--host","127.0.0.1","--port","18112"]
