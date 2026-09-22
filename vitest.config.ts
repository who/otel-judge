import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import agents from "agents/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
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
    // Vitest 4 equivalents of the Workers pool's former singleWorker option.
    maxWorkers: 1,
    isolate: false,
  },
});
