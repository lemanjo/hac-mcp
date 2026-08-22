# Home Assistant Admin MCP

Home Assistant Admin MCP lets AI tools inspect, troubleshoot, control, and manage a Home Assistant installation. It works with MCP clients such as OpenCode, Codex, and Claude Code.

The server connects to Home Assistant with a long-lived access token. It can also use a restricted mount of the Home Assistant configuration directory for YAML changes, checkpoints, and local Git history.

> [!WARNING]
> `admin` mode can change Home Assistant configuration and restart Home Assistant. Start with `read_only`, use a dedicated Home Assistant account, and expose the MCP port only to devices you trust.

## What it can do

- List states, devices, entities, areas, integrations, services, history, logs, and traces.
- Find unavailable or misconfigured entities, broken automations, missing references, and other common problems.
- Control devices and run Home Assistant services.
- Manage automations, scripts, scenes, helpers, areas, registries, and selected integration settings.
- Read and patch approved YAML files, create checkpoints, validate changes, and roll back failed changes.

It does not manage Home Assistant add-ons, Supervisor backups, Docker, or the host operating system. It cannot run shell commands or read arbitrary files.

Some administrative tools use Home Assistant interfaces that can change between Home Assistant releases. Test administrative changes after upgrading Home Assistant.

## Permission modes

Set `MCP_MODE` to one of these values:

| Mode        | What it allows                                                                 |
| ----------- | ------------------------------------------------------------------------------ |
| `read_only` | Reading, searches, diagnostics, logs, history, and validation.                 |
| `control`   | Everything above, plus device control and normal Home Assistant service calls. |
| `admin`     | Everything above, plus persistent configuration changes, reloads, and restart. |

The mode is a hard limit. An MCP client cannot raise it.

High-impact actions require `confirm: true` by default. Locks, alarms, sirens, and covers with `garage` or `gate` in the entity ID also require confirmation. These rules can be changed in `config.yaml`.

## Git-backed configuration history

Git support gives file-backed Home Assistant changes an audit trail. After a successful YAML change, the server can create a local commit containing only the files changed by that operation. This makes it easier to see what an AI client changed, compare the working tree with committed configuration, and safely undo the latest service-created commit.

Git complements the transaction checkpoints in `.ha-mcp/backups`: checkpoints support file recovery during validation failures, while Git provides readable long-term history and diffs. Neither replaces a Home Assistant backup.

### Prepare the repository

The Home Assistant configuration directory must already be inside a Git repository. The server deliberately does not initialize repositories, clone, pull, push, or configure remotes. With the standard Docker and Unraid mounts, the simplest arrangement is to initialize the repository directly in the directory mounted at `/ha-config`.

On the Docker host, create a baseline commit before allowing MCP configuration changes. Review the ignore rules and tracked files for your installation; do not commit secrets or Home Assistant runtime data.

```bash
cd /absolute/path/to/home-assistant/config
git init
cat > .gitignore <<'EOF'
.storage/
.ha-mcp/
secrets.yaml
secrets.yml
home-assistant_v2.db*
*.log*
EOF
git add .gitignore configuration.yaml
git -c user.name="Home Assistant owner" \
  -c user.email="owner@example.com" \
  commit -m "Baseline Home Assistant configuration"
```

Add other YAML files and allowed directories, such as `automations.yaml` or `packages/`, only after checking that they contain no credentials. Existing repositories only need to be accessible through the configuration mount.

The container's `PUID` and `PGID` must be able to read and write both the tracked files and the repository's `.git` directory. You can verify access using the same container identity:

```bash
docker compose run --rm --entrypoint /usr/bin/git hac-mcp \
  -C /ha-config status --short
```

Enable the feature in `.env`:

```dotenv
HA_GIT_ENABLED=true
```

It is enabled by default in the supplied configuration. Set `HA_GIT_ENABLED=false` if the mounted directory is not a repository and you only want transaction checkpoints.

Set the identity used for service-created commits in `config.yaml` if you want to distinguish installations or environments:

