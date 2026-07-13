FROM node:20-bookworm-slim

# better-sqlite3 需要原生编译工具链
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 仅拷贝项目源码（宿主机 node_modules 不挂载，容器内重新编译原生模块）
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .

ENV AUDIT_LOGGER_ROOT=/app \
    NODE_ENV=production

EXPOSE 9320

CMD ["node", "scripts/server.js", "--port", "9320", "--bind", "0.0.0.0"]
