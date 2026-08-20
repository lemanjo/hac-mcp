import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";

import { AppError } from "../shared/errors.js";
import { ConfigPathPolicy } from "../security/paths.js";
import type { Settings } from "./settings.js";

export interface GitRepositoryInfo {
  root: string;
  configRoot: string;
  head: string | null;
  branch: string | null;
}

export interface GitStatusEntry {
  path: string;
  index: string;
  worktree: string;
  originalPath?: string;
}

export interface GitCommit {
  hash: string;
  authoredAt: string;
  authorName: string;
  authorEmail: string;
  subject: string;
}

export interface GitCommitOptions {
  message: string;
  authorName?: string;
  authorEmail?: string;
}

export interface GitDiff {
  paths: string[];
  unified: string;
  staged: boolean;
}

interface RunOptions {
  input?: string;
  maxBytes?: number;
  acceptedExitCodes?: readonly number[];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

const COMMIT_HASH = /^[a-f0-9]{7,64}$/i;

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

function validateIdentity(name: string, email: string): void {
  if (
    name.length === 0 ||
    name.length > 200 ||
    hasControlCharacter(name) ||
    email.length === 0 ||
    email.length > 320 ||
    hasControlCharacter(email) ||
    !email.includes("@")
  ) {
    throw new AppError("INVALID_GIT_IDENTITY", "The Git author identity is invalid");
  }
}

function validateCommitMessage(message: string): void {
  if (message.trim().length === 0 || message.length > 4_096 || message.includes("\u0000")) {
    throw new AppError("INVALID_GIT_MESSAGE", "The Git commit message is invalid");
  }
}

function runGit(
  cwd: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<CommandResult> {
  const maxBytes = options.maxBytes ?? 4_194_304;
  const accepted = options.acceptedExitCodes ?? [0];
  return new Promise((resolve, reject) => {
    const environment: NodeJS.ProcessEnv = {
      LC_ALL: "C",
      LANG: "C",
      GIT_TERMINAL_PROMPT: "0",
    };
    for (const name of ["HOME", "PATH", "TMPDIR", "SystemRoot", "WINDIR"]) {
      const value = process.env[name];
      if (value !== undefined) environment[name] = value;
    }
    Object.assign(environment, options.env);
    const child = spawn(
      "git",
      ["-C", cwd, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args],
      {
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: environment,
      },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let outputExceeded = false;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs ?? 30_000);

    const collect = (target: Buffer[], chunk: Buffer, stream: "stdout" | "stderr") => {
      if (stream === "stdout") stdoutBytes += chunk.byteLength;
      else stderrBytes += chunk.byteLength;
      if (stdoutBytes + stderrBytes > maxBytes) {
        outputExceeded = true;
        child.kill("SIGKILL");
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk, "stderr"));
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(new AppError("GIT_UNAVAILABLE", "Unable to start Git", { cause: error }));
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(
          new AppError("GIT_TIMEOUT", "Git exceeded the operation timeout", { retryable: true }),
        );
        return;
      }
      if (outputExceeded) {
        reject(new AppError("GIT_OUTPUT_TOO_LARGE", "Git output exceeded the configured limit"));
        return;
      }
      const result = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        code: code ?? -1,
      };
      if (!accepted.includes(result.code)) {
        reject(
          new AppError("GIT_COMMAND_FAILED", "Git could not complete the requested operation", {
            details: { exit_code: result.code, stderr: result.stderr.slice(0, 2_000) },
          }),
        );
        return;
      }
      resolve(result);
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.input);
  });
}

export class GitClient {
  readonly policy: ConfigPathPolicy;

  constructor(
    private readonly settings: Settings,
    policy?: ConfigPathPolicy,
  ) {
    this.policy = policy ?? new ConfigPathPolicy(settings);
  }

  async detect(): Promise<GitRepositoryInfo | null> {
    if (!this.settings.git.enabled) return null;
    return this.detectRepository();
  }

