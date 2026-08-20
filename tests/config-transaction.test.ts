import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Settings } from "../src/config/settings.js";
import type { GitClient } from "../src/config/git.js";
import {
  ConfigTransaction,
  createStructuredUnifiedDiff,
  type ConfigTransactionContext,
} from "../src/config/transaction.js";

function settingsFixture(root: string): Settings {
  return {
    homeAssistant: {
      url: "http://127.0.0.1:8123",
      token: "test-home-assistant-token",
      requestTimeoutMs: 30_000,
      websocketTimeoutMs: 30_000,
      verifyTls: true,
    },
    mcp: {
      mode: "admin",
      transport: "stdio",
      host: "127.0.0.1",
      port: 3000,
      authToken: "test-mcp-auth-token",
      allowedHosts: ["localhost", "127.0.0.1"],
      allowedOrigins: [],
      maxRequestBytes: 1_048_576,
    },
    filesystem: {
      root,
      enabled: true,
      allowSecretsMetadata: true,
      allowSecretValues: false,
      allowCustomComponents: false,
      allowedDirectories: ["packages", "themes"],
      maxReadBytes: 2_097_152,
      backupDirectory: ".ha-mcp/backups",
    },
    git: {
      enabled: false,
      authorName: "Home Assistant Admin MCP Tests",
      authorEmail: "home-assistant-admin-mcp-tests@localhost",
    },
    permissions: {
      requireConfirmationFor: ["HIGH_IMPACT"],
      sensitiveDomains: {
        lock: "confirm",
        alarm_control_panel: "confirm",
        siren: "confirm",
      },
      sensitiveCovers: ["garage", "gate"],
    },
    cache: {
      registryTtlMs: 30_000,
      servicesTtlMs: 30_000,
    },
  };
}

