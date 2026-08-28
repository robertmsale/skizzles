FROM ubuntu:24.04
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates git util-linux \
    && rm -rf /var/lib/apt/lists/*
