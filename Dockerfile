# Stage 1: Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm

# Copy package files
COPY package.json pnpm-lock.yaml* package-lock.json* ./

# Install dependencies
RUN pnpm install || npm install

# Copy TypeScript files
COPY tsconfig.json ./
COPY src ./src
COPY server.ts ./

# Build TypeScript code to dist/
RUN npm run build

# Stage 2: Production runner stage
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

# Install pnpm
RUN npm install -g pnpm

# Copy package files and install production dependencies only
COPY package.json pnpm-lock.yaml* package-lock.json* ./
RUN pnpm install --prod || npm install --omit=dev

# Copy compiled code, public web assets, and config
COPY --from=builder /app/dist ./dist
COPY public ./public
COPY config ./config

# Expose port
EXPOSE 3030

# Health check endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3030/api/health || exit 1

# Start Express server
CMD ["node", "dist/server.js"]
