FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates git python3 \
    && rm -rf /var/lib/apt/lists/*
# Install Anthropic's unmodified native executable in a system location.
# Cantelop supplies the runtime user, startup command and durable /workspace.
# Update the version and vendor-manifest checksums together after validation.
ARG TARGETARCH
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) platform=linux-x64; checksum=0399c793ff571d5946ef923d80b4f330d05ac4b6842a6b0775468f5d389403c0 ;; \
      arm64) platform=linux-arm64; checksum=226a4e009574044a18bf5495f127806b2a1bfcbf25b3c01608705fafee95fefb ;; \
      *) echo "Unsupported Claude architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    curl -fsSL --proto '=https' --proto-redir '=https' \
      "https://downloads.claude.ai/claude-code-releases/2.1.267/$platform/claude" -o /tmp/claude; \
    echo "$checksum  /tmp/claude" | sha256sum --check --strict; \
    install -m 0755 /tmp/claude /usr/local/bin/claude; \
    rm /tmp/claude

COPY runtime/login-pty.py /opt/app/login-pty.py
