FROM mcr.microsoft.com/devcontainers/typescript-node:22-bookworm@sha256:7924e90b26ce5af8ed4e90258988c7bdf2cf9c953002445f18e64f00c1a2670c

ARG PNPM_VERSION=11.21.0
ARG OPENCODE_VERSION=1.18.18
ARG GH_VERSION=2.97.0
RUN su node -c "umask 0002 && npm install --global pnpm@${PNPM_VERSION} opencode-ai@${OPENCODE_VERSION}" \
    && npm cache clean --force > /dev/null 2>&1
RUN arch="$(dpkg --print-architecture)" \
    && case "${arch}" in \
      amd64) gh_sha256='7c7fa3bb890db0934baf65910d97b8c0fa437b2e590f7f7daf6bdf82c5c486d7' ;; \
      arm64) gh_sha256='0ba7a76739c865d82ebde24667d875d9b8caa55db47c7597c24accdd4defd2bb' ;; \
      *) printf 'Unsupported architecture: %s\n' "${arch}" >&2; exit 1 ;; \
    esac \
    && curl --fail --silent --show-error --location \
      --output /tmp/gh.deb \
      "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${arch}.deb" \
    && printf '%s  %s\n' "${gh_sha256}" /tmp/gh.deb | sha256sum --check --strict \
    && dpkg --install /tmp/gh.deb \
    && rm /tmp/gh.deb
