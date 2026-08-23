# PDFMint API — HTML/Markdown/URL -> PDF.
# One container: the renderer, the API, the marketing site and the docs.
FROM node:20-bookworm-slim

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    DEBIAN_FRONTEND=noninteractive

WORKDIR /app

COPY package.json package-lock.json ./

# Chromium + its shared libraries, the fonts we render with, and qpdf for
# password protection. fonts-noto-cjk / -color-emoji are what make Chinese,
# Japanese, Korean and emoji come out as glyphs instead of empty boxes.
RUN npm ci --omit=dev \
 && npx playwright install --with-deps chromium \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      qpdf \
      fonts-inter \
      fonts-jetbrains-mono \
      fonts-liberation2 \
      fonts-dejavu-core \
      fonts-noto-core \
      fonts-noto-cjk \
      fonts-noto-color-emoji \
 && fc-cache -f \
 && apt-get clean && rm -rf /var/lib/apt/lists/* /root/.npm

COPY src ./src
COPY public ./public

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
