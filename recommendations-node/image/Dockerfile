# Debian-based (glibc) Node.js image. The Dash0 operator injects its Node.js distribution at deploy time.
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY server.js ./
USER node
EXPOSE 3000
CMD ["node", "server.js"]