```yaml
git:
  enabled: true
  authorName: Home Assistant Admin MCP
  authorEmail: home-assistant-admin-mcp@example.invalid
```

### How it behaves

- `patch_yaml_file` commits by default when Git is enabled. A custom `commit_message` can describe the reason for the change.
- A dry run returns the proposed diff without writing files or creating a commit.
- The server creates a checkpoint, writes atomically, validates with Home Assistant, performs the requested reload and health check, and only then creates the Git commit.
- A commit includes only the configuration paths selected by that operation. Unrelated staged or working-tree changes are left alone.
- If a target file already had uncommitted changes before the operation, the configuration transaction can still succeed, but the automatic commit is skipped and a warning is returned. Resolve and commit those changes manually before asking the server to try again.
- Git failures do not undo an otherwise validated Home Assistant change. The result includes a warning, and the checkpoint remains available.

History and diff tools are available in `read_only` mode. Applying configuration changes requires `admin` mode, and rollback additionally requires the normal high-impact confirmation. Git-aware MCP tools include:

| Tool                 | Use                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------- |
| `get_config_history` | Show bounded commit history for the whole configuration or one allowed file.                            |
| `get_config_diff`    | Show the current unstaged or staged diff for explicitly allowed paths, with sensitive values redacted.  |
| `get_recent_changes` | Show recent Git commits alongside transaction checkpoints.                                              |
| `rollback_to_commit` | Undo the service-created current `HEAD`, create a rollback commit, validate Home Assistant, and reload. |
| `rollback_change`    | Restore a transaction checkpoint independently of Git history.                                          |

Useful requests include:

- `Show the last 10 configuration changes and explain what changed.`
- `Show the uncommitted diff for packages/lighting.yaml.`
- `Dry-run this YAML change and show me the diff. Do not apply or commit it yet.`
- `Apply the reviewed change with commit message "Adjust evening lighting schedule".`
- `Dry-run rolling back the latest MCP-created commit, then wait for confirmation.`

For safety, Git rollback is intentionally narrow: it only accepts the current `HEAD`, the commit must use the configured service author email, and affected files must have no newer uncommitted changes. Rollback creates a new commit instead of rewriting history. If Home Assistant validation fails, the server attempts a compensating commit to restore the pre-rollback state.

## Docker Compose setup

### Requirements

