import { z } from 'zod'

// These schemas validate the *untrusted* JSON the language model returns.
// Anything the model produces is coerced/checked here before it touches the DB
// or the scheduler. This is the single trust boundary for AI output.

export const intentSchema = z.enum([
  'general_chat',
  'create_task',
  'create_reminder',
  'schedule_app_open',
  'generate_email',
  'update_writing_style',
  'summarize_plan'
])

export const recurrenceSchema = z
  .enum(['none', 'daily', 'weekly', 'monthly'])
  .default('none')

const isoString = z
  .string()
  .min(1)
  .refine((s) => !Number.isNaN(Date.parse(s)), {
    message: 'must be a parseable date-time string'
  })

export const taskSchema = z.object({
  title: z.string().min(1).max(500),
  due: isoString.nullable().optional()
})

export const reminderSchema = z.object({
  title: z.string().min(1).max(500),
  datetime: isoString,
  recurrence: recurrenceSchema
})

export const scheduledActionSchema = z.object({
  // The model proposes an app name; the main process still checks it against
  // the allowlist before anything runs. This is intentionally just a string.
  app: z.string().min(1).max(120),
  datetime: isoString,
  note: z.string().max(500).nullable().optional()
})

export const emailDraftSchema = z.object({
  to: z.string().max(320).optional(),
  subject: z.string().max(300).optional(),
  body: z.string().min(1)
})

export const assistantResponseSchema = z.object({
  intent: intentSchema,
  response: z.string().min(1),
  tasks: z.array(taskSchema).default([]),
  reminders: z.array(reminderSchema).default([]),
  scheduledActions: z.array(scheduledActionSchema).default([]),
  email: emailDraftSchema.optional(),
  // Optional summary string the model may include for summarize_plan.
  writingProfileSummary: z.string().optional()
})

export type AssistantResponse = z.infer<typeof assistantResponseSchema>
