/**
 * The demo's outbound lists (ADR 0040): three campaigns being worked and one
 * closed, with the people and the companies a group already knows.
 *
 * The demo an installation shows is the mock, so the mock ships the product's own
 * features as data — and, like `knowledgeSeed.ts`, everything here is built from
 * the **shared** shapes and builders (`CampaignDoc`, `RowsDoc`, the knowledge
 * builders, the folder names) rather than from a literal the model could drift
 * away from. A field a campaign or a list gains appears here by construction.
 *
 * Each campaign is a list **and** a script: the script is a knowledge page of the
 * group's own, pinned at the revision it was issued at, which is what a caller
 * reads under Today. The people are the group's contact cards where a call has
 * already taught the group who they are, and bare rows with the words the paste
 * carried where it has not — both states are worth having on screen.
 *
 * **The demo is English.** Every name, company, role and number here is written
 * in the language the demo speaks: a demo that mixes a translated interface with
 * an Italian customer list reads as somebody's fixture, not as a product.
 *
 * The numbers are written in E.164, the one form a row holds, in the ranges the
 * United Kingdom and the United States keep for drama use, which libphonenumber
 * reads as valid and nobody can be called on.
 */

import { APP_DOCUMENT_TYPE } from "../shared/appFolder.js";
import {
  blocksFromText,
  buildDraft,
  buildRevision,
  buildState,
  DRAFT_FILE,
  KNOWLEDGE_FOLDER,
  knowledgeFolderName,
  plainTextFromBlocks,
  REVISIONS_FOLDER,
  revisionFileName,
  STATE_FILE,
} from "../shared/knowledge.js";
import type { CampaignDoc, CampaignOutcome, RowDoc } from "../shared/outbound.js";
import { CAMPAIGN_FOLDER, OUTBOUND_FOLDER, ROW_FOLDER } from "../shared/outbound.js";
import type { Obj } from "./types.js";

type PutBlob = (accountId: string, data: string | Buffer, type: string) => string;

export interface OutboundSeedInput {
  putBlob: PutBlob;
  /** The instant every seeded document is stamped with. */
  at: string;
  /** The group whose account holds the campaigns, in its own app folder. */
  group: string;
  /** That group's app folder node id. */
  groupAppFolder: string;
  /** The address book the created cards are filed in. */
  book: string;
  /** Who wrote them, as far as the documents say. */
  author: string;
}

export interface OutboundSeed {
  /** The FileNodes to add to the group's account. */
  nodes: Obj[];
  /** The contact cards the calls have already created. */
  cards: Obj[];
}

/** One person the group calls: who they are, where they work, how to reach them. */
interface Person {
  company: string;
  person: string;
  role: string;
  /** E.164, the only form a row holds. */
  e164: string;
  /** Whether the group's address book already carries them. */
  known: boolean;
}

/** The vocabulary every list of this demo shares. */
const OUTCOMES: CampaignOutcome[] = [
  { id: "spoke", label: "Spoke" },
  { id: "no-answer", label: "No answer" },
  { id: "busy", label: "Busy" },
  { id: "not-interested", label: "Not interested" },
  { id: "wrong-number", label: "Wrong number" },
];

/** A campaign as this file writes it: the list's purpose, its people, its script. */
interface List {
  key: string;
  purpose: string;
  scriptTitle: string;
  script: string;
  people: Person[];
}

