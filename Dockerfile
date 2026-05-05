FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates python3 make g++ zstd \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://ollama.com/install.sh | sh

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .

ENV STORAGE_DRIVER=sqlite
ENV EMBEDDER=ollama
ENV TWOCHAIN_DB_PATH=/data/db.sqlite
ENV OLLAMA_MODELS=/data/ollama
ENV HOST=0.0.0.0
ENV PORT=8080
EXPOSE 8080

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

CMD ["/usr/local/bin/docker-entrypoint.sh"]
