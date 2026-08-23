# PDFMint API — HTML/Markdown/URL -> PDF.
# One container: the renderer, the API, the marketing site and the docs.
FROM node:20-bookworm-slim

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    DEBIAN_FRONTEND=noninteractive

# Chromium's CJK fallback otherwise lands on WenQuanYi Zen Hei, a Chinese face whose
# Japanese kanji and Korean hangul are noticeably wrong. Pin each language to the
# Noto face that is actually designed for it, and emoji to the colour font.
ENV FONTCONFIG='<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig>\
<match target="pattern"><test name="lang" compare="contains"><string>ja</string></test>\
<test qual="any" name="family"><string>sans-serif</string></test>\
<edit name="family" mode="prepend" binding="strong"><string>Noto Sans CJK JP</string></edit></match>\
<match target="pattern"><test name="lang" compare="contains"><string>ko</string></test>\
<test qual="any" name="family"><string>sans-serif</string></test>\
<edit name="family" mode="prepend" binding="strong"><string>Noto Sans CJK KR</string></edit></match>\
<match target="pattern"><test name="lang" compare="contains"><string>zh-tw</string></test>\
<test qual="any" name="family"><string>sans-serif</string></test>\
<edit name="family" mode="prepend" binding="strong"><string>Noto Sans CJK TC</string></edit></match>\
<match target="pattern"><test name="lang" compare="contains"><string>zh</string></test>\
<test qual="any" name="family"><string>sans-serif</string></test>\
<edit name="family" mode="prepend" binding="strong"><string>Noto Sans CJK SC</string></edit></match>\
<match target="pattern"><test qual="any" name="family"><string>emoji</string></test>\
<edit name="family" mode="prepend" binding="strong"><string>Noto Color Emoji</string></edit></match>\
<alias binding="strong"><family>sans-serif</family><prefer><family>Inter</family>\
<family>Noto Sans</family><family>Noto Color Emoji</family></prefer></alias>\
<alias binding="strong"><family>monospace</family><prefer><family>JetBrains Mono</family>\
<family>Noto Sans Mono</family><family>Noto Color Emoji</family></prefer></alias>\
<selectfont><rejectfont><pattern><patelt name="family"><string>WenQuanYi Zen Hei</string></patelt></pattern>\
<pattern><patelt name="family"><string>WenQuanYi Zen Hei Sharp</string></patelt></pattern></rejectfont></selectfont>\
</fontconfig>'

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
 && printf '%s' "$FONTCONFIG" > /etc/fonts/local.conf \
 && fc-cache -f \
 && apt-get clean && rm -rf /var/lib/apt/lists/* /root/.npm

COPY src ./src
COPY public ./public

# Chromium runs arbitrary caller HTML, and Render does not grant the capabilities
# its own sandbox needs, so the process is dropped to an unprivileged user. A
# renderer escape then lands as `pdfmint`, not as root, in a container whose only
# writable paths are /tmp and the browser's own cache.
RUN groupadd --system --gid 10001 pdfmint \
 && useradd --system --uid 10001 --gid pdfmint --home-dir /home/pdfmint --create-home pdfmint \
 && chown -R pdfmint:pdfmint /home/pdfmint \
 && chmod -R a+rx /ms-playwright
USER pdfmint

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
