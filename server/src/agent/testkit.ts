/**
 * The job call a former endpoint name is, for the tests that were written
 * against the forty-five endpoint tools (ADR 0038).
 *
 * Test support only: the product's catalogue is eight jobs, and a test that
 * says `mail.folders` means `find kind: folders`. Keeping the translation in
 * one place is what stops each test file inventing its own.
 */
export function jobCall(
  name: string,
  raw: unknown,
): { name: string; args: Record<string, unknown> } {
  const args = { ...((raw as Record<string, unknown> | undefined) ?? {}) };
  const read: Record<string, string> = {
    "mail.read": "message",
    "mail.readAttachment": "attachment",
    "files.read": "file",
    "calendar.read": "event",
    "knowledge.read": "knowledge",
    "chat.read": "chat",
    "workorder.read": "workorder",
    "run.read": "run",
  };
  if (read[name]) return { name: "read", args: { ...args, kind: read[name] } };
  const find: Record<string, string> = {
    "mail.find": "mail",
    "mail.folders": "folders",
    "files.list": "files",
    "calendar.list": "calendars",
    "calendar.find": "calendar",
    "chat.find": "chat",
    "contacts.find": "contacts",
    "knowledge.list": "pages",
    "knowledge.search": "knowledge",
    "workorder.list": "workorders",
  };
  if (find[name]) return { name: "find", args: { ...args, kind: find[name] } };
  const place: Record<string, string> = {
    "mail.file": "file",
    "mail.trash": "trash",
    "mail.untrash": "untrash",
    "mail.keyword": "keyword",
    "mail.label": "label",
    "mail.folder": "mailFolder",
    "mail.renameFolder": "renameFolder",
    "mail.deleteFolder": "deleteFolder",
    "files.save": "save",
    "files.write": "write",
    "files.overwrite": "overwrite",
    "files.move": "moveFile",
    "files.rename": "renameFile",
    "files.delete": "deleteFile",
    "files.folder": "folder",
  };
  if (place[name]) return { name: "place", args: { ...args, action: place[name] } };
  const event: Record<string, string> = {
    "calendar.create": "create",
    "calendar.update": "update",
    "calendar.delete": "delete",
  };
  if (event[name]) return { name: "event", args: { ...args, action: event[name] } };
  if (name === "mail.draft") return { name: "draft", args: { ...args, kind: "reply" } };
  if (name === "mail.editDraft")
    return { name: "draft", args: { ...args, kind: "edit" } };
  if (name === "chat.say") return { name: "say", args: { ...args, action: "say" } };
  if (name === "chat.ask") return { name: "say", args: { ...args, action: "ask" } };
  if (name === "memory.remember")
    return { name: "remember", args: { ...args, kind: "fact" } };
  if (name === "knowledge.propose")
    return { name: "remember", args: { ...args, kind: "page" } };
  if (name === "workorder.settle")
    return { name: "settle", args: { ...args, action: "settle" } };
  throw new Error(`the former tool "${name}" has no job`);
}

/** The surfaces the former endpoint names belonged to; another prefix is not one. */
const ENDPOINT_SURFACES = new Set([
  "mail",
  "files",
  "calendar",
  "chat",
  "contacts",
  "knowledge",
  "workorder",
  "run",
  "memory",
]);

/** Whether a name is a former endpoint's, rather than a fixture's own. */
export function isEndpointName(name: string): boolean {
  return name.includes(".") && ENDPOINT_SURFACES.has(name.split(".")[0] ?? "");
}
