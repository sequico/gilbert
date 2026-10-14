import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type FileNodeLike, nodeStamp } from "./appFolder.js";

/**
 * The stamp a registry page is cut on.
 *
 * `modified` falling back to `created` was written twice — once in the workorder
 * admin and once in the knowledge admin, with a different guard around the same
 * pair — and the two surfaces sort their newest-first page by it, so a node the
 * server answered with `modified` present but not a string was a page the two
 * would have ordered differently. This pins the one answer.
 */
describe("nodeStamp", () => {
  it("is the last write", () => {
    assert.equal(nodeStamp({ modified: "2026-10-14T10:00:00Z" }), "2026-10-14T10:00:00Z");
  });

  it("falls back to creation when there is no last write", () => {
    // A revision rescheduled in place keeps its creation stamp while its
    // approval moves; paging on creation alone would drop it out of the page the
    // reader is looking at.
    assert.equal(nodeStamp({ created: "2026-01-02T03:04:05Z" }), "2026-01-02T03:04:05Z");
  });

  it("prefers the last write even when creation is the older of the two", () => {
    const node: FileNodeLike = {
      created: "2026-01-02T03:04:05Z",
      modified: "2026-10-14T10:00:00Z",
    };
    assert.equal(nodeStamp(node), "2026-10-14T10:00:00Z");
  });

  it("falls back when the stamp is present but is not a string", () => {
    // The guard is a type check, not a null check: a server that answered a
    // number here must not have the page ordered by it.
    assert.equal(
      nodeStamp({ modified: 1757844000, created: "2026-01-02T03:04:05Z" }),
      "2026-01-02T03:04:05Z",
    );
    assert.equal(
      nodeStamp({ modified: null, created: "2026-01-02T03:04:05Z" }),
      "2026-01-02T03:04:05Z",
    );
  });

  it("is the empty string for a node the server has not stamped", () => {
    // It sorts last rather than throwing the page away.
    assert.equal(nodeStamp({}), "");
    assert.equal(nodeStamp({ name: "file.json" }), "");
  });
});
