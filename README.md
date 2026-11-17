# Orbyt

The open-source growth platform: CRM + email outreach + visual automation + AI
agents, in one self-hostable product. (Working name — see the plan, §14.)

> **Status: Phase 0 (foundation).** Nothing usable yet. Roadmap and
> architecture: [orbyt-project-plan.md](orbyt-project-plan.md).

## Develop

```sh
pnpm install
docker compose up -d     # Postgres :5432, Redis :6379
pnpm typecheck && pnpm build && pnpm test
```

Copy `.env.example` to `.env` to override the dev defaults. The defaults are
for local development only and bind to `127.0.0.1`.

## License

Core: [AGPL-3.0](LICENSE). Code under `ee/` is proprietary
([ee/LICENSE](ee/LICENSE)). Contributions require a [CLA](CLA.md).