  private async detectRepository(): Promise<GitRepositoryInfo | null> {
    const configRoot = await this.policy.root();
    let topLevel: CommandResult;
    try {
      topLevel = await runGit(configRoot, ["rev-parse", "--show-toplevel"]);
    } catch (error) {
      if (
        error instanceof AppError &&
        ["GIT_COMMAND_FAILED", "GIT_UNAVAILABLE"].includes(error.code)
      )
        return null;
      throw error;
    }
    let root: string;
    try {
      root = await realpath(path.resolve(topLevel.stdout.trim()));
    } catch (error) {
      throw new AppError("GIT_ROOT_UNAVAILABLE", "The Git repository root is unavailable", {
        cause: error,
      });
    }
    if (!isWithin(root, configRoot)) {
      throw new AppError(
        "GIT_ROOT_MISMATCH",
        "The detected Git repository does not contain the configuration root",
      );
    }
    const headResult = await runGit(configRoot, ["rev-parse", "--verify", "HEAD"], {
      acceptedExitCodes: [0, 128],
    });
    const branchResult = await runGit(configRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"], {
      acceptedExitCodes: [0, 1],
    });
    return {
      root,
      configRoot,
      head: headResult.code === 0 ? headResult.stdout.trim() : null,
      branch: branchResult.code === 0 ? branchResult.stdout.trim() : null,
    };
  }

  private async requireRepository(): Promise<GitRepositoryInfo> {
    const repository = await this.detect();
    if (repository === null)
      throw new AppError("GIT_NOT_AVAILABLE", "No enabled Git repository was detected");
    return repository;
  }

  private async resolvePaths(
    paths: readonly string[],
  ): Promise<{ config: string[]; repository: string[] }> {
    if (paths.length === 0)
      throw new AppError("GIT_PATHS_REQUIRED", "At least one configuration path is required");
    const repository = await this.requireRepository();
    const config: string[] = [];
    const repoPaths: string[] = [];
    const seen = new Set<string>();
    for (const requestedPath of paths) {
      const resolved = await this.policy.resolve(requestedPath, "write");
      if (seen.has(resolved.relativePath)) {
        throw new AppError(
          "DUPLICATE_CONFIG_PATH",
          "A configuration path was specified more than once",
        );
      }
      seen.add(resolved.relativePath);
      config.push(resolved.relativePath);
      repoPaths.push(
        path.relative(repository.root, resolved.absolutePath).split(path.sep).join("/"),
      );
    }
    return { config, repository: repoPaths };
  }

  private async configPathFromRepository(repositoryPath: string): Promise<string | null> {
    const repository = await this.requireRepository();
    const absolute = path.resolve(repository.root, repositoryPath);
    if (!isWithin(repository.configRoot, absolute)) return null;
    const relative = path.relative(repository.configRoot, absolute).split(path.sep).join("/");
    try {
      return (await this.policy.resolve(relative, "write")).relativePath;
    } catch {
      return null;
    }
  }

  async status(paths?: readonly string[]): Promise<GitStatusEntry[]> {
    const repository = await this.requireRepository();
    let requested: { config: string[]; repository: string[] } | null = null;
    let pathspec: string[];
    if (paths === undefined) {
      const scope = path.relative(repository.root, repository.configRoot).split(path.sep).join("/");
      pathspec = [scope === "" ? "." : scope];
    } else {
      requested = await this.resolvePaths(paths);
      pathspec = requested.repository;
    }
    const result = await runGit(repository.root, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--",
      ...pathspec,
    ]);
    const tokens = result.stdout.split("\u0000");
    const entries: GitStatusEntry[] = [];
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (!token || token.length < 4) continue;
      const status = token.slice(0, 2);
      const repoPath = token.slice(3);
      let originalRepoPath: string | undefined;
      if (status[0] === "R" || status[0] === "C") {
        originalRepoPath = tokens[index + 1] || undefined;
        index += 1;
      }
      const configPath = await this.configPathFromRepository(repoPath);
      if (configPath === null) continue;
      const entry: GitStatusEntry = {
        path: configPath,
        index: status[0] ?? " ",
        worktree: status[1] ?? " ",
      };
      if (originalRepoPath !== undefined) {
        const original = await this.configPathFromRepository(originalRepoPath);
        if (original !== null) entry.originalPath = original;
      }
      entries.push(entry);
    }
    if (requested === null) return entries;
    const allowed = new Set(requested.config);
    return entries.filter((entry) => allowed.has(entry.path));
  }

  async history(filePath?: string, limit = 50): Promise<GitCommit[]> {
    const repository = await this.requireRepository();
    const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), 500);
    const args = [
      "log",
      `--max-count=${boundedLimit}`,
      "-z",
      "--format=%H%x00%aI%x00%an%x00%ae%x00%s",
    ];
    if (filePath !== undefined) {
      const resolved = await this.resolvePaths([filePath]);
      args.push("--", resolved.repository[0] as string);
    }
    const result = await runGit(repository.root, args);
    const fields = result.stdout.split("\u0000");
    const commits: GitCommit[] = [];
    for (let index = 0; index + 4 < fields.length; index += 5) {
      const hash = fields[index]?.replace(/^\n+/, "") ?? "";
      const authoredAt = fields[index + 1] ?? "";
      const authorName = fields[index + 2] ?? "";
      const authorEmail = fields[index + 3] ?? "";
      const subject = fields[index + 4]?.replace(/\n+$/, "") ?? "";
      if (!COMMIT_HASH.test(hash)) continue;
      commits.push({ hash, authoredAt, authorName, authorEmail, subject });
    }
    return commits;
  }

  async recent(limit = 20): Promise<GitCommit[]> {
    return this.history(undefined, limit);
  }

  async diff(paths: readonly string[], staged = false): Promise<GitDiff> {
    const repository = await this.requireRepository();
    const resolved = await this.resolvePaths(paths);
    const args = ["diff", "--no-ext-diff", "--no-color"];
    if (staged) args.push("--cached");
    args.push("--", ...resolved.repository);
    const result = await runGit(repository.root, args, {
      maxBytes: Math.min(this.settings.filesystem.maxReadBytes * 4, 16_777_216),
    });
    return { paths: resolved.config, unified: result.stdout, staged };
  }

  async commitFiles(paths: readonly string[], options: GitCommitOptions): Promise<GitCommit> {
    validateCommitMessage(options.message);
    const authorName = options.authorName ?? this.settings.git.authorName;
    const authorEmail = options.authorEmail ?? this.settings.git.authorEmail;
    validateIdentity(authorName, authorEmail);
    const repository = await this.requireRepository();
    const resolved = await this.resolvePaths(paths);

    await runGit(repository.root, ["add", "-A", "--", ...resolved.repository]);
    const staged = await runGit(
      repository.root,
      ["diff", "--cached", "--quiet", "--", ...resolved.repository],
      {
        acceptedExitCodes: [0, 1],
      },
    );
    if (staged.code === 0)
      throw new AppError("GIT_NOTHING_TO_COMMIT", "The selected files have no changes to commit");

    await runGit(
      repository.root,
      [
        "-c",
        `user.name=${authorName}`,
        "-c",
        `user.email=${authorEmail}`,
        "commit",
        "--only",
        "--no-gpg-sign",
        `--author=${authorName} <${authorEmail}>`,
        "--message",
        options.message,
        "--",
        ...resolved.repository,
      ],
      {
        env: {
          GIT_AUTHOR_NAME: authorName,
          GIT_AUTHOR_EMAIL: authorEmail,
          GIT_COMMITTER_NAME: authorName,
          GIT_COMMITTER_EMAIL: authorEmail,
        },
      },
    );
    const commits = await this.history(undefined, 1);
    const commit = commits[0];
    if (commit === undefined)
      throw new AppError("GIT_COMMIT_FAILED", "Git did not return the new commit metadata");
    return commit;
  }

  async rollbackCommit(commitHash: string, message?: string): Promise<GitCommit> {
    if (!COMMIT_HASH.test(commitHash))
      throw new AppError("INVALID_GIT_REVISION", "The Git commit hash is invalid");
    const repository = await this.requireRepository();
    const head = await runGit(repository.root, ["rev-parse", "--verify", "HEAD"]);
    const fullCommit = await runGit(repository.root, [
      "rev-parse",
      "--verify",
      `${commitHash}^{commit}`,
    ]);
    const commit = fullCommit.stdout.trim();
    if (head.stdout.trim() !== commit) {
      throw new AppError(
        "GIT_ROLLBACK_NOT_HEAD",
        "Only the current HEAD commit can be safely rolled back",
      );
    }
    const metadata = (await this.history(undefined, 1))[0];
    if (
      metadata === undefined ||
      metadata.hash !== commit ||
      metadata.authorEmail !== this.settings.git.authorEmail
    ) {
      throw new AppError(
        "GIT_ROLLBACK_NOT_OWNED",
        "Only commits created by this service can be rolled back",
      );
    }
    const parent = await runGit(repository.root, ["rev-parse", "--verify", `${commit}^`], {
      acceptedExitCodes: [0, 128],
    });
    if (parent.code !== 0)
      throw new AppError(
        "GIT_ROLLBACK_INITIAL_COMMIT",
        "The initial commit cannot be safely rolled back",
      );

    const changed = await runGit(repository.root, [
      "diff-tree",
      "--no-commit-id",
      "--name-only",
      "-r",
      "-z",
      commit,
    ]);
    const paths: string[] = [];
    for (const repositoryPath of changed.stdout.split("\u0000").filter(Boolean)) {
      const configPath = await this.configPathFromRepository(repositoryPath);
      if (configPath === null) {
        throw new AppError(
          "GIT_ROLLBACK_UNSAFE",
          "The commit includes a path outside the configuration allowlist",
        );
      }
      paths.push(configPath);
    }
    if (paths.length === 0)
      throw new AppError("GIT_ROLLBACK_EMPTY", "The commit has no allowed configuration changes");
    const status = await this.status(paths);
    if (status.length > 0) {
      throw new AppError(
        "GIT_ROLLBACK_CONFLICT",
        "Rollback refused to overwrite uncommitted changes in affected files",
        {
          details: { paths: status.map((entry) => entry.path) },
        },
      );
    }

    const resolved = await this.resolvePaths(paths);
    await runGit(repository.root, [
      "restore",
      `--source=${parent.stdout.trim()}`,
      "--worktree",
      "--",
      ...resolved.repository,
    ]);
    try {
      return await this.commitFiles(paths, {
        message: message ?? `Rollback ${commit.slice(0, 12)}: ${metadata.subject}`,
      });
    } catch (error) {
      await runGit(repository.root, [
        "restore",
        `--source=${commit}`,
        "--staged",
        "--worktree",
        "--",
        ...resolved.repository,
      ]).catch(() => undefined);
      throw error;
    }
  }

  async rollback(commitHash: string, message?: string): Promise<GitCommit> {
    return this.rollbackCommit(commitHash, message);
  }
}

export async function detectGitRepository(settings: Settings): Promise<GitRepositoryInfo | null> {
  return new GitClient(settings).detect();
}
