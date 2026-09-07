FROM node:20-bookworm-slim AS admin-builder
WORKDIR /frontend
COPY frontend/package.json ./
RUN npm install
COPY frontend/ ./
RUN npm run build

FROM node:20-bookworm-slim AS pos-builder
WORKDIR /pos
COPY frontend-pos/package.json ./
RUN npm install
COPY frontend-pos/ ./
RUN npm run build

FROM node:20-bookworm-slim
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY backend/package.json ./
RUN npm install --omit=dev
COPY backend/ ./
COPY --from=admin-builder /frontend/build ./public/admin
COPY --from=pos-builder /pos/build ./public/pos
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV DATABASE_PATH=/app/data/supermarket.db
ENV BACKUP_DIR=/app/backups
EXPOSE 3000
CMD ["node", "server.js"]
