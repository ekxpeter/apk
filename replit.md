# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.
Primary product is Facebook Guard, a web app with an Express API for Facebook account management. Current feature set includes cookie/password login, profile guard toggling, profile display, friends display, profile edit submission, post display/create/delete, video watch playback, and light/dark mode.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

## Facebook Guard

- Frontend: `artifacts/fb-guard/src/pages/home.tsx`
- API routes: `artifacts/api-server/src/routes/facebook.ts`
- API contract: `lib/api-spec/openapi.yaml`
- Generated client/schemas are regenerated with `pnpm --filter @workspace/api-spec run codegen`

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
