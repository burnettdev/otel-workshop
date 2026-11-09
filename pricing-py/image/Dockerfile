FROM python:3.13-slim-bookworm

WORKDIR /app
COPY requirements.txt .
# opentelemetry-bootstrap installs the instrumentations matching the libraries above (FastAPI, PyMySQL, ...).
RUN pip install --no-cache-dir -r requirements.txt \
 && opentelemetry-bootstrap -a install \
 && pip check

COPY app.py main.py ./

USER 65534
EXPOSE 8000
CMD ["opentelemetry-instrument", "python", "main.py"]
