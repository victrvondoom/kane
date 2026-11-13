# SHIPPROOF + Kane CLI + Chrome in one image.
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends chromium ca-certificates git && rm -rf /var/lib/apt/lists/*
RUN npm install -g @testmuai/kane-cli
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production PORT=4000 DATA_DIR=/data KANE_HEADLESS=1 ALLOW_PRIVATE_TARGETS=0
VOLUME /data
EXPOSE 4000
# Provide LT_USERNAME / LT_ACCESS_KEY at runtime (docker run -e ...). Never bake them into the image.
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# exec form: node is PID 1 and receives SIGTERM for graceful shutdown
CMD ["node", "server/index.js"]
