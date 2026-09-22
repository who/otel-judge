import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
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
