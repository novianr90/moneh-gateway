# Build Stage
FROM node:22-alpine AS builder
WORKDIR /app

COPY package*.json tsconfig.json ./
# Mount BuildKit cache for npm store to speed up rebuilds
RUN --mount=type=cache,target=/root/.npm \
    npm install

COPY src ./src

RUN npm run build
RUN npm prune --production

# Production Stage
FROM node:22-alpine AS runner
WORKDIR /app

# Install curl, wget for Coolify Healthcheck & libc6-compat for native sqlite bindings
RUN apk add --no-cache curl wget libc6-compat

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ARG PORT=4000
ENV PORT=${PORT}

EXPOSE ${PORT}

CMD ["node", "dist/index.js"]
