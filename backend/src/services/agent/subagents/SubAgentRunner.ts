/**
 * Coordinates writer + inspector sub-agents.
 * Reflection (memory) runs in parallel with inspection after each chapter draft.
 */
export interface ParallelChapterPostProcessResult<TInspect> {
  reflection: void;
  inspection: TInspect;
}

export async function runReflectionAndInspectionParallel<TInspect>(
  reflection: () => Promise<void>,
  inspection: () => Promise<TInspect>,
): Promise<ParallelChapterPostProcessResult<TInspect>> {
  const [_, inspectionResult] = await Promise.all([reflection(), inspection()]);
  return { reflection: undefined, inspection: inspectionResult };
}