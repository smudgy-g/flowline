<script setup lang="ts">
import type { FormErrorEvent } from '@nuxt/ui'
import { useMyForm } from '~/composables/useMyForm'

const { state, schema, onSubmit } = useMyForm()
const form = useTemplateRef('form')

async function onError(event: FormErrorEvent) {
  const el = document.getElementById(event.errors[0]?.id ?? '')
  el?.focus()
  el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
}
</script>

<template>
  <UForm ref="form" :schema="schema" :state="state" @submit="onSubmit" @error="onError">
    <!-- Preferred: VInput already wraps UFormField -->
    <VInput v-model="state.email" label="Email" name="email" />
    <VSelect v-model="state.role" label="Role" name="role" :options="roles" />

    <!-- Only use raw UInput + UFormField when no V-wrapper exists -->
    <!-- <UFormField label="Avatar" name="avatar"><UInput type="file" /></UFormField> -->

    <UButton type="submit">Submit</UButton>
  </UForm>
</template>
