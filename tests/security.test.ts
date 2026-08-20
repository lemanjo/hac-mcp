import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { parse } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BackupManager } from "../src/config/backups.js";
import { loadConfigurationCatalog } from "../src/config/catalog.js";
import { ConfigFilesystem } from "../src/config/filesystem.js";
import { loadSettings, type Settings } from "../src/config/settings.js";
import { applyYamlPatches, validateYaml, yamlTopLevelKeys } from "../src/config/yaml-editor.js";
import { ConfigPathPolicy } from "../src/security/paths.js";
import { redactSecrets, secretKeyNames } from "../src/security/secrets.js";

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

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

describe("configuration security", () => {
  let root: string;
  let outsideRoot: string;

  beforeEach(async () => {
    root = await mkdtemp("/tmp/hac-mcp-security-");
    outsideRoot = await mkdtemp("/tmp/hac-mcp-outside-");
    await Promise.all([
      mkdir(path.join(root, ".storage")),
      mkdir(path.join(root, "packages", "room"), { recursive: true }),
      mkdir(path.join(root, "themes")),
      mkdir(path.join(root, "unlisted")),
      mkdir(path.join(root, "packages-other")),
    ]);
  });

  afterEach(async () => {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(outsideRoot, { recursive: true, force: true }),
    ]);
  });

  describe("path policy", () => {
    it("rejects traversal, absolute escapes, backslashes, and .storage", async () => {
      await writeFile(path.join(outsideRoot, "outside.yaml"), "outside: true\n");
      await writeFile(path.join(root, ".storage", "core.yaml"), "private: true\n");
      const policy = new ConfigPathPolicy(settingsFixture(root));

      await expect(policy.resolve("../../etc/passwd", "read")).rejects.toMatchObject({
        code: "INVALID_CONFIG_PATH",
      });
      await expect(
        policy.resolve(path.join(outsideRoot, "outside.yaml"), "read"),
      ).rejects.toMatchObject({ code: "CONFIG_PATH_OUTSIDE_ROOT" });
      await expect(policy.resolve("packages\\room\\lights.yaml", "read")).rejects.toMatchObject({
        code: "INVALID_CONFIG_PATH",
      });
      await expect(policy.resolve(".storage/core.yaml", "read")).rejects.toMatchObject({
        code: "SENSITIVE_CONFIG_PATH",
      });
    });

    it.each([
      ["credential.yaml", "credential: value\n"],
      ["credentials.yaml", "credentials: value\n"],
      ["private-key.pem", "not-a-real-private-key\n"],
      ["recorder.db", "not-a-real-database\n"],
    ])("denies sensitive file %s", async (fileName, content) => {
      await writeFile(path.join(root, fileName), content);

      await expect(
        new ConfigPathPolicy(settingsFixture(root)).resolve(fileName, "read"),
      ).rejects.toMatchObject({ code: "SENSITIVE_CONFIG_PATH" });
    });

    it("rejects both in-root and escaping symbolic links", async () => {
      await writeFile(path.join(root, "configuration.yaml"), "homeassistant: {}\n");
      await writeFile(path.join(outsideRoot, "outside.yaml"), "outside: true\n");
      await symlink("configuration.yaml", path.join(root, "inside-link.yaml"));
      await symlink(path.join(outsideRoot, "outside.yaml"), path.join(root, "escape-link.yaml"));
      const policy = new ConfigPathPolicy(settingsFixture(root));

      await expect(policy.resolve("inside-link.yaml", "read")).rejects.toMatchObject({
        code: "CONFIG_SYMLINK_DENIED",
      });
      await expect(policy.resolve("escape-link.yaml", "read")).rejects.toMatchObject({
        code: "CONFIG_SYMLINK_DENIED",
      });
    });

    it("allows top-level YAML and explicitly allowlisted directories only", async () => {
      await Promise.all([
        writeFile(path.join(root, "configuration.yaml"), "homeassistant: {}\n"),
        writeFile(path.join(root, "packages", "room", "lights.yaml"), "light: {}\n"),
        writeFile(path.join(root, "themes", "night.yaml"), "night: {}\n"),
        writeFile(path.join(root, "unlisted", "blocked.yaml"), "blocked: true\n"),
        writeFile(path.join(root, "packages-other", "blocked.yaml"), "blocked: true\n"),
      ]);
      const policy = new ConfigPathPolicy(settingsFixture(root));

      await expect(policy.resolve("configuration.yaml", "read")).resolves.toMatchObject({
        relativePath: "configuration.yaml",
        kind: "yaml",
      });
      await expect(policy.resolve("packages/room/lights.yaml", "read")).resolves.toMatchObject({
        relativePath: "packages/room/lights.yaml",
        kind: "yaml",
      });
      await expect(policy.resolve("themes/night.yaml", "read")).resolves.toMatchObject({
        relativePath: "themes/night.yaml",
        kind: "yaml",
      });
      await expect(policy.resolve("unlisted/blocked.yaml", "read")).rejects.toMatchObject({
        code: "CONFIG_PATH_NOT_ALLOWED",
      });
      await expect(policy.resolve("packages-other/blocked.yaml", "read")).rejects.toMatchObject({
        code: "CONFIG_PATH_NOT_ALLOWED",
      });
    });

    it("allows selected custom component sources only after explicit opt-in", async () => {
      await mkdir(path.join(root, "custom_components", "example"), { recursive: true });
      await writeFile(
        path.join(root, "custom_components", "example", "__init__.py"),
        "DOMAIN = 'example'\n",
      );
      const disabled = settingsFixture(root);
      await expect(
        new ConfigPathPolicy(disabled).resolve("custom_components/example/__init__.py", "read"),
      ).rejects.toMatchObject({ code: "CONFIG_PATH_NOT_ALLOWED" });

      const enabled = settingsFixture(root);
      enabled.filesystem.allowCustomComponents = true;
      await expect(
        new ConfigFilesystem(enabled).readFile("custom_components/example/__init__.py"),
      ).resolves.toMatchObject({ kind: "custom_component", content: "DOMAIN = 'example'\n" });
    });
  });

  describe("secret handling", () => {
    it("defaults secret values to denied while exposing key-only metadata", async () => {
      const secretContent =
        "database_password: correct-horse-battery-staple\napi_token: token-value\n";
      const configFile = path.join(outsideRoot, "mcp-settings.yaml");
      await Promise.all([
        writeFile(path.join(root, "secrets.yaml"), secretContent),
        writeFile(configFile, "permissions: {}\ncache: {}\n"),
      ]);
      const loaded = await loadSettings({
        MCP_CONFIG_FILE: configFile,
        HOME_ASSISTANT_URL: "http://127.0.0.1:8123",
        HOME_ASSISTANT_TOKEN: "test-home-assistant-token",
        MCP_TRANSPORT: "stdio",
        HA_CONFIG_PATH: root,
        HA_GIT_ENABLED: "false",
      });
      const filesystem = new ConfigFilesystem(loaded);

      expect(loaded.filesystem.allowSecretValues).toBe(false);
      await expect(filesystem.readFile("secrets.yaml")).rejects.toMatchObject({
        code: "SECRET_VALUES_DENIED",
      });
      const metadata = await filesystem.metadata("secrets.yaml");
      expect(metadata).toEqual({
        path: "secrets.yaml",
        bytes: Buffer.byteLength(secretContent),
        modifiedAt: expect.any(String),
        kind: "secrets_metadata",
        secretKeys: ["api_token", "database_password"],
      });
      expect(JSON.stringify(metadata)).not.toContain("correct-horse-battery-staple");
      expect(JSON.stringify(metadata)).not.toContain("token-value");
    });

    it("does not override YAML booleans when their environment variables are absent", async () => {
      const configFile = path.join(outsideRoot, "boolean-settings.yaml");
      await writeFile(
        configFile,
        "homeAssistant:\n  verifyTls: false\nfilesystem:\n  enabled: false\ngit:\n  enabled: false\n",
      );

      const loaded = await loadSettings({
        MCP_CONFIG_FILE: configFile,
        HOME_ASSISTANT_URL: "http://127.0.0.1:8123",
        HOME_ASSISTANT_TOKEN: "test-home-assistant-token",
        MCP_TRANSPORT: "stdio",
      });

      expect(loaded.homeAssistant.verifyTls).toBe(false);
      expect(loaded.filesystem.enabled).toBe(false);
      expect(loaded.git.enabled).toBe(false);
    });

    it("redacts nested and commonly styled secret keys without changing safe values", () => {
      const value = {
        username: "home-assistant",
        password: "password-value",
        integration: {
          api_key: "snake-case-value",
          apiKey: "camel-case-value",
          clientSecret: "client-secret-value",
          endpoint: "http://127.0.0.1",
        },
        records: [{ access_token: "array-token-value", state: "ready" }],
      };

      expect(redactSecrets(value)).toEqual({
        username: "home-assistant",
        password: "[REDACTED]",
        integration: {
          api_key: "[REDACTED]",
          apiKey: "[REDACTED]",
          clientSecret: "[REDACTED]",
          endpoint: "http://127.0.0.1",
        },
        records: [{ access_token: "[REDACTED]", state: "ready" }],
      });
      expect(redactSecrets(value, true)).toBe(value);
      expect(secretKeyNames({ zebra: 1, alpha: 2, nested: { ignored: true } })).toEqual([
        "alpha",
        "nested",
        "zebra",
      ]);
      expect(secretKeyNames(["not", "a", "mapping"])).toEqual([]);
    });

    it("allows secret values only after the explicit administrator opt-in", async () => {
      await writeFile(path.join(root, "secrets.yaml"), "mqtt_password: explicitly-visible\n");
      const configured = settingsFixture(root);
      configured.filesystem.allowSecretValues = true;

      const file = await new ConfigFilesystem(configured).readFile("secrets.yaml");

      expect(file.content).toContain("explicitly-visible");
      expect(file.kind).toBe("yaml");
    });

    it("builds a searchable configuration catalog without secret values", async () => {
      await writeFile(
        path.join(root, "configuration.yaml"),
        "mqtt:\n  password: !secret mqtt_password\n  sensor: sensor.kitchen_temperature\n",
      );
      await writeFile(
        path.join(root, "packages", "room", "lights.yaml"),
        "target:\n  entity_id: light.kitchen\n",
      );
      const configured = settingsFixture(root);
      const catalog = await loadConfigurationCatalog(new ConfigFilesystem(configured), configured);

      expect(catalog.files).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: "configuration.yaml",
            parsed: {
              mqtt: {
                password: "[REDACTED]",
                sensor: "sensor.kitchen_temperature",
              },
            },
          }),
          expect.objectContaining({ path: "packages/room/lights.yaml" }),
        ]),
      );
      expect(JSON.stringify(catalog)).not.toContain("mqtt_password");
    });
  });

  describe("YAML editing", () => {
    it("applies structural set/delete operations and preserves surrounding comments", () => {
      const source = [
        "# whole-file comment",
        "automation:",
        "  # enabled explanation",
        "  enabled: true # inline enabled comment",
        "  obsolete: remove-me # obsolete comment",
        "sequence:",
        "  - first",
        "  - second",
        "",
      ].join("\n");

      const result = applyYamlPatches(source, [
        { op: "set", path: ["automation", "enabled"], value: false },
        { op: "delete", path: ["automation", "obsolete"] },
        { op: "set", path: ["sequence", 1], value: "changed" },
      ]);

      expect(parse(result.content)).toEqual({
        automation: { enabled: false },
        sequence: ["first", "changed"],
      });
      expect(result.content).toContain("# whole-file comment");
      expect(result.content).toContain("# enabled explanation");
      expect(result.content).toContain("enabled: false # inline enabled comment");
      expect(result.content).not.toContain("obsolete comment");
      expect(result).toMatchObject({
        changed: true,
        operations: [
          { op: "set", path: ["automation", "enabled"], changed: true },
          { op: "delete", path: ["automation", "obsolete"], changed: true },
          { op: "set", path: ["sequence", 1], changed: true },
        ],
      });
    });

    it("preserves valid anchors and aliases when editing the anchor target", () => {
      const source = "defaults: &defaults\n  enabled: true\ncopy: *defaults\n";
      const result = applyYamlPatches(source, [
        { op: "set", path: ["defaults", "enabled"], value: false },
      ]);

      expect(result.content).toContain("defaults: &defaults");
      expect(result.content).toContain("copy: *defaults");
      expect(parse(result.content)).toEqual({
        defaults: { enabled: false },
        copy: { enabled: false },
      });
    });

    it.each([
      ["malformed collections", "automation: [one\n"],
      ["unresolved aliases", "automation: *missing\n"],
      ["duplicate mapping keys", "automation: one\nautomation: two\n"],
    ])("rejects %s", (_caseName, source) => {
      expect(() => validateYaml(source)).toThrowError(
        expect.objectContaining({ code: "INVALID_YAML" }),
      );
    });

    it("returns sorted unique metadata keys and requires a top-level mapping", () => {
      expect(() =>
        validateYaml(
          "mqtt:\n  password: !secret mqtt_password\nautomation: !include automations.yaml\n",
        ),
      ).not.toThrow();
      expect(yamlTopLevelKeys("zebra: one\nalpha: two\n")).toEqual(["alpha", "zebra"]);
      expect(() => yamlTopLevelKeys("- one\n- two\n")).toThrowError(
        expect.objectContaining({ code: "INVALID_YAML_STRUCTURE" }),
      );
    });
  });

  describe("atomic writes and backups", () => {
    it("enforces optimistic hashes and leaves the old file intact on conflict", async () => {
      const original = "homeassistant:\n  name: Before\n";
      const updated = "homeassistant:\n  name: After\n";
      await writeFile(path.join(root, "configuration.yaml"), original, { mode: 0o640 });
      const filesystem = new ConfigFilesystem(settingsFixture(root));
      const before = await filesystem.readFile("configuration.yaml");

      await expect(
        filesystem.writeFileAtomic("configuration.yaml", updated, {
          expectedSha256: "0".repeat(64),
        }),
      ).rejects.toMatchObject({ code: "CONFIG_CONCURRENT_MODIFICATION" });
      expect(await readFile(path.join(root, "configuration.yaml"), "utf8")).toBe(original);

      const written = await filesystem.writeFileAtomic("configuration.yaml", updated, {
        expectedSha256: before.sha256,
      });
      expect(written).toMatchObject({
        content: updated,
        sha256: sha256(updated),
        mode: 0o640,
      });
      expect(await readFile(path.join(root, "configuration.yaml"), "utf8")).toBe(updated);

      await expect(
        filesystem.writeFileAtomic("configuration.yaml", "another: value\n", {
          expectedSha256: null,
        }),
      ).rejects.toMatchObject({ code: "CONFIG_CONCURRENT_MODIFICATION" });
    });

    it("detects tampered backup data before restoring it", async () => {
      const original = "homeassistant:\n  name: Original\n";
      const changed = "homeassistant:\n  name: Planned\n";
      await writeFile(path.join(root, "configuration.yaml"), original);
      const settings = settingsFixture(root);
      const filesystem = new ConfigFilesystem(settings);
      const backups = new BackupManager(settings, filesystem);
      const checkpoint = await backups.createCheckpoint(["configuration.yaml"], "integrity test");
      const before = await filesystem.readFile("configuration.yaml");
      const current = await filesystem.writeFileAtomic("configuration.yaml", changed, {
        expectedSha256: before.sha256,
      });
      const entry = checkpoint.entries[0];
      if (entry?.storageFile === null || entry?.storageFile === undefined) {
        throw new Error("Expected checkpoint data for configuration.yaml");
      }
      await writeFile(
        path.join(root, settings.filesystem.backupDirectory, checkpoint.id, entry.storageFile),
        "tampered backup data\n",
      );

      await expect(
        backups.restoreCheckpoint(checkpoint, {
          expectedCurrent: { "configuration.yaml": current.sha256 },
        }),
      ).rejects.toMatchObject({ code: "BACKUP_INTEGRITY_FAILED" });
      expect(await readFile(path.join(root, "configuration.yaml"), "utf8")).toBe(changed);
    });

    it("refuses rollback when the current file no longer matches the expected hash", async () => {
      const original = "homeassistant:\n  name: Original\n";
      const planned = "homeassistant:\n  name: Planned\n";
      const concurrent = "homeassistant:\n  name: Concurrent\n";
      await writeFile(path.join(root, "configuration.yaml"), original);
      const settings = settingsFixture(root);
      const filesystem = new ConfigFilesystem(settings);
      const backups = new BackupManager(settings, filesystem);
      const checkpoint = await backups.createCheckpoint(["configuration.yaml"], "conflict test");
      const before = await filesystem.readFile("configuration.yaml");
      const applied = await filesystem.writeFileAtomic("configuration.yaml", planned, {
        expectedSha256: before.sha256,
      });
      await writeFile(path.join(root, "configuration.yaml"), concurrent);

      await expect(
        backups.restoreCheckpoint(checkpoint, {
          expectedCurrent: { "configuration.yaml": applied.sha256 },
        }),
      ).rejects.toMatchObject({
        code: "ROLLBACK_CONFLICT",
        details: { path: "configuration.yaml" },
      });
      expect(await readFile(path.join(root, "configuration.yaml"), "utf8")).toBe(concurrent);
    });
  });
});