- Docker Engine with Compose v2.
- A Home Assistant URL reachable from the container.
- A [Home Assistant long-lived access token](https://developers.home-assistant.io/docs/auth_api/#long-lived-access-token).
- The Home Assistant configuration directory if you want file-backed configuration tools.

Use a Home Assistant administrator token only if you need administrative tools.

### Install

```bash
git clone https://github.com/lemanjo/hac-mcp.git
cd hac-mcp
cp .env.example .env
cp config.example.yaml config.yaml
install -d -m 700 secrets
openssl rand -hex 32 > secrets/mcp_auth_token
read -rsp "Home Assistant token: " HA_TOKEN
printf '%s' "$HA_TOKEN" > secrets/home_assistant_token
unset HA_TOKEN
chmod 600 secrets/home_assistant_token secrets/mcp_auth_token
```

Edit `.env` and set at least:

```dotenv
MCP_IMAGE=lemanjo/hac-mcp:nightly
HOME_ASSISTANT_URL=http://192.168.1.10:8123
HA_CONFIG_PATH=/absolute/path/to/home-assistant/config
MCP_SETTINGS_FILE=./config.yaml
PUID=1000
PGID=1000
MCP_MODE=read_only
```

`PUID` and `PGID` must identify a non-root user that can read and write `HA_CONFIG_PATH`. Use an exact release image instead of `nightly` when one is available.

Start the published image:

```bash
docker compose pull hac-mcp
docker compose up -d --no-build hac-mcp
docker compose ps
```

To build from the current source instead, leave `MCP_IMAGE=home-assistant-admin-mcp:local` and run:

```bash
docker compose build --pull
docker compose up -d
```

Check the service:

```bash
curl --fail http://127.0.0.1:3000/livez
curl --fail http://127.0.0.1:3000/readyz
```

- `/livez` checks that the MCP server is running.
- `/readyz` checks that the server can authenticate with Home Assistant.

### Access from other LAN devices

The default Compose setup publishes the port only on the Docker host. To use clients on other trusted LAN devices, set:

```dotenv
MCP_BIND_IP=0.0.0.0
MCP_ALLOWED_HOSTS=192.168.1.10,home-server,home-server.local,localhost,127.0.0.1,hac-mcp
```

Replace the example IP and names with the addresses used to reach the Docker host. `MCP_ALLOWED_HOSTS` contains server addresses from the client URL, not client device addresses.

Connect clients to `http://192.168.1.10:3000/mcp`. Leave `MCP_ALLOWED_ORIGINS` empty for command-line clients. Restrict port `3000` to your LAN with firewall rules, and do not expose it directly to the internet. The server does not provide HTTPS; use a trusted reverse proxy if traffic leaves a trusted network.

## Unraid setup

### Prepare files

Open the Unraid terminal and adjust the paths, user ID, and group ID for your installation:

```bash
APPDATA=/mnt/user/appdata/hac-mcp
HA_CONFIG=/mnt/user/appdata/home-assistant
RUN_UID=99
RUN_GID=100

test -f "$HA_CONFIG/configuration.yaml"
install -d -o "$RUN_UID" -g "$RUN_GID" -m 700 "$APPDATA/secrets"
curl --fail --location \
  --output "$APPDATA/config.yaml" \
  https://raw.githubusercontent.com/lemanjo/hac-mcp/main/config.example.yaml
openssl rand -hex 32 > "$APPDATA/secrets/mcp_auth_token"
read -rsp "Home Assistant token: " HA_TOKEN
printf '%s' "$HA_TOKEN" > "$APPDATA/secrets/home_assistant_token"
unset HA_TOKEN
chown "$RUN_UID:$RUN_GID" "$APPDATA/config.yaml" "$APPDATA/secrets/"*
chmod 600 "$APPDATA/config.yaml" "$APPDATA/secrets/"*
```

The example uses Unraid's common `99:100` identity. Use the IDs that can access your actual Home Assistant configuration directory.

### Add the container

In **Docker > Add Container**, enable **Advanced View** and use:

| Field            | Value                                                                                                                                                      |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Name             | `hac-mcp`                                                                                                                                                  |
| Repository       | `lemanjo/hac-mcp:nightly`, or an exact release tag                                                                                                         |
| Network Type     | `bridge`                                                                                                                                                   |
| Privileged       | `Off`                                                                                                                                                      |
| Port             | Container `3000`, host `3000`, TCP                                                                                                                         |
| Extra Parameters | `--user=99:100 --read-only --security-opt=no-new-privileges:true --cap-drop=ALL --pids-limit=256 --stop-timeout=20 --tmpfs=/tmp:rw,noexec,nosuid,size=64m` |

Replace `99:100` in Extra Parameters if you selected different IDs. Do not add `PUID` or `PGID` variables in Unraid; the application does not read them.

Add these paths:

| Host path                                                | Container path                      | Access     |
| -------------------------------------------------------- | ----------------------------------- | ---------- |
| `/mnt/user/appdata/hac-mcp/config.yaml`                  | `/app/config.yaml`                  | Read Only  |
| `/mnt/user/appdata/hac-mcp/secrets/home_assistant_token` | `/run/secrets/home_assistant_token` | Read Only  |
| `/mnt/user/appdata/hac-mcp/secrets/mcp_auth_token`       | `/run/secrets/mcp_auth_token`       | Read Only  |
| Your Home Assistant configuration directory              | `/ha-config`                        | Read/Write |

Do not mount `/var/run/docker.sock`.

Add these variables:

| Variable                    | Value                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------- |
| `HOME_ASSISTANT_URL`        | Home Assistant URL reachable from the container, such as `http://192.168.1.10:8123`         |
| `HOME_ASSISTANT_TOKEN_FILE` | `/run/secrets/home_assistant_token`                                                         |
| `MCP_CONFIG_FILE`           | `/app/config.yaml`                                                                          |
| `MCP_AUTH_TOKEN_FILE`       | `/run/secrets/mcp_auth_token`                                                               |
| `MCP_MODE`                  | Start with `read_only`; use `control` or `admin` when needed                                |
| `MCP_TRANSPORT`             | `http`                                                                                      |
| `MCP_HOST`                  | `0.0.0.0`                                                                                   |
| `MCP_PORT`                  | `3000`                                                                                      |
| `MCP_ALLOWED_HOSTS`         | Unraid IP and names used by clients, plus `localhost,127.0.0.1,hac-mcp`                     |
| `MCP_ALLOWED_ORIGINS`       | Leave empty for command-line clients                                                        |
| `HA_CONFIG_PATH`            | `/ha-config`                                                                                |
| `HA_GIT_ENABLED`            | `true` only if the mounted configuration is already a Git repository; otherwise use `false` |

If Home Assistant uses host networking, do not use `localhost` in `HOME_ASSISTANT_URL`; inside this container, `localhost` means the MCP container itself.

Apply the container and test from the Unraid terminal:

```bash
curl --fail http://127.0.0.1:3000/livez
curl --fail http://127.0.0.1:3000/readyz
docker inspect --format '{{json .State.Health}}' hac-mcp
```

Back up `/mnt/user/appdata/hac-mcp` and the Home Assistant configuration directory. File checkpoints are stored in `/ha-config/.ha-mcp/backups` and are not deleted automatically.

## Connect an MCP client

The MCP endpoint is:

```text
http://<server-address>:3000/mcp
```

Every HTTP request needs the MCP token from `secrets/mcp_auth_token`. This is not the Home Assistant token.

Load the token on the client device without putting it directly in a committed configuration file:

```bash
export HAC_MCP_TOKEN="$(tr -d '\r\n' < ~/.config/hac-mcp/token)"
```

### OpenCode

Add this to `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "home-assistant-admin": {
      "type": "remote",
      "url": "http://192.168.1.10:3000/mcp",
      "enabled": true,
      "oauth": false,
      "headers": {
        "Authorization": "Bearer {env:HAC_MCP_TOKEN}"
      },
      "timeout": 150000
    }
  }
}
```

Restart OpenCode, then run:

```bash
opencode mcp debug home-assistant-admin
```

### Codex

Add this to `~/.codex/config.toml` or a trusted project's `.codex/config.toml`:

```toml
[mcp_servers.home-assistant-admin]
url = "http://192.168.1.10:3000/mcp"
bearer_token_env_var = "HAC_MCP_TOKEN"
enabled = true
default_tools_approval_mode = "writes"
tool_timeout_sec = 150
```

### Claude Code

Add this to the project's `.mcp.json`:

```json
{
  "mcpServers": {
    "home-assistant-admin": {
      "type": "http",
      "url": "http://192.168.1.10:3000/mcp",
      "headers": {
        "Authorization": "Bearer ${HAC_MCP_TOKEN}"
      },
      "timeout": 150000
    }
  }
}
```

Replace `192.168.1.10` with the Docker or Unraid host address. Add that exact IP or hostname to `MCP_ALLOWED_HOSTS`.

Useful first requests:

- `List unavailable entities. Do not make changes.`
- `Explain why light.office is unavailable using recent logs and registry data.`
- In `control` mode: `Turn on light.office.`
- In `admin` mode: `Dry-run this change, show me the result, and wait before applying it.`

## Environment variables

Configuration is loaded from `MCP_CONFIG_FILE` first. Environment variables then override matching values from the file.

The defaults below are application defaults. The supplied Compose file and `config.example.yaml` override a few defaults as noted.

### Application variables

| Variable                        | Default               | Required                      | Purpose                                                                                         |
| ------------------------------- | --------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------- |
| `MCP_CONFIG_FILE`               | None                  | No                            | YAML configuration file. Compose sets this to `/app/config.yaml`.                               |
| `HOME_ASSISTANT_URL`            | None                  | Yes, here or in YAML          | Home Assistant base URL as seen from the server.                                                |
| `HOME_ASSISTANT_TOKEN`          | None                  | One HA token source           | Home Assistant long-lived access token. Prefer the file variable.                               |
| `HOME_ASSISTANT_TOKEN_FILE`     | None                  | One HA token source           | File containing the Home Assistant token. Takes priority over `HOME_ASSISTANT_TOKEN`.           |
| `HA_REQUEST_TIMEOUT_MS`         | `30000`               | No                            | REST request timeout, from `1000` to `120000` milliseconds.                                     |
| `HA_WEBSOCKET_TIMEOUT_MS`       | `30000`               | No                            | WebSocket command timeout, from `1000` to `120000` milliseconds.                                |
| `HA_VERIFY_TLS`                 | `true`                | No                            | Verify the Home Assistant HTTPS certificate.                                                    |
| `MCP_MODE`                      | `read_only`           | No                            | Permission mode: `read_only`, `control`, or `admin`.                                            |
| `MCP_TRANSPORT`                 | `http`                | No                            | MCP transport: `http` or `stdio`.                                                               |
| `MCP_HOST`                      | `127.0.0.1`           | No                            | Address the HTTP server listens on. Compose and the example YAML use `0.0.0.0` inside Docker.   |
| `MCP_PORT`                      | `3000`                | No                            | HTTP server port.                                                                               |
| `MCP_AUTH_TOKEN`                | None                  | One MCP token source for HTTP | MCP client token, at least 16 characters. Prefer the file variable.                             |
| `MCP_AUTH_TOKEN_FILE`           | None                  | One MCP token source for HTTP | File containing the MCP client token. Takes priority over `MCP_AUTH_TOKEN`.                     |
| `MCP_ALLOWED_HOSTS`             | `localhost,127.0.0.1` | No                            | Comma-separated server IPs and names accepted from request `Host` headers. No schemes or ports. |
| `MCP_ALLOWED_ORIGINS`           | Empty                 | No                            | Comma-separated browser origin hostnames. Leave empty for non-browser clients.                  |
| `HA_CONFIG_PATH`                | `/ha-config`          | For filesystem tools          | Home Assistant configuration root inside the server or container.                               |
| `HA_FILESYSTEM_ENABLED`         | `true`                | No                            | Enable approved configuration file reads and writes.                                            |
| `HA_ALLOW_SECRET_VALUES`        | `false`               | No                            | Allow secret-bearing YAML values to be read or changed. Leave disabled in normal use.           |
| `HA_ALLOW_CUSTOM_COMPONENTS`    | `false`               | No                            | Allow approved reads from `custom_components`.                                                  |
| `HA_ALLOWED_CONFIG_DIRECTORIES` | `packages,themes`     | No                            | Comma-separated YAML subdirectories that filesystem tools may access.                           |
| `HA_GIT_ENABLED`                | `true`                | No                            | Enable local Git history and commits when the configuration is already in a Git repository.     |

Boolean variables accept `true`, `false`, `1`, `0`, `yes`, `no`, `on`, or `off`. Token files are trimmed when read.

Settings without environment-variable overrides remain in `config.yaml`. These include request-size limits, file-size limits, backup location, confirmation rules, sensitive entities, cache times, and Git author details. See [`config.example.yaml`](config.example.yaml) for the full YAML structure.

### Compose-only variables

These variables are read by `docker-compose.yml` to configure the container:

| Variable                | Default                          | Required | Purpose                                                                                 |
| ----------------------- | -------------------------------- | -------- | --------------------------------------------------------------------------------------- |
| `MCP_IMAGE`             | `home-assistant-admin-mcp:local` | No       | Image to build or run. Use `lemanjo/hac-mcp:nightly` or an exact release tag.           |
| `MCP_BIND_IP`           | `127.0.0.1`                      | No       | Host address that publishes the MCP port. Use `0.0.0.0` for intentional LAN access.     |
| `MCP_PUBLISHED_PORT`    | `3000`                           | No       | Port exposed on the Docker host.                                                        |
| `HA_CONFIG_PATH`        | None                             | Yes      | Existing host configuration directory mounted at `/ha-config`.                          |
| `MCP_SETTINGS_FILE`     | `./config.example.yaml`          | No       | Host YAML file mounted at `/app/config.yaml`.                                           |
| `HA_TOKEN_SECRET_FILE`  | `./secrets/home_assistant_token` | No       | Host file mounted as the Home Assistant token.                                          |
| `MCP_TOKEN_SECRET_FILE` | `./secrets/mcp_auth_token`       | No       | Host file mounted as the MCP client token.                                              |
| `PUID`                  | `1000`                           | No       | Numeric user ID used to run the container. Must have access to the configuration mount. |
| `PGID`                  | `1000`                           | No       | Numeric group ID used to run the container.                                             |

## Safety and file changes

- The Home Assistant token controls what the server may do in Home Assistant. The separate MCP token controls who may call this server.
- Most persistent changes support `dry_run: true`. Device controls do not simulate an action.
- YAML changes create a checkpoint, write files safely, ask Home Assistant to validate its configuration, and attempt rollback if validation fails.
- Filesystem tools are limited to root YAML files and configured YAML directories. Protected storage, databases, Git internals, private keys, symlinks, and paths outside the configuration root are blocked.
- Secret values are hidden by default. Keep `HA_ALLOW_SECRET_VALUES=false` unless you have a specific recovery need and fully trust the MCP client.
- Git support is local only. The server does not clone, pull, push, or manage remotes.
- File checkpoints are not Home Assistant backups. Back up Home Assistant separately and clean old `.ha-mcp/backups` files according to your own retention policy.

## Troubleshooting

| Problem                                     | What to check                                                                                                                |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| MCP client gets `401`                       | The MCP bearer token is missing or does not match `MCP_AUTH_TOKEN_FILE`.                                                     |
| MCP client gets `403` or an SSE `403` error | Add the IP or hostname from the client URL to `MCP_ALLOWED_HOSTS`. Browser clients may also need `MCP_ALLOWED_ORIGINS`.      |
| `/readyz` returns `503`                     | Check `HOME_ASSISTANT_URL`, the Home Assistant token, container networking, and Home Assistant permissions.                  |
| Home Assistant URL uses `localhost`         | In a container, `localhost` is that container. Use the host LAN IP, `host.docker.internal`, or a shared Docker-network name. |
| Tool returns `OPERATION_NOT_PERMITTED`      | Raise `MCP_MODE` to `control` or `admin` if the operation should be allowed.                                                 |
| Tool returns `CONFIRMATION_REQUIRED`        | Review the requested action, then retry with `confirm: true` if it is correct.                                               |
| Administrative Home Assistant calls fail    | Use a token belonging to a Home Assistant administrator and check compatibility with the installed Home Assistant release.   |
| File operations report permission errors    | Make sure `/ha-config` is mounted read/write and the container UID/GID can access it.                                        |
| Git reports that no repository was detected | Initialize and manage the repository outside this server, or set `HA_GIT_ENABLED=false`.                                     |
| Requests are rejected as too large          | Reduce the request or raise `mcp.maxRequestBytes` in `config.yaml`, up to the documented schema limit.                       |

Container logs are available with:

```bash
docker compose logs -f hac-mcp
```

## Local development

Node.js 22 and pnpm 11.21.0 are required.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm test
```

Run all repository checks before publishing changes:

```bash
pnpm supply-chain:check
pnpm audit --prod --audit-level high
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
```

Every container build reports all known runtime vulnerabilities and fails on fixable findings. Publishing workflows scan both `linux/amd64` and `linux/arm64` before pushing. Every push to `main` publishes `lemanjo/hac-mcp:nightly` and an immutable `nightly-<commit-sha>` image. GitHub releases publish versioned images for both architectures.

> [!NOTE]
> This project is built with AI-assisted development tools.

## License

[MIT](LICENSE)
