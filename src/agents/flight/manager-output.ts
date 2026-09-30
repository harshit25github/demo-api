import { z } from 'zod';

/** The Flight model reports its outcome, not a finished user message. */
export const flightManagerOutputSchema = z.object({
  status: z.enum(['success', 'partial', 'needs_input', 'failure']),
  completedTask: z.string().trim().min(1).max(160),
  resultSummary: z.string().trim().min(1).max(480),
  missingInformation: z.array(z.string().trim().min(1).max(160)).max(3),
}).strict();

export type FlightManagerOutput = z.infer<typeof flightManagerOutputSchema>;
