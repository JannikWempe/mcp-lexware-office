# Upload note: multipart `contentPath` is read from the container's filesystem, so local files
# are only reachable when mounted, e.g. `docker run -v /host/dir:/data:ro ...` and contentPath '/data/receipt.pdf'.
FROM node:22.23-alpine AS builder

WORKDIR /app

# corepack installs the pnpm version pinned in package.json#packageManager
RUN corepack enable

COPY package.json pnpm-lock.yaml ./

RUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile --ignore-scripts

COPY . .

RUN pnpm run build

FROM node:22.23-alpine AS release

WORKDIR /app

RUN corepack enable

COPY --from=builder /app/package.json /app/package.json
COPY --from=builder /app/pnpm-lock.yaml /app/pnpm-lock.yaml

ENV NODE_ENV=production

RUN pnpm install --frozen-lockfile --prod --ignore-scripts

COPY --from=builder /app/build /app/build

ENTRYPOINT ["node", "build/index.js"]
