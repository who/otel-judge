import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import agents from "agents/vite";
import { configDefaults, defineConfig } from "vitest/config";

// The prompt-history generator is a developer-machine Node script: it reads the
// filesystem, spawns a child process, and renames files. workerd's node:fs shim
// answers some of that differently from Node, so running it in the Workers pool
// would test the shim rather than the script. It gets its own Node project.
const NODE_TESTS = ["test/prompt-history.test.ts"];

export default defineConfig({
  test: {
    // Vitest 4 equivalent of the Workers pool's former singleWorker option.
    maxWorkers: 1,
    projects: [
      {
        plugins: [
          // The callable history API is declared with TC39 decorators, which Vite 8's
          // Oxc transpiler leaves in the output and workerd then refuses to parse.
          // This plugin runs the decorator transform on the files that need it, so a
          // test reaches the same Agent the deployed bundle would.
          agents(),
          cloudflareTest({
            remoteBindings: false,
            wrangler: { configPath: "./wrangler.jsonc" },
          }),
        ],
        test: {
          name: "workers",
          include: ["test/**/*.test.ts"],
          exclude: [...configDefaults.exclude, ...NODE_TESTS],
          isolate: false,
        },
      },
      {
        test: {
          name: "node",
          environment: "node",
          include: NODE_TESTS,
        },
      },
    ],
  },
});
