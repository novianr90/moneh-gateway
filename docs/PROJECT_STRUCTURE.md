# Project Structure & Directory Guidelines: `moneh-gateway`

**Version:** 1.0
**Status:** Current
**Architecture:** Fastify API Gateway serving `tracker-moneh` (SvelteKit frontend, separate repo).

---

## 1. Directory Layout

```text
moneh-gateway/
├── docs/                       # This documentation set
│   └── features/               # One PRD per feature/issue
├── supabase/
│   ├── functions/              # Edge functions (sync-google-sheets, scheduled-sync-google-sheets)
│   └── migrations/             # Schema migrations - source of truth for the shared Supabase project
├── src/
│   ├── config/
│   │   └── env.ts              # Env var parsing (USE_ACTUAL, ports, keys, Actual config)
│   ├── lib/
│   │   └── types/
│   │       └── database.types.ts  # Hand-maintained Supabase Database type, mirrors migrations
│   ├── plugins/
│   │   └── auth.ts             # Fastify auth decorator/hook (session cookie -> request.user/supabase)
│   ├── routes/                 # Thin REST controllers - one file per resource
│   │   ├── auth.routes.ts
│   │   ├── categories.routes.ts
│   │   ├── expenses.routes.ts
│   │   ├── health.routes.ts
│   │   ├── paymentMethods.routes.ts
│   │   ├── sync.routes.ts
│   │   └── userConfig.routes.ts
│   ├── services/                # Business logic & Saga engines - no Fastify types here
│   │   ├── actual.service.ts          # Actual Budget SDK manager, master-data sync, budget adjustment
│   │   ├── auth.service.ts
│   │   ├── categories.service.ts
│   │   ├── expenses.service.ts        # Saga Dual-Write orchestrator & retry logic
│   │   ├── paymentMethods.service.ts
│   │   ├── reconciliation.service.ts  # Background reconciliation runner
│   │   ├── sync.service.ts            # Google Sheets dual-sync coordinator
│   │   └── userConfig.service.ts      # Per-user actual_sync_id / bills_category_id
│   └── index.ts                 # Server bootstrap, route registration, background workers
├── Dockerfile                    # Multi-stage node:22-alpine build
└── package.json
```

---

## 2. Layer Rules

| Directory | Primary Responsibility | Belongs Here | Must NOT Belong Here |
| :--- | :--- | :--- | :--- |
| `src/routes/` | HTTP surface: parse request, call service, shape response | Fastify handlers, request/reply typing, status codes | Business logic, direct Supabase queries beyond what a service returns |
| `src/services/` | Business logic, Saga orchestration, third-party SDK calls | Supabase queries, `@actual-app/api` calls, state machine transitions | Fastify types (`FastifyRequest`/`Reply`) |
| `src/lib/types/` | Type contracts | `database.types.ts`, shared interfaces | Business logic implementations |
| `src/config/` | Environment/config parsing | `env.ts` | Business logic |
| `src/plugins/` | Fastify cross-cutting concerns | Auth hooks, request decoration | Route-specific logic |
| `supabase/migrations/` | Schema evolution | One file per change, timestamp-prefixed, idempotent (`IF NOT EXISTS` / `IF EXISTS`) | Application code |

## 3. Strict Architectural Principles

1. **Gateway Isolation:** `tracker-moneh` never talks directly to Supabase Postgres or Actual Budget — everything is mediated through this gateway's REST API.
2. **Zero Credentials in Client:** No database secrets or Actual Budget password ever reach the frontend bundle.
3. **Services Own State Transitions:** `sync_status`/`sync_failure_type` transitions live only in `services/`, never inline in a route handler.
4. **Strong Typing:** `database.types.ts` is hand-maintained in lockstep with `supabase/migrations/` — every schema change updates both in the same commit.
5. **New Feature → New Doc:** a feature big enough to need its own migration and cross-cutting logic gets a PRD in `docs/features/`, not just inline comments.
