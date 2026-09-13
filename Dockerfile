FROM node:20-bookworm-slim AS admin-builder
WORKDIR /frontend
COPY frontend/package.json ./
RUN npm install
COPY frontend/ ./
# Same-origin /admin on :3000. Never bake a loopback API URL.
ENV REACT_APP_API_BASE=
RUN npm run build

FROM node:20-bookworm-slim AS pos-builder
WORKDIR /pos
COPY frontend-pos/package.json ./
RUN npm install
COPY frontend-pos/ ./
# Store POS is served at /pos on :3000. Empty API base = same host as the page.
# Dev .env / npm start set a loopback API URL; that must not ship here.
ENV REACT_APP_API_BASE=
ENV REACT_APP_ADMIN_URL=
ENV GENERATE_SOURCEMAP=false
RUN rm -f .env .env.local .env.development .env.development.local .env.production .env.production.local
RUN npm run build
RUN if grep -R -F "http://127.0.0.1:5001" build/; then echo "POS store bundle must not contain http://127.0.0.1:5001" >&2; exit 1; fi

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
