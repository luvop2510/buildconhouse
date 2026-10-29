/** Server-projected work data: departmental responses never carry money or workflow aggregates. */
export type TodayTask = {
  id: string; resource: string; title: string; status: string; due_at: string | null;
  updated_at: string | null; assignee_name: string | null; href: string; progress: number | null;
};
export type TodayData = {
  floor_id: string; floor_name: string; generated_at: string; full_floor_access: boolean; resources: string[];
  task_summary: { open: number; overdue: number; due_today: number; completed_today: number };
  tasks: TodayTask[];
  workflows: { resource: string; label: string; total: number; statuses: { status: string; count: number }[] }[];
  payments: { currency: 'INR'; received_today: number; receipt_count: number } | null;
  truncated: boolean;
  unavailable_sections?: string[];
};

export type TodayOverview = Pick<TodayData, 'floor_id' | 'workflows' | 'payments' | 'unavailable_sections'>;
