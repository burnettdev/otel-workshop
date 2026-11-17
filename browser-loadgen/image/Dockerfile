# Playwright's image already has Chromium and its system libraries; the npm package version must match it.
FROM mcr.microsoft.com/playwright:v1.55.0-noble
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY journey.js ./
USER pwuser
CMD ["node", "journey.js"]
