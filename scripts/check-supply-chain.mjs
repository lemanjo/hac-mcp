import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const errors = [];
const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const sha256Digest = /@sha256:[a-f0-9]{64}$/;

async function read(relativePath) {
  return readFile(path.join(root, relativePath), "utf8");
}

const packageJson = JSON.parse(await read("package.json"));
if (!/^pnpm@\d+\.\d+\.\d+\+sha512\.[a-f0-9]{128}$/.test(packageJson.packageManager ?? "")) {
  errors.push("packageManager must pin pnpm and its SHA-512 hash.");
}

for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
  for (const [name, version] of Object.entries(packageJson[section] ?? {})) {
    if (!exactVersion.test(version)) {
      errors.push(`${section}.${name} must use an exact SemVer version, not ${version}.`);
    }
  }
}

const workspace = await read("pnpm-workspace.yaml");
const requiredPnpmSettings = [
  {
    pattern: /^minimumReleaseAge: 10080$/m,
    message: "minimumReleaseAge must remain seven days.",
  },
  {
    pattern: /^minimumReleaseAgeIgnoreMissingTime: false$/m,
    message: "Packages without publication times must not bypass the quarantine.",
  },
  {
    pattern: /^minimumReleaseAgeStrict: true$/m,
    message: "pnpm must fail when no eligible package version exists.",
  },
  {
    pattern: /^trustPolicy: no-downgrade$/m,
    message: "Package publisher trust must not be allowed to decrease.",
  },
  {
    pattern: /^trustLockfile: false$/m,
    message: "pnpm must revalidate lockfile resolution data.",
  },
  { pattern: /^frozenLockfile: true$/m, message: "The lockfile must be frozen by default." },
  { pattern: /^saveExact: true$/m, message: "New direct dependencies must be saved exactly." },
  {
    pattern: /^blockExoticSubdeps: true$/m,
    message: "Transitive dependencies must come from the registry.",
  },
  {
    pattern: /^strictDepBuilds: true$/m,
    message: "Unreviewed dependency build scripts must fail installation.",
  },
  {
    pattern: /^verifyDepsBeforeRun: error$/m,
    message: "Modified installed dependencies must fail execution.",
  },
  {
    pattern: /^optimisticRepeatInstall: false$/m,
    message: "Installs must not skip repeated lockfile policy verification.",
  },
  {
    pattern: /^ {2}default: https:\/\/registry\.npmjs\.org\/$/m,
    message: "The default package registry must remain registry.npmjs.org.",
  },
];
for (const { pattern, message } of requiredPnpmSettings) {
  if (!pattern.test(workspace)) errors.push(message);
}
if (/^minimumReleaseAgeExclude:/m.test(workspace)) {
  errors.push("minimumReleaseAgeExclude is not allowed.");
}
const overrides = workspace.match(/^overrides:\n((?: {2}[^\n]+\n?)*)/m)?.[1] ?? "";
for (const match of overrides.matchAll(/^ {2}([^:]+):\s*(\S+)$/gm)) {
  if (!exactVersion.test(match[2])) {
    errors.push(`pnpm override ${match[1]} must use an exact SemVer version.`);
  }
}

const lockfile = await read("pnpm-lock.yaml");
const packageSection = lockfile.match(/^packages:\n([\s\S]*?)(?=^snapshots:)/m)?.[1] ?? "";
const packageEntries = [
  ...packageSection.matchAll(/^ {2}(\S.*):\n([\s\S]*?)(?=^ {2}\S|(?![\s\S]))/gm),
];
if (packageEntries.length === 0) {
  errors.push("pnpm-lock.yaml has no package entries.");
}
for (const entry of packageEntries) {
  if (!/^ {4}resolution: \{integrity: sha512-[A-Za-z0-9+/]+=*\}$/m.test(entry[2])) {
    errors.push(`Locked package ${entry[1]} is missing a SHA-512 integrity value.`);
  }
}

async function listFiles(directory) {
  const entries = await readdir(path.join(root, directory), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(relativePath)));
    else files.push(relativePath);
  }
  return files;
}

