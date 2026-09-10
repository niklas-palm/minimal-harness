FROM --platform=linux/arm64 node:22-slim

# What the agent's bash tool can reach for: ripgrep to search, git to clone,
# curl to fetch, python3 to script (boto3 for AWS, httpx for HTTP).
RUN apt-get update && apt-get install -y --no-install-recommends \
      ripgrep ca-certificates git curl \
      python3 python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/*

# PEP 668 makes system pip refuse to install by default; the override is
# fine inside a container.
RUN pip install --no-cache-dir --break-system-packages \
      boto3==1.43.23 \
      httpx==0.28.1

# tsx so we can run TypeScript directly - no compile step.
RUN npm install -g --no-fund --no-audit tsx@4

WORKDIR /app

# Reproducible installs: package-lock pins exact versions; npm ci enforces.
COPY package.json package-lock.json ./
RUN npm ci --no-fund --no-audit

COPY config.json ./
COPY src/ ./src/

# Skills surfaced to the agent via the AgentSkills plugin. Each subdir under
# skills/ is one skill (must contain SKILL.md) and is loaded automatically.
COPY skills/ ./skills/

RUN mkdir -p /workspace

ENV NODE_NO_WARNINGS=1
EXPOSE 8080

CMD ["tsx", "src/server.ts"]
