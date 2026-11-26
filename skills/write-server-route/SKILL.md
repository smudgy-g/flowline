---
name: write-server-route
description: Conventions for Nitro API routes in server/api/. Use when writing or reviewing any server-side route handler — zod validation, serverSupabaseClient, handleServerError pattern, authenticated routes.
---

All routes under `server/api/` using Nuxt file-based routing conventions.

See the full route template: [references/template.ts](references/template.ts)

## Rules

- Always validate input with `zod` before use — no raw body access
- Use `serverSupabaseClient(event)` — never the anon client in server routes
- Wrap all route logic in try/catch and `throw handleServerError(error, event, 'message')`
  — it **returns** a `NuxtError`, it does not send one. Calling or returning it without
  `throw` answers 200 with an empty or error-shaped body, so the caller cannot tell
  success from failure
- Auto-imported in `server/` — no import needed. Where an explicit import is
  unavoidable: `#server/utils/handleServerError`
- `handleServerError` handles logging, Sentry tracking, and error response formatting
- A bare `handleServerError(...)` is correct only outside `server/api/` — a util with no
  response to write into, or a deliberate log-and-continue after a write that already
  committed. Comment the intent at those call sites
- If the spec marks the route as authenticated, verify the session via the Supabase client before proceeding
- Error responses are `NuxtError`s: `{ status, statusText, message, data }` — there is no
  `{ error: { code, message } }` envelope
- No `console.log`, and no `console.error` alongside `handleServerError` — it already logs
  and reports to Sentry
