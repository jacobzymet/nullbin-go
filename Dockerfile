# Nullbin container image.
#
# Reproducible: pinned base images (by digest), pinned Node/Go versions, the
# committed npm lockfile, -trimpath, -buildvcs=false and fixed -ldflags.
# The same commit and VERSION always produce the same binary and bundles.
#
#   docker build -t nullbin .
#   docker build --target artifacts --build-arg VERSION=v1.2.3 --output type=local,dest=out .
#   docker buildx build --platform linux/amd64,linux/arm64 ...   (multi-arch)
#
# The build stages run on the build machine's own platform; Go cross-compiles
# for the target, so arm64 images need no emulation. The frontend bundles
# are platform independent.
#
# Run with a read-only root filesystem; only /data is writable:
#   docker run --read-only --cap-drop ALL --security-opt no-new-privileges \
#     -p 127.0.0.1:8080:8080 -v nullbin-data:/data nullbin
# For a complete HTTPS deployment, see deploy/ and the README.

ARG VERSION=dev

# --- frontend bundles -------------------------------------------------------
FROM --platform=$BUILDPLATFORM node:26.13.0-alpine@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94 AS web
WORKDIR /src
COPY package.json package-lock.json .npmrc ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY web ./web
ARG API_ORIGIN=
ARG VERSION
RUN NULLBIN_VERSION="$VERSION" NULLBIN_API_ORIGIN="$API_ORIGIN" npm run build

# --- server binary ----------------------------------------------------------
FROM --platform=$BUILDPLATFORM golang:1.27.3-alpine@sha256:d200d2dd76b03a99b52651fd1325aff7dcd35422c35c01bac56571b0507f3deb AS go-base
WORKDIR /src
ENV CGO_ENABLED=0 GOTOOLCHAIN=local GOFLAGS=-mod=readonly
COPY go.mod ./
COPY cmd ./cmd
COPY internal ./internal
ARG VERSION
ARG TARGETOS
ARG TARGETARCH
RUN mkdir -m 0700 -p /out/data

# The API has no npm build or embedded frontend dependency.
FROM go-base AS api-build
RUN GOOS=$TARGETOS GOARCH=$TARGETARCH go build -tags=api -trimpath -buildvcs=false \
      -ldflags="-s -w -buildid= -X main.version=${VERSION:-dev}" \
      -o /out/nullbin ./cmd/nullbin

# Optional combined binary, retained for local development and releases.
FROM go-base AS go
COPY --from=web /src/internal/assets/dist/ ./internal/assets/dist/
RUN GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -buildvcs=false \
      -ldflags="-s -w -buildid= -X main.version=${VERSION:-dev}" \
      -o /out/nullbin ./cmd/nullbin

# --- release artifacts (binary + bundles), for `--output type=local` ------
FROM scratch AS artifacts
COPY --from=go /out/nullbin /nullbin
COPY --from=web /src/internal/assets/dist/app.js /src/internal/assets/dist/app.css /src/internal/assets/dist/index.html /dist/

# Export only the files to upload to an independent static host.
FROM scratch AS frontend-files
COPY --from=web /src/web/dist/ /

# Export an API binary without installing Node.js.
FROM scratch AS backend-artifacts
COPY --from=api-build /out/nullbin /nullbin

# --- HTTPS proxy -------------------------------------------------------------
# Caddy is one static binary. Run it without the Alpine userland it ships in
# (no shell, tools or package manager) and as a non-root user, like the API.
FROM caddy:2.11.8-alpine@sha256:3db3a09e418f86a8fce8de4bc0026fccd2b4cd925aef00cc7d843d9fdc75e442 AS caddy-dist
RUN mkdir -m 0700 -p /state/data /state/config

FROM gcr.io/distroless/static-debian13:nonroot@sha256:25ac8f0c3b2334a9eb05452266bd4697864a8c8ef0ef71e5e6480d7f92868329 AS proxy
COPY --from=caddy-dist /usr/bin/caddy /usr/bin/caddy
# Certificates and Caddy's state, owned by the non-root user.
COPY --from=caddy-dist --chown=65532:65532 /state/data /data
COPY --from=caddy-dist --chown=65532:65532 /state/config /config
ENV XDG_DATA_HOME=/data XDG_CONFIG_HOME=/config
USER 65532:65532
WORKDIR /srv
EXPOSE 80 443
ENTRYPOINT ["/usr/bin/caddy"]
CMD ["run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]

# The frontend files and the one-server Caddyfile, served by that proxy.
FROM proxy AS frontend
COPY --from=web /src/web/dist/ /srv/
COPY --from=web /src/web/generated/headers.caddy /etc/caddy/headers.caddy
COPY deploy/Caddyfile /etc/caddy/Caddyfile

# An API-only image: only Go source is needed to build this target.
FROM gcr.io/distroless/static-debian13:nonroot@sha256:25ac8f0c3b2334a9eb05452266bd4697864a8c8ef0ef71e5e6480d7f92868329 AS backend
COPY --from=api-build /out/nullbin /nullbin
COPY --from=go-base --chown=65532:65532 /out/data /data
ENV NULLBIN_LISTEN_ADDR=:8080 NULLBIN_DATA_DIR=/data NULLBIN_API_ONLY=true
USER 65532:65532
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["/nullbin", "healthcheck"]
ENTRYPOINT ["/nullbin"]

# --- runtime image (default target) ----------------------------------------
FROM gcr.io/distroless/static-debian13:nonroot@sha256:25ac8f0c3b2334a9eb05452266bd4697864a8c8ef0ef71e5e6480d7f92868329
COPY --from=go /out/nullbin /nullbin
COPY --from=go --chown=65532:65532 /out/data /data
ENV NULLBIN_LISTEN_ADDR=:8080 \
    NULLBIN_DATA_DIR=/data
USER 65532:65532
EXPOSE 8080
VOLUME ["/data"]
# No shell or curl in the image: the binary checks itself.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["/nullbin", "healthcheck"]
ENTRYPOINT ["/nullbin"]
