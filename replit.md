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

### Authentication (App-level)
- Register/Login with username + password (bcrypt hashed), session stored via express-session cookie
- Routes: `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`
- Frontend pages: `artifacts/fb-guard/src/pages/login.tsx`, `artifacts/fb-guard/src/pages/register.tsx`

### Dashboard
- Main protected page: `artifacts/fb-guard/src/pages/dashboard.tsx`
- Shows 3 Facebook cookie account pools: FRA, RPW, Normal
- Users add raw Facebook cookies categorized by type; FB name/uid auto-detected on add
- Action Panel: react/comment/follow with target URL, cookie pool selection, account count slider, reaction type picker

### API Routes
- Auth: `artifacts/api-server/src/routes/auth.ts`
- Cookie account management: `artifacts/api-server/src/routes/accounts.ts` (`GET /api/accs`, `POST /api/accs/add`, `DELETE /api/accs/:id`)
- Multi-account actions: `artifacts/api-server/src/routes/actions.ts` (`POST /api/actions/react|comment|follow`)
- Facebook scraping: `artifacts/api-server/src/routes/facebook.ts`

### DB Tables
- `app_users` — app login users
- `fb_cookie_accounts` — Facebook session cookies per user, typed as fra/rpw/normal
- `saved_sessions` — legacy Facebook sessions (for existing features)

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
