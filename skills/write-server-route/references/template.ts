// server/api/feature.post.ts
import { defineEventHandler, readBody } from 'h3'
import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server'
// auto-imported in server/ — shown here for clarity only
import handleServerError from '#server/utils/handleServerError'

const schema = z.object({
  name: z.string().min(1),
})

export default defineEventHandler(async (event) => {
  try {
    const client = await serverSupabaseClient(event)
    const body = await readBody(event)
    const parsed = schema.safeParse(body)

    if (!parsed.success) {
      throw createError({
        statusCode: 422,
        data: { error: { code: 'INVALID_INPUT', message: parsed.error.message } },
      })
    }

    const { data, error } = await client
      .from('table')
      .insert(parsed.data)
      .select()
      .single()

    if (error) throw error

    return data
  } catch (err) {
    throw handleServerError(err, event, 'Failed to create record')
  }
})
