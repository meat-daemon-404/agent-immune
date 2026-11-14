/** Write tools whose invocations between a failure and a retry are the repair path. */
export const REPAIR_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

const LOWER_REPAIR_TOOLS = new Set(['write', 'edit', 'multiedit', 'notebookedit']);

/** Case-insensitive check so lowercase hosts (e.g. DSH `edit`/`write`) match too. */
export function isRepairTool(toolName: string): boolean {
  return REPAIR_TOOLS.has(toolName) || LOWER_REPAIR_TOOLS.has(toolName.toLowerCase());
}
