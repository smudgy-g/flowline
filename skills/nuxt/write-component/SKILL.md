---
name: write-component
description: Conventions for Vue 3 components in app/components/. Use when writing any UI component — naming, required UI states (loading/empty/error/success), form patterns with UForm+Zod, V-wrapper field components.
---

All components in `app/components/` — flat directory, no subdirectories.

See form pattern: [references/form-pattern.vue](references/form-pattern.vue)

## Naming Conventions

- `V{Name}` — base/reusable components (e.g., `VButton`, `VCard`)
- `The{Name}` — single-instance layout components (e.g., `TheNavigation`)
- `{Domain}{Name}` — domain-specific components (e.g., `ListingCard`, `MarketplaceFilter`)
- Always multi-word PascalCase

## Required UI States

Every component specified in the spec must handle all four states explicitly:
- **Loading** — skeleton or spinner
- **Empty** — empty state with message
- **Error** — error message with retry action
- **Success** — populated content

## Script Setup Layout

For new or substantially edited components, follow nearby `// MARK: ` headings when sections are large enough to benefit: Props & Emits, State, Computed Properties, Helpers/Actions, Watchers. Put runtime imports first and separate type-only imports below them where practical; keep existing inline `type` specifiers when importing from the same module. Place watchers near the end of `<script setup>`, after the state and functions they use. Do not add markers to tiny components or reorder existing watchers just for style: `immediate` and `watchEffect` can run during setup, so moving them can change behavior.

## General Rules

- No raw `fetch` in components — use composables via `useFetch` or `useAsyncData`
- No business logic in components
- Use `@nuxt/ui` components where available before writing custom
- TypeScript: `defineProps<{...}>()` and `defineEmits<{}>()`
- No direct DOM manipulation

## Field Components — Use V-Wrappers First

Before writing a new field implementation, check `app/components/` for an existing `V{Name}` component. If one exists, use it. If a field type has no wrapper yet, create the `V{Name}` component (with `UFormField` inside) rather than using raw Nuxt UI inline.

When writing or editing a wrapper (see ADR 0028):

- **No manual `:id` / `:for` / `:aria-labelledby`.** `UFormField` generates its own id and provides it to the child input; `<Label :for>` follows automatically. Never derive a DOM id from the `name` prop — `name` is not unique across repeated form sections. If you genuinely need an id to reference (e.g. `aria-controls`), use a local `useId()`.
- **No responsive `size`.** Do not compute `size` from `useMediaQuery` — `@nuxt/ui` already does this in CSS. The input theme's `{ fixed: false, size: 'md' }` compound variant adds `md:text-sm`, so `md` renders 16px on mobile (no iOS Safari auto-zoom) and 14px from ≥768px up. Pass no size at all and let the defaults (`formField: md`, `input: md`) apply, leaving `size` free to pass through `useAttrs`. `app.config.ts` pins `py-3!`, so the touch target does not depend on size either.
- **Never use a size below `md` on a text-entry control.** `xs`/`sm` are `text-sm` (14px) and iOS Safari zooms on focus.
- `VLabel` is a **field-group heading**, not a label. Use it to title a *row* of controls that each carry `is-label-hidden`. It has no `for`. A single control labels itself via its own `label` prop. It renders a plain `<span class="block …">` — **not** a `<legend>`, which is invalid outside a `<fieldset>` and carries no grouping semantics there anyway.

## Form Rules

- Use `<UForm>` — do NOT use vee-validate `<Form>` or `<Field>`
- Existing `V*` wrappers still call vee-validate `useField` internally. That is legacy, inert in `<UForm>` call sites, and being removed — see ADR 0028. Do not copy the pattern into a new wrapper.
- All form state comes from the composable — components own no validation logic
- For server-side errors: `form.value?.setErrors([{ name: 'email', message: '...' }])`
- Handle `@error` to focus the first broken field
