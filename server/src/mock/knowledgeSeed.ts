/**
 * The demo data the mock Stalwart serves: an industrial manufacturer's company
 * knowledge base and its workorders (ADR 0024, 0028, 0030).
 *
 * The demo an installation shows is the mock, so the mock ships the product's
 * own features as data. Everything here is **derived from the shared builders**
 * — the same `buildDraft`/`buildState`/`buildRevision`/`buildChecklist`/
 * `buildWorkorderDoc` and the same `applicableStepPaths` a real write uses — so
 * the seed cannot drift from the model: a field, a state or a branching rule the
 * model gains appears here by construction rather than by a second definition.
 *
 * The company KB and the workorder registry are the **Master's** (the `gilbert`
 * app folder in its own account, the tier the server ensures at boot). A
 * template section assigned to a group also gets the group's **part** of that
 * workorder, filed under the group's own `gilbert` folder, so the demo shows the
 * two-tier split the routes serve.
 *
 * The port takes the mock's `putBlob` and the account ids rather than importing
 * the mock's internals, so this file stays a leaf and the mock owns its ids.
 */
import { APP_DOCUMENT_TYPE, APP_FOLDER_NAME } from "../shared/appFolder.js";
import {
  blocksFromText,
  buildDraft,
  buildRevision,
  buildState,
  DRAFT_FILE,
  KNOWLEDGE_FOLDER,
  type KnowledgeChecklist,
  type KnowledgeIssued,
  knowledgeFolderName,
  REVISIONS_FOLDER,
  revisionFileName,
  STATE_FILE,
} from "../shared/knowledge.js";
import {
  applicableStepPaths,
  buildChecklist,
  buildWorkorderDoc,
  WORKORDER_CLOSED_FOLDER,
  WORKORDER_FOLDER,
  type WorkorderChecklist,
  type WorkorderItem,
  type WorkorderState,
  type WorkorderStepState,
  type WorkorderTemplateRef,
  workorderFileName,
} from "../shared/workorder.js";
import type { Obj } from "./types.js";

type PutBlob = (data: string | Buffer, type: string) => string;

/** Everything the demo seed needs from the mock: its blob store and its ids. */
export interface DemoSeedInput {
  /** The mock's own blob store. */
  putBlob: PutBlob;
  /** The instant every seeded document is stamped with. */
  at: string;
  /** The Master's account: the company KB and the workorder registry. */
  master: string;
  /** The Master's address: the KB's approver and the documents' writer. */
  author: string;
  /** The demo user's address: who signed the seeded workorder steps. */
  worker: string;
  /** The group a template section is assigned to. */
  group: string;
  /** That group's own `gilbert` app folder, which the seeded part files under. */
  groupAppFolder: string;
}

/** The nodes to append to each account: the Master's, and the group's part. */
export interface DemoSeed {
  master: Obj[];
  group: Obj[];
}

/** The article folder name and id of one seeded article: `kb-<key>`. */
const idOf = (key: string): string => `kb-${key}`;

const HOUR_MS = 60 * 60 * 1000;

/** The demo's one node factory, so every seeded node has a mock FileNode's shape. */
function nodeFactory(putBlob: PutBlob, at: string) {
  // A fresh rights object per node: the mock's own fixtures use a factory for
  // the same reason, so mutating one node's rights can never touch another's.
  const rights = () => ({
    mayRead: true,
    mayAddChildren: true,
    mayRename: true,
    mayDelete: true,
    mayModifyContent: true,
    mayShare: true,
  });
  return {
    dir(id: string, parentId: string | null, name: string): Obj {
      return {
        id,
        parentId,
        nodeType: "directory",
        blobId: null,
        size: null,
        name,
        type: null,
        created: at,
        modified: at,
        myRights: rights(),
        shareWith: {},
      };
    },
    json(id: string, parentId: string, name: string, doc: unknown): Obj {
      const data = JSON.stringify(doc);
      return {
        id,
        parentId,
        nodeType: "file",
        blobId: putBlob(data, APP_DOCUMENT_TYPE),
        size: Buffer.byteLength(data),
        name,
        type: APP_DOCUMENT_TYPE,
        created: at,
        modified: at,
        myRights: rights(),
        shareWith: {},
      };
    },
  };
}

