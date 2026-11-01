# 自托管镜像：前端产物 + server 源码与依赖打成一个，配一个 Postgres 就能跑（编排见 docker-compose.prod.yml）。
# 一个端口（3789）同时出页面、REST 与三条 WebSocket（/collab、/term、/connector），前面加一层终止 TLS 的反代即可。
# 构建（仓库根目录）：docker build -t ramet .

# ---- 前端编译：只在构建阶段要 vite 和整套前端依赖，不进最终镜像 ----
FROM node:22-alpine AS web
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/web/package.json packages/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN --mount=type=cache,target=/root/.npm \
    npm ci --workspace packages/web --workspace packages/shared --prefer-offline --no-audit --no-fund
COPY packages/shared packages/shared
COPY packages/web packages/web
RUN npm run build -w packages/web

# ---- 运行：server 依赖 + 源码，直接用 tsx 跑 TS（tsconfig 是 noEmit，没有编译产物） ----
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/server/package.json packages/server/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN --mount=type=cache,target=/root/.npm \
    npm ci --workspace packages/server --workspace packages/shared --prefer-offline --no-audit --no-fund
COPY packages/shared/src packages/shared/src
COPY packages/server/tsconfig.json packages/server/tsconfig.json
COPY packages/server/src packages/server/src
# server 按「与 server 包同级的 web/dist」找前端产物（web-static.ts）
COPY --from=web /app/packages/web/dist packages/web/dist

WORKDIR /app/packages/server
# 上传文件落在 /app/packages/server/uploads，永不删除（版本历史还引用着它们）：必须 bind mount 到宿主机长期保留
EXPOSE 3789
# node 直接当 PID 1（npx 不转发信号）：停容器的 SIGTERM 要能到达，在跑的 agent 才能先收尾再退出
CMD ["node", "--import", "tsx", "src/index.ts"]
