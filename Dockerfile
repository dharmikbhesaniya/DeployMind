# syntax=docker/dockerfile:1
FROM node:22-alpine AS builder

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci

# Copy source and compile backend
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build:backend || npx tsc

# Build Web SPA
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# --- Production Runtime Stage ---
FROM node:22-alpine AS runner

WORKDIR /app

# Install git and docker CLI
RUN apk add --no-cache git docker-cli curl

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV DEPLOYAGENT_DATA_DIR=/var/lib/deployagent

# Copy production artifacts
COPY package*.json ./
RUN npm ci --only=production

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/web/dist ./web/dist

VOLUME ["/var/lib/deployagent", "/var/run/docker.sock"]

EXPOSE 3000

CMD ["node", "dist/main.js"]
