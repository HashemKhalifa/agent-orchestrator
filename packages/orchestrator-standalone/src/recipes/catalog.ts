import {
  ExecutionRecipeSchema,
  type ExecutionRecipe,
  type GateDefinition,
} from "../spec/schemas.js";

const DEFAULT_TYPECHECK_GATE_COMMAND =
  "bash -lc 'if pnpm -s run | grep -q \" type-check\"; then pnpm run type-check; elif pnpm -s run | grep -q \" typecheck\"; then pnpm run typecheck; elif npm -s run | grep -q \" type-check\"; then npm run type-check; elif npm -s run | grep -q \" typecheck\"; then npm run typecheck; else echo \"No typecheck script (expected type-check or typecheck)\" >&2; exit 1; fi'";
const DEFAULT_TEST_GATE_COMMAND =
  "bash -lc 'if pnpm -s run | grep -q \" test:run\"; then pnpm run test:run; elif pnpm -s run | grep -q \" test\"; then pnpm test; elif npm -s run | grep -q \" test:run\"; then npm run test:run; elif npm -s run | grep -q \" test\"; then npm test; else echo \"No test script (expected test:run or test)\" >&2; exit 1; fi'";
const DEFAULT_SMOKE_DEV_HELP_COMMAND =
  "bash -lc 'if pnpm -s run | grep -q \" dev\"; then pnpm run dev -- --help; elif npm -s run | grep -q \" dev\"; then npm run dev -- --help; else echo \"No dev script\" >&2; exit 1; fi'";

const DEFAULT_GATES: GateDefinition[] = [
  {
    id: "gate-typecheck",
    title: "Typecheck passes",
    kind: "command",
    required: true,
    command: DEFAULT_TYPECHECK_GATE_COMMAND,
  },
  {
    id: "gate-tests",
    title: "Tests pass",
    kind: "command",
    required: true,
    command: DEFAULT_TEST_GATE_COMMAND,
  },
  {
    id: "gate-high-risk",
    title: "No unresolved high/critical risk findings",
    kind: "risk",
    required: true,
    note: "Strict blocker mode fails apply when high/critical risks remain open.",
  },
];

