# Development Environment

- Use `.devcontainer/devcontainer.json` for development; it builds a Node 22 Debian Bookworm image with pnpm 11.21.0, OpenCode 1.18.18, and GitHub CLI 2.97.0, then connects as the non-root `node` user.
- The devcontainer does not add a Docker feature or mount the host Docker socket; do not assume Docker daemon access inside it.
- Use the scripts declared in `package.json`; run the supply-chain check, audit, typecheck, lint, format check, tests, and build before publishing changes.