const LISTS: List[] = [
  {
    key: "renewals",
    purpose: "2027 contract renewals",
    scriptTitle: "Renewal call",
    script: `Good morning, this is Gilbert — may I speak to the person who looks after
the contract?

I am calling about the renewal that comes up in January. I would like ten
minutes to go through what has changed in the last year: the volumes actually
used, the two services asked about in the spring, and whether the current terms
still fit.

If they are interested, book a call with the account manager for this week.
If they are not the right person, ask who owns the renewal and write the name
in the note — that is what the next call starts from.`,
    people: [
      {
        company: "Northwind Traders",
        person: "Mark Turner",
        role: "Owner",
        e164: "+442079460101",
        known: true,
      },
      {
        company: "Blue Harbour Logistics",
        person: "Helen Marsh",
        role: "Procurement manager",
        e164: "+442079460102",
        known: true,
      },
      {
        company: "Verdant Engineering",
        person: "Paul Green",
        role: "Technical director",
        e164: "+442079460103",
        known: true,
      },
      {
        company: "Paper Mills Ltd",
        person: "Sarah Coleman",
        role: "Purchasing",
        e164: "+442079460104",
        known: true,
      },
      {
        company: "Meridian Plant Hire",
        person: "Gary Whitfield",
        role: "Owner",
        e164: "+442079460105",
        known: true,
      },
      {
        company: "Hartley Brothers",
        person: "Luke Hartley",
        role: "Accounts",
        e164: "+442079460106",
        known: true,
      },
      {
        company: "St Mark's Glassworks",
        person: "Claire Barton",
        role: "Purchasing office",
        e164: "+442079460107",
        known: true,
      },
      {
        company: "Eastfield Packaging",
        person: "Andrew Fletcher",
        role: "Production manager",
        e164: "+442079460108",
        known: false,
      },
      {
        company: "Millbrook Grain",
        person: "Fiona Nash",
        role: "Purchasing",
        e164: "+442079460109",
        known: false,
      },
      {
        company: "Northern Steel",
        person: "Stephen Reid",
        role: "Commercial director",
        e164: "+442079460110",
        known: false,
      },
    ],
  },
  {
    key: "catalogue",
    purpose: "New catalogue — launch",
    scriptTitle: "Launch call",
    script: `Good morning, this is Gilbert.

We have just issued the new catalogue, and this company is one of the dealers we
would like to show it to first. Two things changed that matter: the range of
fittings is wider, and the lead time on the painted line is down to three weeks.

Offer to send the catalogue and the price list by mail, and ask which of the
two product lines they would put on the shelf first. A dealer who names a line
is a dealer worth calling again.`,
    people: [
      {
        company: "City Hardware",
        person: "Emma Collins",
        role: "Buyer",
        e164: "+441134960201",
        known: true,
      },
      {
        company: "Home & Garden Co.",
        person: "David Foster",
        role: "Owner",
        e164: "+441144960202",
        known: true,
      },
      {
        company: "Midland Tool Supply",
        person: "Susan Moore",
        role: "Manager",
        e164: "+441614960211",
        known: true,
      },
      {
        company: "The Wood Store",
        person: "George Hill",
        role: "Purchasing",
        e164: "+441164960204",
        known: true,
      },
      {
        company: "Northern Hand Tools",
        person: "Laura Bennett",
        role: "Owner",
        e164: "+441174960205",
        known: true,
      },
      {
        company: "Coast Paint Co.",
        person: "Matthew Brooks",
        role: "Buyer",
        e164: "+441184960206",
        known: true,
      },
      {
        company: "Aurora Windows",
        person: "Anna Delaney",
        role: "Technical office",
        e164: "+441214960207",
        known: true,
      },
      {
        company: "Southern Building Supplies",
        person: "Vincent Gray",
        role: "Owner",
        e164: "+441314960208",
        known: false,
      },
      {
        company: "Alpine Timber",
        person: "Elaine Cook",
        role: "Purchasing",
        e164: "+441414960209",
        known: false,
      },
      {
        company: "Safe Homes Ltd",
        person: "Robert Mason",
        role: "Director",
        e164: "+441514960210",
        known: false,
      },
    ],
  },
  {
    key: "suppliers",
    purpose: "Suppliers — quote requests",
    scriptTitle: "Quote call",
    script: `Good morning, this is Gilbert.

We are collecting quotes for the first quarter and we would like one from this
company. The volumes are the same as last year, with one change: we need the
delivery split in two, half in January and half in March.

Ask for a written quote by the end of the week, and for the name of whoever
signs it — a quote that arrives without a name is a quote nobody can chase.`,
    people: [
      {
        company: "Paper & Board Co.",
        person: "Julia Fielding",
        role: "Sales office",
        e164: "+441614960301",
        known: true,
      },
      {
        company: "Modern Plastics",
        person: "Alex Cooper",
        role: "Sales",
        e164: "+441914960302",
        known: true,
      },
      {
        company: "United Metals",
        person: "Frances Rudd",
        role: "Sales",
        e164: "+442890180303",
        known: true,
      },
      {
        company: "Swift Transport",
        person: "Nicholas Carr",
        role: "Logistics",
        e164: "+442920180304",
        known: true,
      },
      {
        company: "Harbour Chemicals",
        person: "Valerie Lambert",
        role: "Purchasing",
        e164: "+441312960305",
        known: true,
      },
      {
        company: "Electro Supply Ltd",
        person: "Simon Barrett",
        role: "Sales",
        e164: "+441414960306",
        known: true,
      },
      {
        company: "Industrial Sacks",
        person: "Martha Jordan",
        role: "Sales",
        e164: "+441514960307",
        known: true,
      },
      {
        company: "CNC Machining Ltd",
        person: "Frank Martin",
        role: "Owner",
        e164: "+441614960308",
        known: false,
      },
      {
        company: "Eco Paints",
        person: "Irene Foster",
        role: "Technical office",
        e164: "+441914960309",
        known: false,
      },
      {
        company: "Northern Auto Parts",
        person: "Carl Sutton",
        role: "Sales",
        e164: "+441134960310",
        known: false,
      },
    ],
  },
];

