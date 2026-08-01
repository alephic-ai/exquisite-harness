import stripJsonComments from 'strip-json-comments'
import { z } from 'zod'

const piModelsJsonSchema = z.object({
  providers: z
    .record(
      z.string(),
      z.looseObject({
        apiKey: z.string().optional(),
        baseUrl: z.string().optional(),
      }),
    )
    .default({}),
})

export type PiModelsJson = z.infer<typeof piModelsJsonSchema>

export function parsePiModelsJson(raw: string) {
  try {
    const parsed = piModelsJsonSchema.safeParse(
      JSON.parse(stripJsonComments(raw)),
    )
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}
