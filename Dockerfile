FROM node:24-alpine AS build

WORKDIR /app
COPY package.json package-lock.json tsconfig.json esbuild.mjs ./
COPY shared ./shared
COPY server ./server
RUN npm ci && npm run build

FROM node:24-alpine

RUN apk add --no-cache git \
    && mkdir -p /data \
    && chown node:node /data

WORKDIR /app
COPY --from=build --chown=node:node /app/dist/index.cjs ./index.cjs

ENV HOST=0.0.0.0 \
    PORT=8787 \
    DATA_DIR=/data

USER node
EXPOSE 8787
VOLUME ["/data"]

CMD ["node", "index.cjs"]

