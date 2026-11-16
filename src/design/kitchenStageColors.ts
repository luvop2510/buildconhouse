import type { KitchenStage } from '@/src/api/kitchenProjects';

/** Stable stage identity, independent of result order or the current counts.
 * These colours identify chart marks; readable labels retain the text palette.
 */
export const KITCHEN_STAGE_COLORS: Readonly<Record<KitchenStage, string>> = {
  lead: '#64748B',
  visit: '#F59E0B',
  cad: '#DB2777',
  design: '#8B5CF6',
  quotation: '#06B6D4',
  order: '#2563EB',
  production: '#F97316',
  installation: '#14B8A6',
  completed: '#22C55E',
};

const labels: Record<KitchenStage, string> = {
  lead: 'Lead', visit: 'Visit', cad: 'CAD File', design: 'Design', quotation: 'Quotation',
  order: 'Order', production: 'Production', installation: 'Installation', completed: 'Completed',
};

function stageKey(stage: string): KitchenStage | undefined {
  const key = stage.trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (key === 'cadfile') return 'cad';
  return Object.hasOwn(KITCHEN_STAGE_COLORS, key) ? key as KitchenStage : undefined;
}

export function kitchenStageColor(stage: string): string | undefined {
  const key = stageKey(stage);
  return key ? KITCHEN_STAGE_COLORS[key] : undefined;
}

export function kitchenStageLabel(stage: string): string {
  const key = stageKey(stage);
  return key ? labels[key] : stage;
}
