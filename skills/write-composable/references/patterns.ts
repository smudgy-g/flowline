// ─── Data Fetching Composable ───────────────────────────────────────────────
export function useFeature() {
  const data = ref<FeatureType | null>(null)
  const error = ref<string | null>(null)
  const loading = ref(false)

  async function load(id: string) {
    loading.value = true
    error.value = null
    try {
      data.value = await $fetch<FeatureType>(`/api/feature/${id}`)
    } catch {
      error.value = 'Failed to load'
    } finally {
      loading.value = false
    }
  }

  return { data, error, loading, load }
}

// ─── Form Composable (Zod + Nuxt UI) ────────────────────────────────────────
import * as z from 'zod'
import type { FormSubmitEvent } from '@nuxt/ui'

export const mySchema = z.object({
  email: z.email('Invalid email'),
  name: z.string().min(1, 'Required'),
})
export type MySchema = z.output<typeof mySchema>

export function useMyForm() {
  const state = reactive<Partial<MySchema>>({ email: undefined, name: undefined })

  async function onSubmit(event: FormSubmitEvent<MySchema>) {
    await $fetch('/api/my-endpoint', { method: 'POST', body: event.data })
  }

  return { state, schema: mySchema, onSubmit }
}
