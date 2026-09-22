FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates git python3 \
    && rm -rf /var/lib/apt/lists/*
# Install Anthropic's unmodified native executable in a system location.
# Cantelop supplies the runtime user, startup command and durable /workspace.
ARG CLAUDE_VERSION=stable
RUN curl -fsSL https://claude.ai/install.sh -o /tmp/install-claude.sh \
    && bash /tmp/install-claude.sh "$CLAUDE_VERSION" \
    && install -m 0755 "$(readlink -f /root/.local/bin/claude)" /usr/local/bin/claude \
    && rm -rf /root/.local /root/.claude /tmp/install-claude.sh

COPY runtime/login-pty.py /opt/app/login-pty.py
