# Build context: repo root (fly deploy runs from here)
# Why: we need both apps/backend and packages/shared in one Docker context.
# tsx is used at runtime to handle TypeScript workspace imports without
# requiring a separate compile step for packages/shared. Acceptable overhead
# (~100ms extra startup) for Sprint 0; migrate to tsc dist in Sprint 1.
FROM --platform=linux/amd64 node:22-slim

RUN corepack enable && corepack prepare pnpm@11.1.2 --activate

WORKDIR /app

# Layer: manifests first — changes rarely, good for cache
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/backend/package.json ./apps/backend/

RUN pnpm install --frozen-lockfile

# Layer: source code
COPY packages/shared/src ./packages/shared/src
COPY apps/backend/src ./apps/backend/src

WORKDIR /app/apps/backend

EXPOSE 3000

CMD ["node", "--import", "tsx/esm", "src/index.ts"]
