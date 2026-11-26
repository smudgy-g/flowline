---
name: write-tests
description: Test conventions for business logic. Use when writing tests for composables, pure functions, validations, and state machines. Tests verify internal business logic only — not server routes, DB queries, Supabase, or external services.
---

Tests use Vitest + Vue Test Utils.

## Testing Philosophy

Tests verify **business logic only** — composables, pure functions, state machines, validations, transformations. The app's business logic lives in composables and shared utils. That's what you test.

Do NOT test:
- Server routes / API handlers
- Supabase queries or DB persistence
- External API calls or third-party integrations
- Framework internals (Nuxt routing, Vue reactivity mechanics)
- Configuration or wiring code

## What to Test

- Composable state transitions — given input X, when action Y, then state Z
- Pure functions — given input, expected output
- Validation logic — valid/invalid inputs produce correct errors
- State machines — all valid state transitions, rejected invalid ones
- Data transformations — mapping, filtering, sorting business objects

## Test Pattern

```typescript
import { describe, it, expect } from 'vitest'

describe('useFeature', () => {
  describe('given [context from spec]', () => {
    it('when [action], then [expected outcome]', () => {
      // Arrange
      // Act
      // Assert
    })
  })
})
```

## Rules

- Test name: `when [action], then [outcome]` — derivable from spec criterion
- Every acceptance criterion maps to at least one test
- Arrange-Act-Assert structure always
- No trivial tests (asserting a function exists is not a test)
- Test external behaviour, not implementation details
- You MUST import the actual source file (composable or utility)
- Never define a variable in a test and then assert its own value
- No mocks for business logic tests — inject test data directly. Business logic is pure or reactive, not I/O-bound.

## Snapshots

See ADR 0033 (`docs/adr/0033-snapshots-gate-markup-not-behaviour.md`) in the client repo.

A snapshot asserts that **rendered markup did not change**. It is not a behaviour gate.

- **Use one** when the change should not alter rendered output — wide mechanical refactors, prop/attribute plumbing, dependency bumps. The diff, ideally empty, *is* the assertion.
- **Do not use one** when the markup is about to change on purpose — component rewrites, form-stack migrations, redesigns. It will be regenerated exactly when it should be gating. Drive the DOM instead (`setValue`, `trigger`, assert rendered text or the last emitted payload) and **delete the snapshot**.
- Pair every snapshot with at least one behavioural assertion. A spec whose only assertion is `toMatchSnapshot` gates nothing about intent.
- Regenerate with `pnpm test -- -u`, then **read the diff** and account for every line. Class/attribute churn is expected under a size or theme change; a changed input `name`, `value`, `type`, or a reordered field is a defect until proven otherwise.
- Never regenerate a red suite just to make it green.
- For composables, verify that changing a `ref` triggers the expected reactive logic
