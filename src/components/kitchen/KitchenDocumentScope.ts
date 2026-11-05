import type { KitchenProject } from "@/src/api/kitchenProjects";

/** Installation documents remain available without exposing files from other stages. */
export function visibleKitchenDocuments(project: KitchenProject) {
  if (!project.permissions?.restricted) return project.attachments || [];
  return project.stage === "installation" ? (project.attachments || []).filter(file => file.stage === "installation") : [];
}
