FROM node:20-slim

# chromium 运行库(bookworm) + 基础字体
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnspr4 libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
    libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 \
    libpango-1.0-0 libcairo2 libatspi2.0-0 libexpat1 libx11-6 libxcb1 libxext6 libxi6 libxtst6 \
    fonts-liberation \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 依赖层(改动少,缓存友好)
COPY deploy/package.json ./
RUN npm install --omit=dev
# 浏览器二进制走国内镜像(阿里云 CDN,创空间构建快且稳)
ENV PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright
# 只留完整版 chromium(执行器用 channel:"chromium");headless-shell 和 ffmpeg 用不到,省 ~266MB
RUN npx patchright install chromium \
 && rm -rf /root/.cache/ms-playwright/chromium_headless_shell-* /root/.cache/ms-playwright/ffmpeg-*

# 应用层(.env 若存在则一并打入,作为固定访问口令的配置文件)
COPY work.js deploy/server.mjs deploy/browser-executor.mjs .env* ./

# 端口: 默认 7860,可用 PORT 环境变量覆盖
ENV PORT=7860 \
    BIND=0.0.0.0
EXPOSE 7860

CMD ["node", "server.mjs"]