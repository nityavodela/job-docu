# Personal work log

## Local development

Install packages with `npm install`. To run the app with its Cloudflare Pages Functions and a local D1 database:

1. Apply the local database migration: `npx wrangler d1 migrations apply personal-work-log --local`.
2. Create `.dev.vars` in the repository root with `SYNC_TOKEN=` followed by a random local-only value. This file is ignored by git.
3. Build the app: `npm run build`.
4. Start Pages locally: `npx wrangler pages dev dist`.

Open the local URL Wrangler prints. The app and `/api` functions share the same origin. The Vite-only `npm run dev` remains available for Stage 1 offline UI work, but it does not serve Pages Functions.

## Cloudflare setup

1. In the Cloudflare dashboard, create a D1 database named `personal-work-log`.
2. Copy its database ID into `wrangler.toml`, replacing the clearly marked all-zero placeholder. Keep the binding name `DB`.
3. In **Workers & Pages**, create or select the Pages project connected to this repository and deploy the branch containing these changes. Set the build command to `npm ci && npm run build` and the build output directory to `dist`.
4. In the Pages project **Settings → Bindings**, add a D1 database binding named `DB` and select `personal-work-log`. Deploy again after changing bindings.
5. In **Settings → Variables and Secrets**, add `SYNC_TOKEN` as a secret. Use a long, random value; do not commit it or put it in a client-side variable.
6. From a trusted local checkout with the database ID configured, apply the schema to the remote database: `npx wrangler d1 migrations apply personal-work-log --remote`.
7. Open the deployed app, enter the same `SYNC_TOKEN` in **Settings**, save it, and use **Test connection**.

The browser stores the sync token on that device only. Removing browser storage or using another device requires entering the token again.



