/**
 * Boundary validation. Every byte that enters the pipeline from a remote API is
 * parsed through one of these first, so an upstream shape change fails the sync
 * instead of silently writing garbage into the dataset.
 */
import { z } from 'zod';

/** A single issue from GET /projects/7444821/issues. Unknown keys are dropped. */
export const GitLabIssueSchema = z.object({
  iid: z.number().int().positive(),
  title: z.string(),
  description: z.string().nullable().default(null),
  state: z.enum(['opened', 'closed']),
  created_at: z.string().min(20),
  closed_at: z.string().nullable(),
  updated_at: z.string().min(20),
  labels: z.array(z.string()),
  web_url: z.string().url(),
});
export type GitLabIssue = z.infer<typeof GitLabIssueSchema>;

export const GitLabIssuePageSchema = z.array(GitLabIssueSchema);

/** GET /issues/{iid}/resource_label_events (requires a read_api token). */
export const ResourceLabelEventSchema = z.object({
  id: z.number(),
  created_at: z.string(),
  action: z.enum(['add', 'remove']),
  label: z
    .object({ id: z.number().optional(), name: z.string() })
    .nullable()
    .default(null),
});
export const ResourceLabelEventPageSchema = z.array(ResourceLabelEventSchema);

/** GET https://api.status.io/1.0/status/{id} */
export const StatusIoComponentSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  status_code: z.number().int(),
  // Status.io returns per-container rows; we only ever read the four above.
});

export const StatusIoResponseSchema = z.object({
  result: z.object({
    status_overall: z.object({
      updated: z.string(),
      status: z.string(),
      status_code: z.number().int(),
    }),
    status: z.array(StatusIoComponentSchema).min(1),
  }),
});
export type StatusIoResponse = z.infer<typeof StatusIoResponseSchema>;
