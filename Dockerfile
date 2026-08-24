FROM mcr.microsoft.com/playwright:v1.59.1-noble

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY public ./public
COPY src ./src

ENV HOST=0.0.0.0 \
    PORT=8787 \
    HEADLESS=true \
    BROWSER_CHANNEL=chromium \
    USER_DATA_DIR=/tmp/raw-html-maxxing-profile

EXPOSE 8787

CMD ["npm", "start"]