describe("ConfigTransaction", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp("/tmp/hac-mcp-transaction-");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("performs a dry run with a diff but no writes, backups, or callbacks", async () => {
    const original = "# managed\nlight:\n  enabled: false\n";
    await writeFile(path.join(root, "configuration.yaml"), original);
    const validate = vi.fn(() => Promise.resolve(true));
    const reload = vi.fn(() => Promise.resolve(true));
    const health = vi.fn(() => Promise.resolve(true));
    const transaction = new ConfigTransaction(settingsFixture(root), {
      validate,
      reload,
      health,
    });

    const result = await transaction.execute({
      changes: [
        {
          path: "configuration.yaml",
          patches: [{ op: "set", path: ["light", "enabled"], value: true }],
        },
      ],
      dryRun: true,
    });

    expect(result).toMatchObject({
      changed: true,
      dryRun: true,
      paths: ["configuration.yaml"],
      warnings: [],
    });
    expect(result.checkpoint).toBeUndefined();
    expect(result.diffs).toHaveLength(1);
    expect(result.diffs[0]).toMatchObject({
      path: "configuration.yaml",
      additions: 1,
      deletions: 1,
    });
    expect(result.diffs[0]?.unified).toContain("-  enabled: false");
    expect(result.diffs[0]?.unified).toContain("+  enabled: true");
    expect(await readFile(path.join(root, "configuration.yaml"), "utf8")).toBe(original);
    await expect(access(path.join(root, ".ha-mcp"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(validate).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(health).not.toHaveBeenCalled();
  });

  it("restores written files when Home Assistant validation rejects the change", async () => {
    const original = "homeassistant:\n  name: Before\n";
    const changed = "homeassistant:\n  name: After\n";
    await writeFile(path.join(root, "configuration.yaml"), original, { mode: 0o640 });
    const validate = vi.fn((context: ConfigTransactionContext) => {
      expect(context.rollback).toBe(false);
      return Promise.resolve({ ok: false, message: "configuration check failed" });
    });
    const reload = vi.fn((context: ConfigTransactionContext) => {
      expect(context.rollback).toBe(true);
      return Promise.resolve(true);
    });
    const health = vi.fn((context: ConfigTransactionContext) => {
      expect(context.rollback).toBe(true);
      return Promise.resolve(true);
    });
    const transaction = new ConfigTransaction(settingsFixture(root), {
      validate,
      reload,
      health,
    });

    await expect(
      transaction.execute({
        changes: [{ path: "configuration.yaml", content: changed }],
      }),
    ).rejects.toMatchObject({
      code: "CONFIG_TRANSACTION_FAILED",
      details: {
        cause_code: "CONFIG_CALLBACK_REJECTED",
        checkpoint_id: expect.any(String),
        rollback_restored_files: true,
        rollback_error: null,
      },
    });

    expect(await readFile(path.join(root, "configuration.yaml"), "utf8")).toBe(original);
    expect(validate).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(health).toHaveBeenCalledTimes(1);
    const rollbackContext = reload.mock.calls[0]?.[0];
    expect(rollbackContext).toMatchObject({
      paths: ["configuration.yaml"],
      rollback: true,
      checkpointId: expect.any(String),
    });
    expect(health.mock.calls[0]?.[0]).toEqual(rollbackContext);
  });

  it("validates, reloads, and checks health after a successful write", async () => {
    const original = "# managed\nlight:\n  enabled: false\n";
    await writeFile(path.join(root, "configuration.yaml"), original);
    const calls: string[] = [];
    const contexts: ConfigTransactionContext[] = [];
    const callback = (name: string) =>
      vi.fn((context: ConfigTransactionContext) => {
        calls.push(name);
        contexts.push(context);
        return Promise.resolve({ ok: true });
      });
    const validate = callback("validate");
    const reload = callback("reload");
    const health = callback("health");
    const transaction = new ConfigTransaction(settingsFixture(root), {
      validate,
      reload,
      health,
    });

    const result = await transaction.execute({
      changes: [
        {
          path: "configuration.yaml",
          patches: [{ op: "set", path: ["light", "enabled"], value: true }],
        },
      ],
      backupLabel: "successful transaction",
    });

    expect(calls).toEqual(["validate", "reload", "health"]);
    expect(contexts).toHaveLength(3);
    expect(contexts.every((context) => context.rollback === false)).toBe(true);
    expect(contexts.map((context) => context.checkpointId)).toEqual([
      result.checkpoint?.id,
      result.checkpoint?.id,
      result.checkpoint?.id,
    ]);
    expect(result).toMatchObject({
      changed: true,
      dryRun: false,
      paths: ["configuration.yaml"],
      checkpoint: { label: "successful transaction" },
      warnings: [],
    });
    expect(result.diffs).toHaveLength(1);
    expect(result.gitCommit).toBeUndefined();
    expect(await readFile(path.join(root, "configuration.yaml"), "utf8")).toBe(
      "# managed\nlight:\n  enabled: true\n",
    );
  });

  it("skips automatic commit when a target file was already dirty", async () => {
    await writeFile(path.join(root, "configuration.yaml"), "name: Human edit\n");
    const configured = settingsFixture(root);
    configured.git.enabled = true;
    const commitFiles = vi.fn();
    const git = {
      detect: vi.fn(() => Promise.resolve({ root, configRoot: root, head: "abc", branch: "main" })),
      status: vi.fn(() =>
        Promise.resolve([{ path: "configuration.yaml", index: " ", worktree: "M" }]),
      ),
      commitFiles,
    } as unknown as GitClient;
    const transaction = new ConfigTransaction(
      configured,
      {
        validate: () => Promise.resolve(true),
        reload: () => Promise.resolve(true),
        health: () => Promise.resolve(true),
      },
      { git },
    );

    const result = await transaction.execute({
      changes: [
        {
          path: "configuration.yaml",
          patches: [{ op: "set", path: ["mcp_changed"], value: true }],
        },
      ],
    });

    expect(result.changed).toBe(true);
    expect(result.warnings).toContain(
      "Git commit skipped because target files had pre-existing changes: configuration.yaml",
    );
    expect(commitFiles).not.toHaveBeenCalled();
  });

  it("produces deterministic structured and unified diff metadata", () => {
    const before = "alpha: one\nremove: old\nkeep: same\n";
    const after = "alpha: two\nadd: new\nkeep: same\n";
    const diff = createStructuredUnifiedDiff("packages/example.yaml", before, after);

    expect(diff).toMatchObject({
      path: "packages/example.yaml",
      beforeSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      afterSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      additions: 2,
      deletions: 2,
      hunks: [
        {
          oldStart: 1,
          oldLines: 3,
          newStart: 1,
          newLines: 3,
          lines: ["-alpha: one", "-remove: old", "+alpha: two", "+add: new", " keep: same"],
        },
      ],
    });
    expect(diff.beforeSha256).not.toBe(diff.afterSha256);
    expect(diff.unified).toContain("--- a/packages/example.yaml\tbefore");
    expect(diff.unified).toContain("+++ b/packages/example.yaml\tafter");
    expect(diff.unified).toContain("@@ -1,3 +1,3 @@");
  });
});
