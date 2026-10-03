# Local development/test service only. Upstream publishes this release as source.
FROM golang:1.24.9-alpine AS build
RUN apk add --no-cache git ca-certificates
WORKDIR /src
RUN git init && git remote add origin https://github.com/minio/minio.git \
    && git fetch --depth 1 origin 9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a \
    && git checkout --detach FETCH_HEAD
RUN CGO_ENABLED=0 go build -p 2 -trimpath -ldflags="-s -w" -o /out/minio .

FROM alpine:3.22
RUN apk add --no-cache ca-certificates && mkdir -p /data && chown 10001:10001 /data
COPY --from=build /out/minio /usr/local/bin/minio
COPY --from=build /src/LICENSE /licenses/MINIO-LICENSE
LABEL org.opencontainers.image.source="https://github.com/minio/minio" \
      org.opencontainers.image.revision="9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a" \
      org.opencontainers.image.licenses="AGPL-3.0-only"
USER 10001:10001
EXPOSE 9000
ENTRYPOINT ["minio"]
CMD ["server", "/data"]
