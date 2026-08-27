FROM node:22-bookworm-slim

ARG CODEX_VERSION=0.149.1

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates curl git \
    && npm install --global "@openai/codex@${CODEX_VERSION}" \
    && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /usr/local/bin/skizzles-codex-container
RUN chmod 0755 /usr/local/bin/skizzles-codex-container

ENV CODEX_HOME=/codex-home
WORKDIR /workspace/repo
ENTRYPOINT ["/usr/local/bin/skizzles-codex-container"]
