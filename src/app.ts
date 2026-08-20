import type { BackupCheckpoint } from "./config/backups.js";
import { ConfigFilesystem } from "./config/filesystem.js";
import type { GitCommit } from "./config/git.js";
import type { Settings } from "./config/settings.js";
import { ConfigTransaction } from "./config/transaction.js";
import {
  AutomationAdministration,
  ControlService,
  DiscoveryService,
  HelperAdministration,
  HistoryService,
  IntegrationAdministration,
  LogsService,
  RegistryAdministration,
  RuntimeService,
  SceneAdministration,
  ScriptAdministration,
} from "./domains/index.js";
import type {
  MutationCheckpoint,
  MutationOptions,
  MutationResult,
  ResourceDomain,
} from "./domains/resources.js";
import { HomeAssistantClient, type ConfigCheckResult } from "./homeassistant/client.js";
import { AppError } from "./shared/errors.js";
import { PermissionPolicy } from "./security/risk.js";

const RESOURCE_FILES: Record<ResourceDomain, string> = {
  automation: "automations.yaml",
  script: "scripts.yaml",
  scene: "scenes.yaml",
};

export interface ResourceChangeSafety {
  checkpoint: BackupCheckpoint | null;
  config_validation: ConfigCheckResult | null;
  git_commit: GitCommit | null;
  warnings: string[];
}

export interface PreparedResourceChange {
  options: MutationOptions;
  finish(result: MutationResult): Promise<ResourceChangeSafety>;
}

export class Application {
  readonly client: HomeAssistantClient;
  readonly policy: PermissionPolicy;
  readonly filesystem: ConfigFilesystem;
  readonly transaction: ConfigTransaction;
  readonly discovery: DiscoveryService;
  readonly runtime: RuntimeService;
  readonly control: ControlService;
  readonly history: HistoryService;
  readonly logs: LogsService;
  readonly automations: AutomationAdministration;
  readonly scripts: ScriptAdministration;
  readonly scenes: SceneAdministration;
  readonly registries: RegistryAdministration;
  readonly helpers: HelperAdministration;
  readonly integrations: IntegrationAdministration;

  constructor(readonly settings: Settings) {
    this.client = new HomeAssistantClient(settings);
    this.policy = new PermissionPolicy(settings);
    this.filesystem = new ConfigFilesystem(settings);
    this.transaction = new ConfigTransaction(
      settings,
      {
        validate: async () => {
          const result = await this.client.checkConfig();
          return {
            ok: result.result === "valid",
            ...(result.errors === null ? {} : { message: result.errors }),
          };
        },
        reload: async ({ paths }) => {
          await this.reloadForPaths(paths);
          return true;
        },
        health: async () => {
          const config = await this.client.getConfig();
          return { ok: config.state === undefined || config.state === "RUNNING" };
        },
      },
      { filesystem: this.filesystem },
    );
    this.discovery = new DiscoveryService(this.client);
    this.runtime = new RuntimeService(this.client);
    this.control = new ControlService(this.client);
    this.history = new HistoryService(this.client);
    this.logs = new LogsService(this.client);
    this.automations = new AutomationAdministration(this.client);
    this.scripts = new ScriptAdministration(this.client);
    this.scenes = new SceneAdministration(this.client);
    this.registries = new RegistryAdministration(this.client);
    this.helpers = new HelperAdministration(this.client);
    this.integrations = new IntegrationAdministration(this.client);
  }

  prepareResourceChange(
    domain: ResourceDomain,
    id: string,
    dryRun: boolean,
  ): PreparedResourceChange {
    let checkpoint: BackupCheckpoint | null = null;
    let configValidation: ConfigCheckResult | null = null;
    let gitRepositoryAvailable: boolean | null = null;
    let preexistingGitChange = false;
    const warnings: string[] = [];
    const file = RESOURCE_FILES[domain];
    const options: MutationOptions = { dryRun };
    if (!dryRun) {
      options.checkpoint = async (resourceCheckpoint: MutationCheckpoint) => {
        if (!this.settings.filesystem.enabled) {
          throw new AppError(
            "CHECKPOINT_UNAVAILABLE",
            "Persistent resource changes require the Home Assistant config mount",
          );
        }
        checkpoint = await this.transaction.backups.createCheckpoint(
          [file],
          `MCP ${resourceCheckpoint.operation} ${domain} ${id}`,
        );
        if (this.settings.git.enabled) {
          try {
            gitRepositoryAvailable = (await this.transaction.git.detect()) !== null;
            if (gitRepositoryAvailable) {
              preexistingGitChange = (await this.transaction.git.status([file])).length > 0;
            }
          } catch (error) {
            warnings.push(
              `Git preflight failed: ${error instanceof AppError ? error.code : "UNKNOWN"}`,
            );
          }
        }
      };
      options.postApply = async () => {
        configValidation = await this.client.checkConfig();
        if (
          !configValidation ||
          typeof configValidation !== "object" ||
          !("result" in configValidation) ||
          configValidation.result !== "valid"
        ) {
          throw new AppError(
            "HA_CONFIG_VALIDATION_FAILED",
            "Home Assistant rejected the configuration after the editor change",
            { details: JSON.parse(JSON.stringify(configValidation)) as never },
          );
        }
        await this.client.getConfig();
      };
    }

    return {
      options,
      finish: async (result) => {
        let gitCommit: GitCommit | null = null;
        if (result.applied && this.settings.git.enabled) {
          if (preexistingGitChange) {
            warnings.push(`Git commit skipped because ${file} had pre-existing changes`);
          } else {
            try {
              const repositoryAvailable =
                gitRepositoryAvailable ?? (await this.transaction.git.detect()) !== null;
              if (!repositoryAvailable) {
                warnings.push("Git is enabled but /ha-config is not a Git repository");
              } else {
                gitCommit = await this.transaction.git.commitFiles([file], {
                  message: `MCP: ${titleCase(result.operation)} ${domain} ${id}`,
                });
              }
            } catch (error) {
              warnings.push(
                `The Home Assistant change succeeded but Git commit failed: ${error instanceof AppError ? error.code : "UNKNOWN"}`,
              );
            }
          }
        }
        return {
          checkpoint,
          config_validation: configValidation,
          git_commit: gitCommit,
          warnings,
        };
      },
    };
  }

  async reloadForPaths(paths: readonly string[]): Promise<void> {
    const names = new Set(paths.map((entry) => entry.split("/").at(-1)));
    if (names.size === 1 && names.has("automations.yaml")) {
      await this.client.callService("automation", "reload");
    } else if (names.size === 1 && names.has("scripts.yaml")) {
      await this.client.callService("script", "reload");
    } else if (names.size === 1 && names.has("scenes.yaml")) {
      await this.client.callService("scene", "reload");
    } else {
      await this.client.callService("homeassistant", "reload_all");
    }
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
