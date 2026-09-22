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
    // Vitest 4 equivalent of the Workers pool's former singleWorker option: one
    // workerd for the whole run, every file in sequence.
    //
    // This was the first suspect when a whole-suite run failed one arbitrary
    // case per pass with "Test timed out in 5000ms" — a shared instance keeps
    // every Durable Object a suite created alive until the run ends. It is not
    // the cause. A failing run's real wall time was the usual six seconds; the
    // twenty seconds Vitest reported for the "slow" test was the system clock
    // stepping forward under it and back again a test later, which inside
    // workerd is the only clock Vitest has (`performance.now()` is
    // `Date.now()`). Per-file isolation makes the same run three times slower
    // and changes nothing about a clock step, so the shared worker stays and
    // `test/setup/wall-clock.ts` names a step when one happens.
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
          setupFiles: ["test/setup/wall-clock.ts"],
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
