# Contributing to Orbyt

Thanks for helping. Short version:

1. **Sign the CLA** ([CLA.md](CLA.md)) — required before a PR can be merged.
2. **Setup:** Node 22+, pnpm 10+, Docker.
   ```sh
   pnpm install
   docker compose up -d   # Postgres, Redis
   pnpm typecheck && pnpm build && pnpm test
   ```
3. **Keep changes small** and focused; link the issue or roadmap item in
   [orbyt-project-plan.md](orbyt-project-plan.md).
4. **Format** with `pnpm format` before pushing; CI runs `pnpm format:check`.
5. **Security issues:** do not open a public issue — see [SECURITY.md](SECURITY.md).

Code under `ee/` is proprietary; outside contributions go to the AGPL core.