/**
 * The list that has already been worked: closed, with its rows settled and the
 * calls kept. It is what the tree's archive shows.
 */
const CLOSED: List = {
  key: "september-fair",
  purpose: "September fair — appointments",
  scriptTitle: "Fair follow-up",
  script: `Thank you for stopping at our stand.

We met at the September fair and you asked for the two brochures on the painted
line. This call books the visit: twenty minutes at your premises, with the
technical colleague who was at the stand.

If the visit is not wanted, ask whether the brochures arrived — that is the
answer the next list works from.`,
  people: [
    {
      company: "Aldebaran Group",
      person: "Robert Sallis",
      role: "Purchasing director",
      e164: "+441614960401",
      known: true,
    },
    {
      company: "Metalwork Ltd",
      person: "Joanna Pemberton",
      role: "Owner",
      e164: "+441614960402",
      known: true,
    },
    {
      company: "New Electric Co.",
      person: "Peter Sanders",
      role: "Technical office",
      e164: "+441614960403",
      known: true,
    },
    {
      company: "The Tool Shop",
      person: "Christine Vale",
      role: "Buyer",
      e164: "+441614960404",
      known: false,
    },
    {
      company: "Applied Technologies",
      person: "Mark Dawson",
      role: "Managing director",
      e164: "+441614960405",
      known: false,
    },
  ],
};

