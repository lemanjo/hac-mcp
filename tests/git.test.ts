import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GitClient } from "../src/config/git.js";
import type { Settings } from "../src/config/settings.js";

const execute = promisify(execFile);

function settings(root: string): Settings {
  return {
    homeAssistant: {
      url: "http://127.0.0.1:8123",
      token: "test-token",
      requestTimeoutMs: 30_000,
      websocketTimeoutMs: 30_000,
      verifyTls: true,
    },
    mcp: {
      mode: "admin",
      transport: "stdio",
      host: "127.0.0.1",
      port: 3000,
      allowedHosts: ["localhost"],
      allowedOrigins: [],
      maxRequestBytes: 1_048_576,
    },
    filesystem: {
      root,
      enabled: true,
      allowSecretsMetadata: true,
      allowSecretValues: false,
      allowCustomComponents: false,
      allowedDirectories: ["packages"],
      maxReadBytes: 2_097_152,
      backupDirectory: ".ha-mcp/backups",
    },
    git: {
      enabled: true,
      authorName: "Home Assistant Admin MCP Tests",
      authorEmail: "home-assistant-admin-mcp-tests@localhost",
    },
    permissions: {
      requireConfirmationFor: ["HIGH_IMPACT"],
      sensitiveDomains: {},
      sensitiveCovers: ["garage", "gate"],
    },
    cache: { registryTtlMs: 30_000, servicesTtlMs: 30_000 },
  };
}

describe("GitClient", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp("/tmp/hac-mcp-git-");
    await mkdir(path.join(root, "packages"));
    await writeFile(path.join(root, "configuration.yaml"), "name: Before\n");
    await writeFile(path.join(root, "packages", "unrelated.yaml"), "value: one\n");
    await execute("git", ["-C", root, "init"]);
    await execute("git", ["-C", root, "add", "."]);
    await execute(
      "git",
      [
        "-C",
        root,
        "-c",
        "user.name=Human",
        "-c",
        "user.email=human@example.invalid",
        "commit",
        "-m",
        "Initial configuration",
      ],
      { env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } },
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("commits only selected files, preserves unrelated staging, and safely rolls back", async () => {
    const marker = path.join(root, "shell-injection-marker");
    await writeFile(path.join(root, "configuration.yaml"), "name: After\n");
    await writeFile(path.join(root, "packages", "unrelated.yaml"), "value: staged\n");
    await execute("git", ["-C", root, "add", "packages/unrelated.yaml"]);
    const client = new GitClient(settings(root));

    const commit = await client.commitFiles(["configuration.yaml"], {
      message: `MCP: update $(touch ${marker})`,
    });

    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(commit.authorEmail).toBe("home-assistant-admin-mcp-tests@localhost");
    expect(commit.subject).toContain("$(touch");
    expect(
      await execute("git", ["-C", root, "show", "--format=", "--name-only", "HEAD"]),
    ).toMatchObject({
      stdout: "configuration.yaml\n",
    });
    expect(await client.status(["packages/unrelated.yaml"])).toEqual([
      { path: "packages/unrelated.yaml", index: "M", worktree: " " },
    ]);

    const rollback = await client.rollbackCommit(commit.hash);

    expect(rollback.subject).toContain(`Rollback ${commit.hash.slice(0, 12)}`);
    expect(await readFile(path.join(root, "configuration.yaml"), "utf8")).toBe("name: Before\n");
    expect(await client.status(["packages/unrelated.yaml"])).toEqual([
      { path: "packages/unrelated.yaml", index: "M", worktree: " " },
    ]);
  });
});
