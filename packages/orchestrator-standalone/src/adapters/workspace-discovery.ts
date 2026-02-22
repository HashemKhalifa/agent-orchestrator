import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { type WorkspaceFacts, WorkspaceFactsSchema } from "../spec/schemas.js";

const DEFAULT_IGNORES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".jest-cache",
  ".next",
  ".nx",
  ".turbo",
  ".cache",
  ".omc",
]);

interface PackageJsonShape {
  name?: string;
  private?: boolean;
  scripts?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  peerDependencies?: Record<string, unknown>;
  workspaces?: string[] | { packages?: string[] };
}

function detectPackageManager(repoRoot: string): "npm" | "pnpm" | "yarn" | "unknown" {
  if (existsSync(path.join(repoRoot, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(path.join(repoRoot, "yarn.lock"))) return "yarn";
  if (existsSync(path.join(repoRoot, "package-lock.json"))) return "npm";
  return "unknown";
}

function listLockfiles(repoRoot: string): string[] {
  const lockfiles = ["pnpm-lock.yaml", "yarn.lock", "package-lock.json"];
  return lockfiles.filter((file) => existsSync(path.join(repoRoot, file)));
}

function safeReadJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function loadWorkspaceGlobs(repoRoot: string): string[] {
  const packageJsonPath = path.join(repoRoot, "package.json");
  const packageJson = safeReadJson<PackageJsonShape>(packageJsonPath);
  const globs: string[] = [];

  if (Array.isArray(packageJson?.workspaces)) {
    for (const pattern of packageJson.workspaces) {
      if (typeof pattern === "string" && pattern.trim()) {
        globs.push(pattern.trim());
      }
    }
  }

  if (packageJson?.workspaces && !Array.isArray(packageJson.workspaces)) {
    const list = packageJson.workspaces.packages;
    if (Array.isArray(list)) {
      for (const pattern of list) {
        if (typeof pattern === "string" && pattern.trim()) {
          globs.push(pattern.trim());
        }
      }
    }
  }

  const pnpmWorkspacePath = path.join(repoRoot, "pnpm-workspace.yaml");
  if (existsSync(pnpmWorkspacePath)) {
    const content = readFileSync(pnpmWorkspacePath, "utf8");
    for (const line of content.split(/\r?\n/g)) {
      const match = line.match(/^\s*-\s*['\"]?(.+?)['\"]?\s*$/);
      if (match && match[1]) {
        globs.push(match[1].trim());
      }
    }
  }

  if (globs.length === 0 && existsSync(path.join(repoRoot, "packages"))) {
    globs.push("packages/*");
  }

  return Array.from(new Set(globs));
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "__DOUBLE_STAR__")
    .replace(/\*/g, "[^/]+")
    .replace(/__DOUBLE_STAR__/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function collectPackageJsonFiles(repoRoot: string, maxFiles = 5000): string[] {
  const result: string[] = [];
  const queue: string[] = [repoRoot];

  while (queue.length > 0) {
    const dir = queue.shift() as string;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry);
      let stats;
      try {
        stats = statSync(fullPath);
      } catch {
        continue;
      }

      if (stats.isDirectory()) {
        if (!DEFAULT_IGNORES.has(entry)) {
          queue.push(fullPath);
        }
        continue;
      }

      if (entry === "package.json") {
        result.push(fullPath);
        if (result.length >= maxFiles) {
          return result;
        }
      }
    }
  }

  return result;
}

function relativeFromRoot(repoRoot: string, absolutePath: string): string {
  const rel = path.relative(repoRoot, absolutePath);
  return rel === "" ? "." : rel;
}

function detectBuildToolsFromFiles(repoRoot: string): string[] {
  const signals: Array<{ id: string; files: string[] }> = [
    {
      id: "webpack",
      files: ["webpack.config.js", "webpack.config.cjs", "webpack.config.mjs", "webpack.config.ts"],
    },
    {
      id: "rsbuild",
      files: ["rsbuild.config.ts", "rsbuild.config.js", "rsbuild.config.mjs", "rsbuild.config.cjs"],
    },
    {
      id: "vite",
      files: ["vite.config.ts", "vite.config.js", "vite.config.mjs", "vite.config.cjs"],
    },
    {
      id: "rollup",
      files: ["rollup.config.js", "rollup.config.mjs", "rollup.config.ts"],
    },
  ];

  const out: string[] = [];
  for (const signal of signals) {
    if (signal.files.some((file) => existsSync(path.join(repoRoot, file)))) {
      out.push(signal.id);
    }
  }
  return out;
}

function detectTestToolsFromFiles(repoRoot: string): string[] {
  const out: string[] = [];
  const testSignals: Array<{ id: string; files: string[] }> = [
    {
      id: "jest",
      files: ["jest.config.js", "jest.config.ts", "jest.config.cjs", "jest.config.mjs"],
    },
    {
      id: "vitest",
      files: ["vitest.config.ts", "vitest.config.js", "vitest.config.mjs", "vitest.config.cjs"],
    },
  ];

  for (const signal of testSignals) {
    if (signal.files.some((file) => existsSync(path.join(repoRoot, file)))) {
      out.push(signal.id);
    }
  }
  return out;
}

function detectCiProviders(repoRoot: string): string[] {
  const providers: string[] = [];
  if (existsSync(path.join(repoRoot, ".github", "workflows"))) providers.push("github_actions");
  if (existsSync(path.join(repoRoot, ".gitlab-ci.yml"))) providers.push("gitlab_ci");
  if (existsSync(path.join(repoRoot, "azure-pipelines.yml"))) providers.push("azure_pipelines");
  if (existsSync(path.join(repoRoot, "circle.yml")) || existsSync(path.join(repoRoot, ".circleci"))) {
    providers.push("circleci");
  }
  return providers;
}

function packageDependencies(packageJson: PackageJsonShape): string[] {
  const names = new Set<string>();
  for (const dependencyMap of [
    packageJson.dependencies,
    packageJson.devDependencies,
    packageJson.peerDependencies,
  ]) {
    if (!dependencyMap) continue;
    for (const key of Object.keys(dependencyMap)) names.add(key);
  }
  return Array.from(names).sort();
}

function matchesWorkspace(pathRel: string, workspaceGlobs: string[]): boolean {
  if (workspaceGlobs.length === 0) return true;
  return workspaceGlobs.some((glob) => globToRegExp(glob).test(pathRel));
}

export function discoverWorkspaceFacts(repoRootInput: string): WorkspaceFacts {
  const repoRoot = path.resolve(repoRootInput);
  const workspaceGlobs = loadWorkspaceGlobs(repoRoot);
  const packageJsonFiles = collectPackageJsonFiles(repoRoot);

  const packages = packageJsonFiles
    .map((filePath) => {
      const packageJson = safeReadJson<PackageJsonShape>(filePath);
      if (!packageJson) return null;

      const packageDir = path.dirname(filePath);
      const relativePath = relativeFromRoot(repoRoot, packageDir);
      if (relativePath !== "." && !matchesWorkspace(relativePath, workspaceGlobs)) {
        return null;
      }

      const scripts = packageJson.scripts ? Object.keys(packageJson.scripts) : [];
      return {
        name: packageJson.name ?? relativePath,
        path: relativePath,
        private: Boolean(packageJson.private),
        scripts,
        dependencies: packageDependencies(packageJson),
      };
    })
    .filter((pkg): pkg is NonNullable<typeof pkg> => Boolean(pkg));

  const discovered = WorkspaceFactsSchema.parse({
    repoRoot,
    packageManager: detectPackageManager(repoRoot),
    packageCount: packages.length,
    packages,
    detectedBuildTools: detectBuildToolsFromFiles(repoRoot),
    detectedTestTools: detectTestToolsFromFiles(repoRoot),
    detectedCiProviders: detectCiProviders(repoRoot),
    lockfiles: listLockfiles(repoRoot),
  });

  return discovered;
}

export function summarizeWorkspaceFacts(facts: WorkspaceFacts): string {
  const pkgLine = `${facts.packageCount} package(s)`;
  const buildLine = facts.detectedBuildTools.length > 0
    ? `build: ${facts.detectedBuildTools.join(", ")}`
    : "build: none-detected";
  const testLine = facts.detectedTestTools.length > 0
    ? `test: ${facts.detectedTestTools.join(", ")}`
    : "test: none-detected";
  const ciLine = facts.detectedCiProviders.length > 0
    ? `ci: ${facts.detectedCiProviders.join(", ")}`
    : "ci: none-detected";
  return `${pkgLine}; ${buildLine}; ${testLine}; ${ciLine}`;
}
