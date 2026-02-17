import { z } from "zod";

export const DagDependencyModeSchema = z.enum(["sequential", "parallel", "staged"]);

export const DagModuleSchema = z.object({
  id: z.string().trim().min(1),
  title: z.string().trim().min(1),
  description: z.string().trim().min(1),
  partPath: z.string().trim().min(1),
  mode: z.enum(["analyze", "implement"]).default("implement"),
  level: z.number().int().nonnegative(),
  dependsOn: z.array(z.string().trim().min(1)).default([]),
  command: z.string().trim().min(1).optional(),
});

export const DagManifestSchema = z.object({
  schemaVersion: z.literal("1.0"),
  name: z.string().trim().min(1),
  description: z.string().trim().min(1),
  requestPath: z.string().trim().min(1),
  generatedAt: z.string().trim().min(1),
  dependencyMode: DagDependencyModeSchema,
  modules: z.array(DagModuleSchema).min(1),
});

export const DagRunResultSchema = z.object({
  moduleId: z.string(),
  status: z.enum(["success", "failed", "blocked", "skipped"]),
  command: z.string().nullable(),
  code: z.number().int().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  durationMs: z.number().int().nonnegative(),
});

export const DagRunSummarySchema = z.object({
  manifestPath: z.string(),
  startedAt: z.string(),
  completedAt: z.string(),
  status: z.enum(["success", "partial_failure", "failure"]),
  results: z.array(DagRunResultSchema),
});

export type DagDependencyMode = z.infer<typeof DagDependencyModeSchema>;
export type DagModule = z.infer<typeof DagModuleSchema>;
export type DagManifest = z.infer<typeof DagManifestSchema>;
export type DagRunResult = z.infer<typeof DagRunResultSchema>;
export type DagRunSummary = z.infer<typeof DagRunSummarySchema>;

export type SplitPart = {
  content: string;
  title?: string;
  startLine?: number;
  endLine?: number;
};
