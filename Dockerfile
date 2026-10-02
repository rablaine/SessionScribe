# Session Scribe: web app, FFmpeg, and YAMNet laughter detector in one image.
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --no-audit --no-fund
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 python3-venv ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY detector/requirements.txt detector/requirements.txt
RUN python3 -m venv /opt/detector \
 && /opt/detector/bin/pip install -r detector/requirements.txt
COPY detector ./detector
# Model is downloaded and SHA-256 verified at build time, never at runtime.
RUN /opt/detector/bin/python detector/download_model.py --destination detector/models/yamnet \
 && rm -rf detector/__pycache__
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY public ./public
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh && mkdir -p /data && chown node:node /data
# Starts as root only to fix ownership of the mounted volume, then drops to the unprivileged node user.
ENV HOME=/home/node \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    FFPROBE_PATH=/usr/bin/ffprobe \
    PYTHON_PATH=/opt/detector/bin/python \
    YAMNET_MODEL_PATH=/app/detector/models/yamnet \
    LAUGHTER_DETECTOR_SCRIPT=/app/detector/detect_laughter.py
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/server.js"]