for (const workflowPath of await listFiles(".github/workflows")) {
  if (!/\.ya?ml$/.test(workflowPath)) continue;
  const workflow = await read(workflowPath);
  for (const match of workflow.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gm)) {
    const reference = match[1];
    if (reference.startsWith("./")) continue;
    if (!/@[a-f0-9]{40}$/.test(reference)) {
      errors.push(`${workflowPath} uses mutable action reference ${reference}.`);
    }
  }
  for (const match of workflow.matchAll(/^\s*node-version:\s*([^\s#]+)/gm)) {
    if (!exactVersion.test(match[1])) {
      errors.push(`${workflowPath} uses mutable Node.js version ${match[1]}.`);
    }
  }
  if (
    /docker\/setup-buildx-action@/.test(workflow) &&
    !/^\s*version:\s*v\d+\.\d+\.\d+$/m.test(workflow)
  ) {
    errors.push(`${workflowPath} must pin the Buildx binary version.`);
  }
  if (
    /docker\/setup-qemu-action@/.test(workflow) &&
    !/^\s*image:\s*\S+@sha256:[a-f0-9]{64}$/m.test(workflow)
  ) {
    errors.push(`${workflowPath} must pin the QEMU helper image digest.`);
  }
  if (
    /docker\/setup-buildx-action@/.test(workflow) &&
    !/^\s*image=moby\/buildkit:v\d+\.\d+\.\d+@sha256:[a-f0-9]{64}$/m.test(workflow)
  ) {
    errors.push(`${workflowPath} must pin the BuildKit daemon image and digest.`);
  }
  if (/docker\/build-push-action@/.test(workflow)) {
    if (!/aquasecurity\/trivy-action@[a-f0-9]{40}/.test(workflow)) {
      errors.push(`${workflowPath} must scan the runtime image with a pinned Trivy action.`);
    }
    if (!/^\s*version:\s*v\d+\.\d+\.\d+$/m.test(workflow)) {
      errors.push(`${workflowPath} must pin the Trivy binary version.`);
    }
    if (!/^\s*severity:\s*UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL$/m.test(workflow)) {
      errors.push(`${workflowPath} must report every vulnerability severity.`);
    }
    if (!/^\s*ignore-unfixed:\s*["']true["']$/m.test(workflow)) {
      errors.push(`${workflowPath} must include a blocking scan for fixable vulnerabilities.`);
    }
    if (!/^\s*exit-code:\s*["']1["']$/m.test(workflow)) {
      errors.push(`${workflowPath} must fail when the blocking vulnerability scan finds issues.`);
    }
  }
  const pushIndex = workflow.indexOf("push: true");
  if (pushIndex !== -1) {
    const scanIndex = workflow.indexOf("name: Reject fixable");
    if (scanIndex === -1 || scanIndex > pushIndex) {
      errors.push(`${workflowPath} must block fixable vulnerabilities before pushing an image.`);
    }
    if (/^\s*sbom:\s*true$/m.test(workflow)) {
      errors.push(`${workflowPath} must not use the mutable default SBOM generator.`);
    }
    if (!/^\s*sbom:\s*generator=\S+@sha256:[a-f0-9]{64}$/m.test(workflow)) {
      errors.push(`${workflowPath} must pin the SBOM generator image digest.`);
    }
  }
}

for (const dockerfilePath of ["Dockerfile", ".devcontainer/Dockerfile"]) {
  const dockerfile = await read(dockerfilePath);
  const stages = new Set();
  for (const match of dockerfile.matchAll(/^FROM\s+(\S+)(?:\s+AS\s+(\S+))?/gim)) {
    const image = match[1];
    if (!stages.has(image) && !sha256Digest.test(image)) {
      errors.push(`${dockerfilePath} uses unpinned base image ${image}.`);
    }
    if (match[2]) stages.add(match[2]);
  }
  for (const match of dockerfile.matchAll(/^ARG\s+\w+_VERSION=(\S+)$/gm)) {
    if (!exactVersion.test(match[1])) {
      errors.push(`${dockerfilePath} uses mutable tool version ${match[1]}.`);
    }
  }
  if (/apt-get\s/.test(dockerfile)) {
    const snapshots = [
      ...dockerfile.matchAll(/snapshot\.debian\.org\/archive\/[^/]+\/(\d{8}T\d{6}Z)/g),
    ];
    if (snapshots.length === 0) {
      errors.push(`${dockerfilePath} installs Debian packages without a dated snapshot.`);
    }
    for (const snapshot of snapshots) {
      const timestamp = snapshot[1].replace(
        /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,
        "$1-$2-$3T$4:$5:$6Z",
      );
      if (Date.now() - Date.parse(timestamp) < 7 * 24 * 60 * 60 * 1000) {
        errors.push(
          `${dockerfilePath} uses Debian snapshot ${snapshot[1]} before it is seven days old.`,
        );
      }
    }
  }
}

const devcontainer = JSON.parse(await read(".devcontainer/devcontainer.json"));
for (const [name, version] of Object.entries(devcontainer.build?.args ?? {})) {
  if (name.endsWith("_VERSION") && !exactVersion.test(version)) {
    errors.push(`Dev container argument ${name} must use an exact version.`);
  }
}
for (const feature of Object.keys(devcontainer.features ?? {})) {
  if (!/:\d+\.\d+\.\d+$/.test(feature) && !sha256Digest.test(feature)) {
    errors.push(`Dev container feature ${feature} must use an exact version or digest.`);
  }
}
for (const extension of devcontainer.customizations?.vscode?.extensions ?? []) {
  if (!/@\d+\.\d+\.\d+$/.test(extension)) {
    errors.push(`VS Code extension ${extension} must use an exact version.`);
  }
}
if (devcontainer.customizations?.vscode?.settings?.["extensions.autoUpdate"] !== false) {
  errors.push("VS Code extension auto-updates must be disabled.");
}

if (errors.length > 0) {
  process.stderr.write(`${errors.map((error) => `- ${error}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("Supply-chain policy checks passed.\n");
}
