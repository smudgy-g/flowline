---
name: write-composable
description: Conventions for Vue 3 composables in app/composables/. Use when writing data-fetching composables, form state/validation composables, or any shared reactive logic. Covers useFetch vs $fetch, Zod+Nuxt UI form pattern.
---

One concern per file. All composables in `app/composables/`.

See code patterns: [references/patterns.ts](references/patterns.ts)

## Rules

- Use `useFetch` / `useAsyncData` for SSR-compatible data fetching (page load, navigations)
- Use `$fetch` for mutations triggered by user actions (POST/PUT/DELETE)
- No business logic in components — extract to composables
- Always return `{ data, error, loading, ...actions }` consistently
- Use `ref` for mutable state, `computed` for derived values
- No side effects on import — all effects inside returned functions or lifecycle hooks

## Form Validation Rules (Zod + Nuxt UI)

- Use `z.output<typeof schema>` (not `z.infer`) for form state type — captures Zod transforms
- Form state must be `reactive<Partial<Schema>>({...})` — plain reactive object
- Do NOT use `useForm`, `useField`, or `Field`/`Form` from vee-validate
- Do NOT use Yup schemas
