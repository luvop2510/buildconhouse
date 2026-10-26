/** Current Kitchen pages. Stable workspace authority survives page additions/renames. */
export const KITCHEN_WORKSPACE_RESOURCE = "kitchen_projects";
export const KITCHEN_WORKSPACE_PAGES = [
  { stage: "lead", label: "Lead", icon: "user-plus" },
  { stage: "visit", label: "Visit", icon: "map-pin" },
  { stage: "cad", label: "CAD File", icon: "file" },
  { stage: "design", label: "Design", icon: "edit-3" },
  { stage: "quotation", label: "Quotation", icon: "file-text" },
  { stage: "order", label: "Order", icon: "check-square" },
  { stage: "production", label: "Production", icon: "tool" },
  { stage: "installation", label: "Installation", icon: "home" },
  { stage: "completed", label: "Completed", icon: "check-circle" },
] as const;
export const KITCHEN_WORKSPACE_LANDING = `/(admin)/kitchen/stages/${KITCHEN_WORKSPACE_PAGES[0].stage}`;
