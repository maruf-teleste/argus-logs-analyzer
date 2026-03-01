########################################
# 1. Install dependencies
########################################
FROM node:20-bookworm-slim AS deps
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install --production=false


########################################
# 2. Build the Next.js application
########################################
FROM node:20-bookworm-slim AS builder
WORKDIR /app

COPY . .
COPY --from=deps /app/node_modules ./node_modules

# --------------------------------------
# 🔥 REQUIRED BYPASS FOR NEXT.JS BUILD
# --------------------------------------
RUN \
  OPENAI_API_KEY=dummy \
  DATABASE_URL=postgresql://dummy:dummy@localhost:5432/dummy \
  NEXT_DISABLE_ESLINT=1 \
  npm run build


########################################
# 3. Production runtime image
########################################
FROM node:20-bookworm-slim AS runner
WORKDIR /app

ENV NODE_ENV=production

# Copy standalone output
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/static ./.next/static

# Copy KB files (not included in standalone trace)
COPY --from=builder /app/data/kb ./data/kb

# Create writable directories for runtime data
RUN mkdir -p ./data/parquet/logs

EXPOSE 3000

# Increase Node.js heap to 6GB for processing large files (1GB+ with multiple concurrent uploads)
CMD ["node", "--max-old-space-size=6144", "server.js"]
