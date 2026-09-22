# OTel Judge

Cloudflare Workers project scaffold for the OTel Judge Agent.

Install dependencies with `npm ci`, then generate binding types with
`npx wrangler types`. Start local development with `npx wrangler dev`.
The Worker currently returns HTTP 501 and the evaluation workflow is a placeholder.

Check types with `npm run typecheck` and build without deploying with
`npx wrangler deploy --dry-run --outdir dist`.

## Secrets

Set `TYPESAFE_API_KEY` and `FIREHOSE_SECRET` in a local `.dev.vars` file.
This file is ignored by Git. For deployment, set each secret interactively
with `npx wrangler secret put TYPESAFE_API_KEY` and
`npx wrangler secret put FIREHOSE_SECRET`. Never put secret values in
`wrangler.jsonc` or commit them.

Regenerate binding types with `npx wrangler types` after changing
`wrangler.jsonc`. Generated types are ignored by Git.
