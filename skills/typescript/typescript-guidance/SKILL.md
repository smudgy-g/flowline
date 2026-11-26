---
name: typescript-guidance
description: TypeScript correctness guidance for reading or editing TypeScript and Vue script blocks. Use for .ts, .tsx, and typed Vue code, especially boundary parsing, domain types, state variants, and API contracts.
---

# TypeScript Guidance

Follow repository conventions first. Apply rules where they make code safer or simpler; avoid type ceremony without concrete value.

## Rules

- External data starts as `unknown` and is parsed at boundary.
- Use repository schema library, usually Zod, before handwritten property guards. Infer types from authoritative schema when practical.
- Use discriminated unions for meaningful variants. Avoid optional-field bags representing mutually exclusive states.
- Make illegal states unrepresentable where this removes guards or assertions.
- Keep simplest total type. Strengthen arrays or primitives only when loose type causes casts, non-null assertions, or impossible-state branches.
- Prefer narrowing over casts: discriminant switch, `in`, `typeof`/`instanceof`, validated guard, then cast as last resort.
- Guards must validate full claim. Name `isX` or `hasX`.
- Prefer `satisfies` when checking shape while preserving literals.
- Exhaustively handle closed variants with `never`.
- Derive types from authoritative values and schemas using `typeof`, `z.infer`, `Pick`, `Omit`, `Parameters`, `ReturnType`, and `Awaited` before duplicating structures.
- Shared request/response contracts belong in existing shared type or schema location when both client and server consume them.
- Do not use `any` or double casts. A narrow cast is acceptable only when runtime evidence or framework limitation makes it safe and surrounding code documents reason.
- Do not brand every primitive. Brand only values whose accidental interchange is plausible and costly.
- Validate once at boundary; trust parsed types internally. Do not scatter redundant checks.
- Prefer explicit return types on exported boundaries and complex public functions. Let TypeScript infer obvious local callbacks and helpers.

## Verification

Compile/typecheck through repository lint/build command and run focused behavior tests. Types do not replace runtime validation at network, database, environment, or user-input boundaries.
