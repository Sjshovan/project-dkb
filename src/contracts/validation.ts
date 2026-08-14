import { z } from 'zod/v4';

export const queryHintsSchema = z.object({
  terms: z.array(z.string()).optional(),
  aliases: z.array(z.string()).optional(),
});

export const knowledgeNeedSchema = z.object({
  need: z.string().min(1),
  phrases: z.array(z.string().min(1)).optional(),
  context: z.string().min(1).optional(),
  avoid: z.array(z.string().min(1)).optional(),
  filters: z.object({
    targetIds: z.array(z.string().min(1)).optional(),
    sourceTypes: z.array(z.string().min(1)).optional(),
    regionTypes: z.array(z.string().min(1)).optional(),
  }).optional(),
  retrieval: z.object({
    passes: z.array(z.enum(['lexical', 'vector', 'graph'])).optional(),
    minScore: z.number().min(0).optional(),
    cutoff: z.number().min(0).max(1).optional(),
  }).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  profile: z.boolean().optional(),
});
