/**
 * Stalwart 1.0's FileNode wire shape, and the one this tree speaks (ADR 0038).
 *
 * Stalwart 1.0 renamed the object's kind from `nodeType` (values `file`,
 * `directory`, `symlink`) to `@type` (values `File`, `Directory`, `SymLink`), and
 * the MIME property from `type` to `mediaType`. The **query filter** kept the
 * key `nodeType` but takes the new values, and its sort comparator is
 * `mediaType`. Verified against the v1.0.0 source
 * (`crates/jmap-proto/src/object/file_node.rs`,
 * `crates/jmap/src/file/{get,query}.rs`).
 *
 * The tree's own vocabulary stays `nodeType`/`type` in lower case, because that
 * is what every surface, document and test names; this module is the one
 * boundary that translates it. Both JMAP clients apply it to every request and
 * response (`server/src/jmap.ts`, `web/src/jmap/client.ts`), so no caller
 * carries a second spelling of a FileNode apart from this file.
 *
 * ADR-0011 OWED: native-filenode-wire — the native form is the wire's names
 * throughout, this file deleted, and that port touches every store, view and
 * document that names a node today.
 */

import { isRecord } from "./json.js";

/** The object property that names a node's kind on a 1.0 server. */
export const FILE_NODE_TYPE_PROP = "@type";

/** The kinds a 1.0 server names, and the lower-case word this tree uses. */
const WIRE_KIND: Readonly<Record<string, string>> = {
  file: "File",
  directory: "Directory",
  symlink: "SymLink",
};

const LOCAL_KIND: Readonly<Record<string, string>> = {
  File: "file",
  Directory: "directory",
  SymLink: "symlink",
};

/** The wire spelling of a kind this tree names, or the value unchanged. */
export function fileNodeWireKind(value: unknown): unknown {
  return typeof value === "string" ? (WIRE_KIND[value.toLowerCase()] ?? value) : value;
}

/** The lower-case kind of a wire value, or undefined when it is not one. */
export function fileNodeLocalKind(value: unknown): string | undefined {
  return typeof value === "string" ? LOCAL_KIND[value] : undefined;
}

/** Whether a method name is one this boundary translates. */
function isFileNodeMethod(name: string): boolean {
  return name.startsWith("FileNode/");
}

/** A property list as the wire names it: `nodeType` → `@type`, `type` → `mediaType`. */
function wireProperties(properties: unknown): unknown {
  if (!Array.isArray(properties)) return properties;
  return properties.map((one) =>
    one === "nodeType" ? FILE_NODE_TYPE_PROP : one === "type" ? "mediaType" : one,
  );
}

/** A node as the wire names its kind and its MIME. */
function wireNode(node: unknown): unknown {
  if (!isRecord(node)) return node;
  const out: Record<string, unknown> = { ...node };
  if ("nodeType" in out) {
    out[FILE_NODE_TYPE_PROP] = fileNodeWireKind(out.nodeType);
    delete out.nodeType;
  }
  if ("type" in out) {
    out.mediaType = out.type;
    delete out.type;
  }
  return out;
}

/** A query filter as 1.0 reads it: `nodeType` keeps its key, with the new values. */
function wireFilter(filter: unknown): unknown {
  if (Array.isArray(filter)) return filter.map(wireFilter);
  if (!isRecord(filter)) return filter;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(filter)) {
    if (key === "nodeType") out.nodeType = fileNodeWireKind(value);
    else if (key === "type") out.mediaType = value;
    else if (key === "typeMatch") out.mediaTypeMatch = value;
    else if (key === "conditions") out.conditions = wireFilter(value);
    else if (key === "filter" || key === "not") out[key] = wireFilter(value);
    else out[key] = value;
  }
  return out;
}

/** One request's arguments, translated when the method is a FileNode one. */
export function fileNodeRequestArguments(
  method: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (!isFileNodeMethod(method)) return args;
  const out: Record<string, unknown> = { ...args };
  if ("properties" in out) out.properties = wireProperties(out.properties);
  if ("filter" in out) out.filter = wireFilter(out.filter);
  if (Array.isArray(out.sort))
    out.sort = out.sort.map((one) =>
      isRecord(one) && one.property === "type" ? { ...one, property: "mediaType" } : one,
    );
  if (isRecord(out.create)) out.create = mapNodes(out.create as Record<string, unknown>);
  if (isRecord(out.update)) out.update = mapNodes(out.update as Record<string, unknown>);
  return out;
}

/** A create/update map whose values are FileNode objects. */
function mapNodes(nodes: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [id, node] of Object.entries(nodes)) out[id] = wireNode(node);
  return out;
}

/** A node as this tree names it: the kind in lower case, the MIME in `type`. */
function localNode(node: unknown): unknown {
  if (!isRecord(node)) return node;
  const out: Record<string, unknown> = { ...node };
  if (FILE_NODE_TYPE_PROP in out) {
    out.nodeType = fileNodeLocalKind(out[FILE_NODE_TYPE_PROP]);
    delete out[FILE_NODE_TYPE_PROP];
  }
  if ("mediaType" in out) {
    out.type = out.mediaType;
    delete out.mediaType;
  }
  return out;
}

/** One response's arguments, translated back when the method is a FileNode one. */
export function fileNodeResponseArguments(
  method: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (!isFileNodeMethod(method)) return args;
  const out: Record<string, unknown> = { ...args };
  if (Array.isArray(out.list)) out.list = out.list.map(localNode);
  if (isRecord(out.created)) out.created = mapResponses(out.created);
  if (isRecord(out.updated)) out.updated = mapResponses(out.updated);
  return out;
}

/** A set's `created`/`updated` map, whose values are the objects the server wrote. */
function mapResponses(nodes: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [id, node] of Object.entries(nodes)) out[id] = localNode(node);
  return out;
}
