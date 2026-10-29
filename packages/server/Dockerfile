# 后端运行环境镜像：只装依赖，不含源码（构建 context 是仓库根，需要根 lockfile 和 workspaces）。
# 源码（packages/server/src、packages/shared/src、packages/server/tsconfig.json）由 docker-compose.prod.yml
# 只读挂载进来，所以这个镜像离开挂载不能单独跑；只改代码时不用重建，依赖变了才重建。
# 直接用 tsx 跑 TS 源码（tsconfig 是 noEmit，build 只做类型检查）；启动耗时敏感时再改成 tsc emit。
FROM node:22-alpine

WORKDIR /app

# 只装 server 与它依赖的共享包(@ramet/shared,TS 源码直出)
COPY package.json package-lock.json ./
COPY packages/server/package.json packages/server/package.json
COPY packages/shared/package.json packages/shared/package.json
# 下载过的包经 BuildKit 缓存挂载留在构建机上:部署机出口慢时(曾经只有约 1MB/s),失败重跑、改 package.json 都只补下缺的包。
# npm 自己崩时只打一句 "Exit handler never called!",看不出原因,所以失败时把调试日志的结尾打出来
RUN --mount=type=cache,target=/root/.npm \
    npm ci --workspace packages/server --workspace packages/shared --prefer-offline --fetch-retries=5 --no-audit --no-fund \
    || { tail -n 80 "$(ls -t /root/.npm/_logs/*-debug-0.log | head -1)"; exit 1; }

WORKDIR /app/packages/server

# DATABASE_URL 由 docker-compose.prod.yml 注入(compose 内网 postgres)。
# node 直接当 PID 1(npx 不转发信号):部署重启的 SIGTERM 要能到达,在跑的 agent 才能先收尾再退出
CMD ["node", "--import", "tsx", "src/index.ts"]
