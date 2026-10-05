# cyrene-cloud-server 镜像（构建上下文 = 仓库根；PWA 构建需要 src/pwa 与 src/main/sync）
# 运行镜像零 Node：PWA 在构建阶段产出，随 wwwroot 进镜像。

# ── PWA 构建（Node 只在构建阶段）──
FROM node:24-alpine AS pwa
ARG NPM_REGISTRY=https://registry.npmmirror.com
WORKDIR /src/pwa
COPY src/pwa/package.json src/pwa/package-lock.json ./
RUN npm ci --no-audit --no-fund --registry=$NPM_REGISTRY
COPY src/pwa/ ./
COPY src/main/sync/ /src/main/sync/
RUN CYRENE_PWA_OUT_DIR=/out npm run build

# ── .NET 构建 ──
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY dotnet/cyrene-core/ cyrene-core/
COPY dotnet/cloud-server/ cloud-server/
RUN dotnet publish cloud-server/CloudServer.csproj -c Release -o /app

FROM mcr.microsoft.com/dotnet/aspnet:10.0
# ffmpeg：飞书出站语音转 Ogg Opus（设计 §6.3，Q1 拍板入镜像；+~80MB 镜像体积，
# 体积敏感可 CLOUD_CHANNEL_FEISHU_AUDIO=0 关闭并走文本降级）
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --home-dir /data --shell /usr/sbin/nologin cyrene \
    && mkdir -p /data \
    && chown cyrene:cyrene /data \
    && chmod 750 /data
WORKDIR /app
COPY --from=build /app ./
COPY --from=pwa /out/ ./wwwroot/
ENV ASPNETCORE_URLS=http://0.0.0.0:7789 \
    CYRENE_CLOUD_DATA=/data
VOLUME /data
EXPOSE 7789
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=10s \
  CMD curl -fsS http://127.0.0.1:7789/healthz || exit 1
# 非 root（与 systemd 单元同姿态）；命名卷 cloud-data 初始化时继承 /data 属主
USER cyrene
ENTRYPOINT ["dotnet", "cyrene-cloud-server.dll"]
