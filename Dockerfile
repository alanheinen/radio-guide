# Signal Radio: static web app + stream proxy + now playing + periodic station rebuild,
# all from scripts/serve.py. Standard library only, so no pip layer.
#
# Base pinned by tag and digest; bump both together.
FROM python:3.12.15-slim-trixie@sha256:a6e34c598f2467ed0e9a8d349809fcd8b5c603269512df273a0bb1784edc11b1

# COUNTRIES: ISO country codes to build, e.g. us,ca,gb.
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    COUNTRIES=us

WORKDIR /app
COPY scripts/ scripts/
COPY web/index.html web/app.css web/app.js web/
# Owned by the app user, so a named volume mounted here starts out writable.
RUN install -d -o 1000 -g 1000 /data

# Runs as an unprivileged UID; the root filesystem can be read-only because
# the only thing written is the station data, which goes to /data (mount an
# emptyDir there).
USER 1000:1000
EXPOSE 8080
VOLUME ["/data"]

# Healthy once the first station build has landed (/healthz is 503 until then).
HEALTHCHECK --interval=30s --timeout=5s --start-period=1m --retries=3 \
    CMD ["python3", "-c", "import urllib.request as u; u.urlopen('http://127.0.0.1:8080/healthz', timeout=4)"]

CMD ["python3", "scripts/serve.py", "--host", "0.0.0.0", "--port", "8080", "--data", "/data", "--refresh", "1"]