const RECIPES: ExecutionRecipe[] = [
  {
    id: "webpack-to-rsbuild-incremental",
    version: "1.0.0",
    title: "Webpack to Rsbuild (Incremental Dual-Build)",
    description:
      "Migrate a monorepo from Webpack to Rsbuild using waves with dual-build parity checks.",
    goalType: "build_migration",
    defaultWaveStrategy: "incremental_dual_build",
    preconditions: {
      packageManagers: ["npm", "pnpm", "yarn"],
      requiresFiles: ["package.json"],
      requiresBuildTools: ["webpack"],
    },
    discoverySources: [
      {
        id: "rsbuild-migrate",
        title: "Rsbuild Migration Guide",
        url: "https://rsbuild.dev/guide/migration/webpack",
        type: "primary",
        tags: ["migration", "rsbuild", "webpack"],
      },
      {
        id: "rspack-compat",
        title: "Rspack Compatibility Guide",
        url: "https://rspack.dev/guide/compatibility/webpack",
        type: "primary",
        tags: ["compatibility", "loaders", "plugins"],
      },
      {
        id: "rsbuild-plugin-docs",
        title: "Rsbuild Plugin Ecosystem Overview",
        url: "https://rsbuild.dev/plugins/list",
        type: "curated_secondary",
        tags: ["plugins", "edge-cases"],
      },
    ],
    riskProbes: [
      {
        id: "webpack-mf",
        title: "Module federation plugin usage",
        category: "compatibility",
        severity: "high",
        regex: "ModuleFederationPlugin",
        fileGlobsHint: ["webpack.config.*"],
        advice: "Map module-federation usage to Rsbuild/Rspack equivalents before cutover.",
      },
      {
        id: "webpack-custom-loader",
        title: "Custom loader path usage",
        category: "compatibility",
        severity: "high",
        regex: "loader\s*:\s*['\"][./]",
        fileGlobsHint: ["webpack.config.*"],
        advice: "Custom loaders often need option/schema translation.",
      },
      {
        id: "webpack-cache-risk",
        title: "Aggressive filesystem cache configuration",
        category: "performance",
        severity: "medium",
        regex: "cache\s*:\s*\{[^}]*filesystem",
        fileGlobsHint: ["webpack.config.*"],
        advice: "Validate cache invalidation to avoid stale artifacts after migration.",
      },
    ],
    steps: [
      {
        id: "discover-build-topology",
        title: "Discover build topology",
        kind: "analyze",
        description: "Enumerate webpack entrypoints, loader/plugin usage, and package ownership.",
        mutating: false,
      },
      {
        id: "generate-rsbuild-scaffold",
        title: "Generate rsbuild config scaffold",
        kind: "transform",
        description: "Create package-local rsbuild config while retaining webpack config.",
        mutating: true,
      },
      {
        id: "enable-dual-build-ci",
        title: "Enable dual-build parity gates",
        kind: "transform",
        description: "Run webpack and rsbuild side-by-side in CI for selected wave.",
        mutating: true,
      },
      {
        id: "validate-runtime-parity",
        title: "Validate runtime parity",
        kind: "verify",
        description: "Run typecheck/tests plus smoke tests to verify behavior equivalence.",
        mutating: false,
      },
      {
        id: "wave-cutover",
        title: "Wave cutover",
        kind: "gate",
        description: "Flip default builder to rsbuild only after required gates pass.",
        mutating: true,
      },
    ],
    gates: [
      ...DEFAULT_GATES,
      {
        id: "gate-build",
        title: "Build passes",
        kind: "command",
        required: true,
        command: "npm run build",
      },
    ],
    rollbackHints: [
      "Keep webpack configs intact until wave gate is green.",
      "Use package-local feature toggles to revert default builder.",
    ],
    edgeCases: [
      "Module federation remotes/shared singleton behavior mismatch.",
      "Loader option schema differences affecting asset transforms.",
    ],
  },
  {
    id: "react18-to-react19",
    version: "1.0.0",
    title: "React 18 to React 19",
    description:
      "Upgrade React dependencies and app/runtime integration from 18.x to 19.x with strict breaking-change gates.",
    goalType: "dependency_upgrade",
    defaultWaveStrategy: "pilot_wave",
    preconditions: {
      packageManagers: ["npm", "pnpm", "yarn"],
      requiresFiles: ["package.json"],
      requiresBuildTools: [],
    },
    discoverySources: [
      {
        id: "react19-blog",
        title: "React 19 Release Post",
        url: "https://react.dev/blog/2024/12/05/react-19",
        type: "primary",
        tags: ["release", "breaking"],
      },
      {
        id: "react-upgrade-guide",
        title: "React Upgrade Guides",
        url: "https://react.dev/blog",
        type: "primary",
        tags: ["upgrade", "deprecations"],
      },
      {
        id: "testing-library-react19",
        title: "Community migration notes for React 19 testing",
        url: "https://github.com/testing-library/react-testing-library/releases",
        type: "curated_secondary",
        tags: ["testing", "compatibility"],
      },
    ],
    riskProbes: [
      {
        id: "legacy-render-api",
        title: "Legacy ReactDOM.render usage",
        category: "breaking_change",
        severity: "high",
        regex: "ReactDOM\\.render\\(",
        fileGlobsHint: ["src/**/*"],
        advice: "Migrate to createRoot/hydrateRoot APIs.",
      },
      {
        id: "unsafe-lifecycle",
        title: "Unsafe class lifecycle methods",
        category: "compatibility",
        severity: "medium",
        regex: "UNSAFE_componentWill",
        fileGlobsHint: ["src/**/*"],
        advice: "Audit class components for deprecated lifecycle behavior.",
      },
      {
        id: "effect-cleanup",
        title: "Potential useEffect cleanup omissions",
        category: "memory",
        severity: "high",
        regex: "useEffect\\((.|\\n){0,500}(setInterval|addEventListener)",
        fileGlobsHint: ["src/**/*"],
        advice: "Ensure side-effects return cleanup functions to avoid leaks.",
      },
    ],
    steps: [
      {
        id: "inventory-react-usage",
        title: "Inventory react usage and APIs",
        kind: "analyze",
        description: "Map all React/ReactDOM usage patterns and dependency ranges.",
        mutating: false,
      },
      {
        id: "upgrade-dependencies",
        title: "Upgrade React dependencies",
        kind: "transform",
        description: "Update React, ReactDOM, and known peer dependencies to compatible versions.",
        mutating: true,
      },
      {
        id: "patch-breaking-apis",
        title: "Patch breaking APIs",
        kind: "transform",
        description: "Apply codemods/manual fixes for removed/deprecated APIs.",
        mutating: true,
      },
      {
        id: "validate-runtime",
        title: "Validate runtime and tests",
        kind: "verify",
        description: "Run tests, typechecks, and app smoke tests for each wave.",
        mutating: false,
      },
    ],
    gates: [
      ...DEFAULT_GATES,
      {
        id: "gate-smoke",
        title: "Smoke test command passes",
        kind: "command",
        required: false,
        command: DEFAULT_SMOKE_DEV_HELP_COMMAND,
        note: "Optional by default because monorepo apps often use custom runner commands.",
      },
    ],
    rollbackHints: [
      "Keep lockfile snapshot before dependency bump.",
      "Rollback per wave by restoring package.json + lockfile for that wave.",
    ],
    edgeCases: [
      "Third-party libraries pinning React peer deps <19.",
      "Hydration behavior changes in SSR apps.",
    ],
  },
  {
    id: "jest-to-vitest",
    version: "1.0.0",
    title: "Jest to Vitest",
    description:
      "Migrate test runner configuration, scripts, and mocks from Jest to Vitest with parity checks.",
    goalType: "test_runner_migration",
    defaultWaveStrategy: "pilot_wave",
    preconditions: {
      packageManagers: ["npm", "pnpm", "yarn"],
      requiresFiles: ["package.json"],
      requiresBuildTools: [],
    },
    discoverySources: [
      {
        id: "vitest-migration",
        title: "Vitest Migration Guide",
        url: "https://vitest.dev/guide/migration",
        type: "primary",
        tags: ["migration", "jest"],
      },
      {
        id: "vitest-config",
        title: "Vitest Config Reference",
        url: "https://vitest.dev/config/",
        type: "primary",
        tags: ["config", "mocks"],
      },
      {
        id: "jest-docs",
        title: "Jest Configuration Reference",
        url: "https://jestjs.io/docs/configuration",
        type: "curated_secondary",
        tags: ["compatibility", "differences"],
      },
    ],
    riskProbes: [
      {
        id: "jest-globals",
        title: "Jest global API usage",
        category: "compatibility",
        severity: "high",
        regex: "\bjest\\.",
        fileGlobsHint: ["**/*.test.*", "**/*.spec.*"],
        advice: "Replace with vi.* or enable compatible globals where appropriate.",
      },
      {
        id: "jest-fake-timers",
        title: "Jest fake timer configuration",
        category: "performance",
        severity: "medium",
        regex: "useFakeTimers|setSystemTime",
        fileGlobsHint: ["**/*.test.*", "jest.config.*"],
        advice: "Verify timer semantics parity in Vitest.",
      },
      {
        id: "unclosed-handles",
        title: "Potential unclosed async handles",
        category: "memory",
        severity: "high",
        regex: "(createServer|setInterval|watch)\\(",
        fileGlobsHint: ["**/*.test.*"],
        advice: "Ensure teardown hooks close resources to avoid worker leaks.",
      },
    ],
    steps: [
      {
        id: "inventory-jest-usage",
        title: "Inventory Jest usage",
        kind: "analyze",
        description: "Map jest config files, transformers, setup files, and APIs.",
        mutating: false,
      },
      {
        id: "add-vitest-config",
        title: "Add Vitest config and scripts",
        kind: "transform",
        description: "Create vitest config and map script commands.",
        mutating: true,
      },
      {
        id: "migrate-tests",
        title: "Migrate Jest APIs",
        kind: "transform",
        description: "Replace incompatible jest APIs/mocks with vitest-compatible patterns.",
        mutating: true,
      },
      {
        id: "parity-check",
        title: "Parity check",
        kind: "verify",
        description: "Run test suites and validate coverage/perf parity where required.",
        mutating: false,
      },
    ],
    gates: [
      ...DEFAULT_GATES,
      {
        id: "gate-vitest",
        title: "Vitest command passes",
        kind: "command",
        required: true,
        command: "npx vitest run",
      },
    ],
    rollbackHints: [
      "Keep Jest config until Vitest parity is stable.",
      "Retain temporary compatibility shim for one release if needed.",
    ],
    edgeCases: [
      "Custom Jest transformers requiring Vite plugin alternatives.",
      "Snapshot serialization differences across runners.",
    ],
  },
  {
    id: "ci-node-build-test-modernization",
    version: "1.0.0",
    title: "CI Build/Test Modernization",
    description:
      "Refactor CI pipelines for deterministic caching, parallelization, and stronger quality gates.",
    goalType: "ci_refactor",
    defaultWaveStrategy: "pilot_wave",
    preconditions: {
      packageManagers: ["npm", "pnpm", "yarn", "unknown"],
      requiresFiles: ["package.json"],
      requiresBuildTools: [],
    },
    discoverySources: [
      {
        id: "github-actions-cache",
        title: "GitHub Actions Caching",
        url: "https://docs.github.com/actions/using-workflows/caching-dependencies-to-speed-up-workflows",
        type: "primary",
        tags: ["ci", "cache"],
      },
      {
        id: "npm-ci-best-practices",
        title: "npm ci command",
        url: "https://docs.npmjs.com/cli/v10/commands/npm-ci",
        type: "primary",
        tags: ["ci", "determinism"],
      },
      {
        id: "ci-flake-guide",
        title: "Common CI flake patterns",
        url: "https://martinfowler.com/articles/continuousIntegration.html",
        type: "curated_secondary",
        tags: ["flake", "quality"],
      },
    ],
    riskProbes: [
      {
        id: "ci-no-lockfile",
        title: "CI install without lockfile pin",
        category: "compatibility",
        severity: "high",
        regex: "npm install",
        fileGlobsHint: [".github/workflows/*", ".gitlab-ci.yml"],
        advice: "Use deterministic install command for reproducibility.",
      },
      {
        id: "ci-unbounded-cache",
        title: "Potential unbounded CI cache growth",
        category: "performance",
        severity: "medium",
        regex: "cache",
        fileGlobsHint: [".github/workflows/*", ".gitlab-ci.yml"],
        advice: "Enforce scoped keys and restore/expire policies.",
      },
    ],
    steps: [
      {
        id: "inventory-pipeline",
        title: "Inventory CI pipeline",
        kind: "analyze",
        description: "Map jobs, artifacts, cache usage, and quality gates.",
        mutating: false,
      },
      {
        id: "refactor-pipeline",
        title: "Refactor CI jobs",
        kind: "transform",
        description: "Apply deterministic install, cache controls, and explicit gate jobs.",
        mutating: true,
      },
      {
        id: "validate-ci",
        title: "Validate CI runs",
        kind: "verify",
        description: "Run local parity checks and validate workflow syntax.",
        mutating: false,
      },
    ],
    gates: [
      ...DEFAULT_GATES,
      {
        id: "gate-lint",
        title: "Lint passes",
        kind: "command",
        required: false,
        command: "npm run lint",
      },
    ],
    rollbackHints: [
      "Retain previous workflow files until modernized pipeline is stable.",
    ],
    edgeCases: [
      "Self-hosted runner differences in toolchain availability.",
      "Artifact retention rules differing by CI provider.",
    ],
  },
];

export function getRecipeCatalog(): ExecutionRecipe[] {
  return RECIPES.map((recipe) => ExecutionRecipeSchema.parse(recipe));
}

export function getRecipeById(recipeId: string): ExecutionRecipe {
  const recipe = RECIPES.find((candidate) => candidate.id === recipeId);
  if (!recipe) {
    const valid = RECIPES.map((candidate) => candidate.id).join(", ");
    throw new Error(`Unknown recipe '${recipeId}'. Valid recipes: ${valid}`);
  }
  return ExecutionRecipeSchema.parse(recipe);
}
