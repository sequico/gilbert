/**
 * Text every tier cleans the same way.
 *
 * A sender-supplied name has no honest use for direction overrides,
 * embeddings, isolates and marks: `Invoice_\u202Efdp.exe` would display as
 * "Invoice_exe.pdf". One definition both tiers read, so a filename a client
 * cleans and a header the server writes drop the same set — otherwise the same
 * name is safe in one place and not the other.
 */

/** Remove the characters that reorder text around them. */
export function withoutBidiControls(s: string): string {
  return s.replace(/[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, "");
}
