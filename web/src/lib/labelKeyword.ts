/**
 * The keyword a new label gets from its display name. The keyword is the
 * stable identity that rides on the message; the name is display only, so
 * renaming a label later never touches this.
 */
export function labelKeywordFromName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug || `label${Date.now()}`;
}