/** The demo's one node factory, the same shape every seeded FileNode has. */
function nodeFactory(putBlob: PutBlob, at: string) {
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
    json(
      id: string,
      parentId: string,
      name: string,
      doc: unknown,
      accountId: string,
    ): Obj {
      const data = JSON.stringify(doc);
      return {
        id,
        parentId,
        nodeType: "file",
        blobId: putBlob(accountId, data, APP_DOCUMENT_TYPE),
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

export function demoOutboundNodes(input: OutboundSeedInput): OutboundSeed {
  const { putBlob, at, group, groupAppFolder, book, author } = input;
  const node = nodeFactory(putBlob, at);
  const nodes: Obj[] = [];
  const cards: Obj[] = [];

  // The folders the documents live in, under the group's own app folder.
  nodes.push(node.dir("ob-root", groupAppFolder, OUTBOUND_FOLDER));
  nodes.push(node.dir("ob-campaigns", "ob-root", CAMPAIGN_FOLDER));
  nodes.push(node.dir("ob-rows", "ob-root", ROW_FOLDER));
  // The scripts are the group's own knowledge pages, where a reader finds them.
  nodes.push(node.dir("ob-know", groupAppFolder, KNOWLEDGE_FOLDER));

  let page = 0;
  const scriptPage = (list: List): string => {
    page += 1;
    const id = `ob-know-${list.key}`;
    const revision = "r1";
    const blocks = blocksFromText(list.script);
    const draft = buildDraft({
      id,
      title: list.scriptTitle,
      tags: ["outbound", "script"],
      blocks,
      text: plainTextFromBlocks(blocks),
      by: author,
      at,
      checklist: null,
    });
    const rev = buildRevision(draft, {
      revision,
      approvedBy: author,
      approvedAt: at,
      effectiveAt: at,
      rev: 1,
      supersedes: null,
    });
    const state = buildState({
      id,
      title: list.scriptTitle,
      tags: ["outbound", "script"],
      by: author,
      at,
      order: page * 10,
      inForce: {
        revision,
        rev: 1,
        effectiveAt: at,
        approvedBy: author,
        approvedAt: at,
        title: draft.title,
        tags: draft.tags,
      },
      template: null,
    });
    nodes.push(node.dir(id, "ob-know", knowledgeFolderName(list.scriptTitle)));
    nodes.push(node.dir(`${id}-revs`, id, REVISIONS_FOLDER));
    nodes.push(node.json(`${id}-draft`, id, DRAFT_FILE, draft, group));
    nodes.push(
      node.json(`${id}-r1`, `${id}-revs`, revisionFileName(revision), rev, group),
    );
    nodes.push(node.json(`${id}-state`, id, STATE_FILE, state, group));
    return id;
  };

  const campaignFor = (list: List, closed: boolean): CampaignDoc => {
    const id = `ob-camp-${list.key}`;
    const scriptId = scriptPage(list);
    return {
      version: 1,
      uid: id,
      purpose: list.purpose,
      script: { nodeId: scriptId, revision: "r1" },
      outcomes: OUTCOMES,
      window: { from: null, to: null },
      state: closed ? "closed" : "running",
      createdAt: at,
      createdBy: author,
    };
  };

  const cardOf = (list: List, person: Person, index: number): Obj => ({
    id: `ob-card-${list.key}-${index + 1}`,
    addressBookIds: { [book]: true },
    "@type": "Card",
    version: "1.0",
    uid: `uid-ob-card-${list.key}-${index + 1}`,
    kind: "individual",
    name: { full: person.person },
    organizations: { o1: { name: person.company } },
    titles: { t1: { "@type": "Title", name: person.role } },
    phones: { p1: { "@type": "Phone", number: person.e164 } },
    updated: at,
  });

  for (const list of LISTS) {
    const campaign = campaignFor(list, false);
    nodes.push(
      node.json(
        `ob-file-${list.key}`,
        "ob-campaigns",
        `${campaign.uid}.json`,
        campaign,
        group,
      ),
    );

    const rows: RowDoc[] = list.people.map((person, index) => {
      if (person.known) cards.push(cardOf(list, person, index));
      return {
        version: 1,
        uid: `ob-row-${list.key}-${index + 1}`,
        campaignUid: campaign.uid,
        e164: person.e164,
        extension: null,
        context: `${person.company}, ask for ${person.person.split(" ")[0]}`,
        cardUid: person.known ? `ob-card-${list.key}-${index + 1}` : null,
        state: "open",
        claim: null,
        nextCallAt: null,
        calls: [],
        trimmed: 0,
        createdAt: at,
      };
    });
    nodes.push(
      node.json(
        `ob-rows-${list.key}`,
        "ob-rows",
        `${campaign.uid}.json`,
        { version: 1, rows },
        group,
      ),
    );
  }

  // The closed list: settled rows, each with the call that settled it.
  const closed = campaignFor(CLOSED, true);
  nodes.push(
    node.json(
      `ob-file-${CLOSED.key}`,
      "ob-campaigns",
      `${closed.uid}.json`,
      closed,
      group,
    ),
  );
  const closedRows: RowDoc[] = CLOSED.people.map((person, index) => {
    if (person.known) cards.push(cardOf(CLOSED, person, index));
    const outcome =
      index % 3 === 0 ? "spoke" : index % 3 === 1 ? "no-answer" : "not-interested";
    return {
      version: 1,
      uid: `ob-row-${CLOSED.key}-${index + 1}`,
      campaignUid: closed.uid,
      e164: person.e164,
      extension: null,
      context: `${person.company}, ask for ${person.person.split(" ")[0]}`,
      cardUid: person.known ? `ob-card-${CLOSED.key}-${index + 1}` : null,
      state: "done",
      claim: null,
      nextCallAt: null,
      calls: [
        {
          at,
          by: author,
          outcome,
          note:
            index % 3 === 0
              ? "Visit booked for the 12th"
              : index % 3 === 1
                ? null
                : "Already supplied by another vendor",
          cardUid: person.known ? `ob-card-${CLOSED.key}-${index + 1}` : null,
        },
      ],
      trimmed: 0,
      createdAt: at,
    };
  });
  nodes.push(
    node.json(
      `ob-rows-${CLOSED.key}`,
      "ob-rows",
      `${closed.uid}.json`,
      { version: 1, rows: closedRows },
      group,
    ),
  );

  return { nodes, cards };
}