/**
 * The shipping process (ADR 0030): one variant, a step conditioned on it, a
 * repeated section with a data field, and a section assigned to a group — every
 * feature the model carries, in one template.
 */
function shippingProcess(group: string): KnowledgeChecklist {
  return {
    variants: [
      {
        key: "line",
        label: "Shipping line",
        values: [
          { value: "maersk", label: "Maersk" },
          { value: "hapag", label: "Hapag-Lloyd" },
        ],
      },
    ],
    sections: [
      {
        key: "booking",
        label: "Booking",
        steps: [
          { key: "confirm", label: "Confirm the booking" },
          {
            key: "reference",
            label: "Record the Maersk booking reference",
            condition: { variant: "line", equals: "maersk" },
          },
        ],
      },
      {
        key: "loading",
        label: "Loading",
        repeat: { item: "Container", fields: [{ key: "seal", label: "Seal" }] },
        steps: [
          { key: "load", label: "Load the container" },
          { key: "seal", label: "Seal the container" },
          {
            // A condition **inside** a repeated section (ADR 0030's cross-scope
            // rule): the label applies per container, and only for one line.
            key: "label",
            label: "Apply the Maersk container label",
            condition: { variant: "line", equals: "maersk" },
          },
        ],
      },
      {
        key: "customs",
        label: "Customs",
        group,
        steps: [{ key: "declare", label: "File the customs declaration" }],
      },
      {
        key: "final",
        label: "Finalization",
        steps: [{ key: "handover", label: "Hand over the documents" }],
      },
    ],
  };
}

/** A periodic maintenance process: a section that only the monthly run carries. */
function maintenanceProcess(): KnowledgeChecklist {
  return {
    variants: [
      {
        key: "interval",
        label: "Interval",
        values: [
          { value: "weekly", label: "Weekly" },
          { value: "monthly", label: "Monthly" },
        ],
      },
    ],
    sections: [
      {
        key: "visual",
        label: "Visual check",
        steps: [
          { key: "leaks", label: "Check for oil and air leaks" },
          { key: "guards", label: "Check the guards" },
        ],
      },
      {
        key: "lubrication",
        label: "Lubrication",
        condition: { variant: "interval", equals: "monthly" },
        steps: [{ key: "grease", label: "Grease the guides" }],
      },
      {
        key: "signoff",
        label: "Sign-off",
        steps: [{ key: "sign", label: "Sign the maintenance log" }],
      },
    ],
  };
}

