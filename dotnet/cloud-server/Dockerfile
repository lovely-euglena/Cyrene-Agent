# cyrene-cloud-server 镜像（构建上下文 = ./dotnet）
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY cyrene-core/ cyrene-core/
COPY cloud-server/ cloud-server/
RUN dotnet publish cloud-server/CloudServer.csproj -c Release -o /app

FROM mcr.microsoft.com/dotnet/aspnet:10.0
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --home-dir /data --shell /usr/sbin/nologin cyrene \
    && mkdir -p /data \
    && chown cyrene:cyrene /data \
    && chmod 750 /data
WORKDIR /app
COPY --from=build /app ./
ENV ASPNETCORE_URLS=http://0.0.0.0:7789 \
    CYRENE_CLOUD_DATA=/data
VOLUME /data
EXPOSE 7789
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=10s \
  CMD curl -fsS http://127.0.0.1:7789/healthz || exit 1
# 非 root（与 systemd 单元同姿态）；命名卷 cloud-data 初始化时继承 /data 属主
USER cyrene
ENTRYPOINT ["dotnet", "cyrene-cloud-server.dll"]
