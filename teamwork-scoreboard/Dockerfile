# Teamwork Scoreboard — production image.
# Uses the official Playwright base image so Chromium (for the Zen Planner
# browser sync) is pre-installed with all system dependencies.
# NOTE: keep this tag in sync with the "playwright" version in package.json.
FROM mcr.microsoft.com/playwright:v1.62.1-noble

WORKDIR /app

# Build tools for native modules (better-sqlite3 compiles from source when no
# prebuilt binary matches the image's Node version).
RUN apt-get update \
  && apt-get install -y --no-install-recommends build-essential \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV PORT=3000
# Chromium ships inside the base image at this path.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# The SQLite database lives here — mount a volume to persist it.
VOLUME /app/data

EXPOSE 3000
CMD ["npm", "start"]