/** Build the demo's FileNodes, one list per account. */
export function demoSeedNodes(input: DemoSeedInput): DemoSeed {
  const { putBlob, at, master, author, worker, group, groupAppFolder } = input;
  const { dir, json } = nodeFactory(putBlob, at);
  const masterNodes: Obj[] = [
    dir("kb-app", null, APP_FOLDER_NAME),
    dir("kb-know", "kb-app", KNOWLEDGE_FOLDER),
  ];
  const groupNodes: Obj[] = [];

  // Articles are spaced by 10 so a demo drag can land between two of them.
  let order = 10;
  /**
   * One article, issued in force as revision 1. An ordinary page passes `body`;
   * a template passes `checklist`, and `buildDraft` derives its body from the
   * rules, so its blocks and text are never a second thing to keep in step.
   */
  const article = (opts: {
    key: string;
    title: string;
    tags: string[];
    body?: string;
    checklist?: KnowledgeChecklist;
  }): void => {
    const id = idOf(opts.key);
    const revision = "r1";
    const draft = buildDraft({
      id,
      title: opts.title,
      tags: opts.tags,
      blocks: blocksFromText(opts.body ?? ""),
      text: opts.body ?? "",
      checklist: opts.checklist ?? null,
      by: author,
      at,
    });
    const issued: KnowledgeIssued = {
      revision,
      rev: 1,
      effectiveAt: at,
      approvedBy: author,
      approvedAt: at,
      // Taken from the draft, so the issued summary carries exactly the
      // normalised title and tags the revision does.
      title: draft.title,
      tags: draft.tags,
    };
    const rev = buildRevision(draft, {
      revision,
      rev: 1,
      approvedBy: author,
      approvedAt: at,
      effectiveAt: at,
      supersedes: null,
    });
    const state = buildState({
      id,
      title: opts.title,
      tags: opts.tags,
      by: author,
      at,
      order,
      inForce: issued,
      template: opts.checklist ? "checklist" : null,
    });
    order += 10;
    // The folder is the title's own file name (`knowledgeFolderName`), the same
    // rule a create uses, so the tree reads the article where the app would put it.
    masterNodes.push(dir(id, "kb-know", knowledgeFolderName(opts.title)));
    masterNodes.push(dir(`${id}-revs`, id, REVISIONS_FOLDER));
    masterNodes.push(json(`${id}-draft`, id, DRAFT_FILE, draft));
    masterNodes.push(json(`${id}-r1`, `${id}-revs`, revisionFileName(revision), rev));
    masterNodes.push(json(`${id}-state`, id, STATE_FILE, state));
  };

  const shipping = shippingProcess(group);
  const maintenance = maintenanceProcess();

  article({
    key: "production-plan",
    title: "Production planning",
    tags: ["production"],
    body: "The weekly production plan is issued every Friday. Review capacity before accepting a new order.",
  });
  article({
    key: "quality-control",
    title: "Quality control",
    tags: ["quality"],
    body: "Inspect every batch against the drawing. Record the measurement, the inspector and the result.",
  });
  article({
    key: "warehouse",
    title: "Warehouse and inventory",
    tags: ["warehouse"],
    body: "Goods received are checked against the delivery note and booked into stock the same day. Stock is counted quarterly.",
  });
  article({
    key: "health-safety",
    title: "Health and safety",
    tags: ["hse"],
    body: "Every operator wears the required PPE on the shop floor, and an incident is reported the same shift.",
  });
  article({
    key: "purchasing",
    title: "Purchasing",
    tags: ["purchasing"],
    body: "A purchase needs a request, a quote and an approval before the order is placed.",
  });
  article({
    key: "shipping-documents",
    title: "Shipping documents",
    tags: ["shipping"],
    body: "The bill of lading, the packing list and the certificate of origin travel with the container.",
  });
  article({
    key: "non-conformance",
    title: "Non-conformance report",
    tags: ["quality"],
    body: "A failed inspection opens a non-conformance: describe it, contain it, find the cause, close it.",
  });
  article({
    key: "machine-setup",
    title: "Machine setup",
    tags: ["production"],
    body: "Set the tooling and the offsets from the drawing, then run a first-off and have it inspected.",
  });
  article({
    key: "container-shipment",
    title: "Container shipment checklist",
    tags: ["shipping", "template"],
    checklist: shipping,
  });
  article({
    key: "maintenance-checklist",
    title: "Machine maintenance checklist",
    tags: ["maintenance", "template"],
    checklist: maintenance,
  });

  // The workorder registry: active roots under `workorders/`, closed ones under
  // `workorders/closed/` (ADR 0028).
  masterNodes.push(dir("kb-wo", "kb-app", WORKORDER_FOLDER));
  masterNodes.push(dir("kb-wo-closed", "kb-wo", WORKORDER_CLOSED_FOLDER));

  const containerTemplate: WorkorderTemplateRef = {
    accountId: master,
    id: idOf("container-shipment"),
    revision: "r1",
  };
  const maintenanceTemplate: WorkorderTemplateRef = {
    accountId: master,
    id: idOf("maintenance-checklist"),
    revision: "r1",
  };

  const containerItems: Record<string, WorkorderItem[]> = {
    loading: [
      { key: "CONT-1", data: { seal: "S-4417" } },
      { key: "CONT-2", data: { seal: "S-4418" } },
    ],
  };
  const containerVariants = { line: "maersk" };

  /** Stamp the preset states onto a freshly built checklist's steps. */
  const stamped = (
    built: WorkorderChecklist,
    marks: Record<string, { state: WorkorderStepState; note?: string }>,
    stampAt: string,
  ): WorkorderChecklist => ({
    ...built,
    steps: built.steps.map((step) => {
      const mark = marks[step.path];
      return mark
        ? { ...step, state: mark.state, by: worker, at: stampAt, note: mark.note ?? "" }
        : step;
    }),
  });

  /** One Master-root workorder, filed under `workorders/` or `workorders/closed/`. */
  const workorder = (opts: {
    uid: string;
    name: string;
    state: WorkorderState;
    template: WorkorderTemplateRef;
    def: KnowledgeChecklist;
    variants: Record<string, string>;
    items: Record<string, WorkorderItem[]>;
    marks: Record<string, { state: WorkorderStepState; note?: string }>;
    parentId: string;
    at: string;
  }): void => {
    const stepPaths = applicableStepPaths(opts.def, opts.variants, opts.items, null);
    const built = buildChecklist({
      template: opts.template,
      variants: opts.variants,
      items: opts.items,
      stepPaths,
    });
    const doc = buildWorkorderDoc({
      uid: opts.uid,
      name: opts.name,
      state: opts.state,
      checklist: stamped(built, opts.marks, opts.at),
      by: author,
      at: opts.at,
    });
    masterNodes.push(
      json(`kb-wo-${opts.uid}`, opts.parentId, workorderFileName(opts.uid), doc),
    );
  };

  const atHour = (hours: number): string =>
    new Date(Date.parse(at) - hours * HOUR_MS).toISOString();

  // Running, part shipped: some steps done, one skipped and one not applicable.
  workorder({
    uid: "container-northwind",
    name: "Container shipment — Northwind order",
    state: "running",
    template: containerTemplate,
    def: shipping,
    variants: containerVariants,
    items: containerItems,
    marks: {
      "booking.confirm": { state: "done" },
      "booking.reference": { state: "skipped", note: "Booked through the forwarder." },
      "loading[CONT-1].load": { state: "done" },
      "loading[CONT-1].seal": { state: "done" },
      "loading[CONT-1].label": { state: "done" },
      "loading[CONT-2].load": { state: "done" },
      "loading[CONT-2].seal": {
        state: "not-applicable",
        note: "Sealed at the yard before pickup.",
      },
    },
    parentId: "kb-wo",
    at,
  });

  // Running maintenance: the weekly run does not carry the monthly step.
  workorder({
    uid: "maintenance-line2",
    name: "Machine maintenance — Line 2",
    state: "running",
    template: maintenanceTemplate,
    def: maintenance,
    variants: { interval: "weekly" },
    items: {},
    marks: {
      "visual.leaks": { state: "done" },
      "visual.guards": { state: "skipped", note: "Guards replaced last month." },
    },
    parentId: "kb-wo",
    at: atHour(1),
  });

  // Closed maintenance: the monthly run, every step done, kept under `closed/`.
  workorder({
    uid: "maintenance-line1",
    name: "Machine maintenance — Line 1",
    state: "completed",
    template: maintenanceTemplate,
    def: maintenance,
    variants: { interval: "monthly" },
    items: {},
    marks: {
      "visual.leaks": { state: "done" },
      "visual.guards": { state: "done" },
      "lubrication.grease": { state: "done" },
      "signoff.sign": { state: "done" },
    },
    parentId: "kb-wo-closed",
    at: atHour(2),
  });

  // The group's part of the container workorder: only the section the template
  // assigns to that group, filed in the group's own `gilbert` folder. The route
  // joins it to the root when it serves the workorder.
  const partPaths = applicableStepPaths(
    shipping,
    containerVariants,
    containerItems,
    group,
  );
  const partBuilt = buildChecklist({
    template: containerTemplate,
    variants: containerVariants,
    items: containerItems,
    stepPaths: partPaths,
  });
  const partDoc = buildWorkorderDoc({
    uid: "container-northwind",
    checklist: stamped(partBuilt, { "customs.declare": { state: "done" } }, at),
    by: author,
    at,
  });
  groupNodes.push(dir("kb-g-wo", groupAppFolder, WORKORDER_FOLDER));
  groupNodes.push(
    json("kb-g-wo-part", "kb-g-wo", workorderFileName("container-northwind"), partDoc),
  );

  return { master: masterNodes, group: groupNodes };
}
