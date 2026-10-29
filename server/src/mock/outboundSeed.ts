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
 * The numbers are written in E.164, the one form a row holds, and every one of
 * them is an Italian mobile or landline that libphonenumber reads as valid.
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
import {
  CAMPAIGN_FOLDER,
  OUTBOUND_FOLDER,
  ROW_FOLDER,
} from "../shared/outbound.js";
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

/** The vocabulary every list of this demo shares, with two outcomes of its own. */
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
    purpose: "Rinnovi contratti 2027",
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
        company: "Rossi Impianti Srl",
        person: "Marco Rossi",
        role: "Titolare",
        e164: "+393332145567",
        known: true,
      },
      {
        company: "Bianchi Logistica Spa",
        person: "Elena Bianchi",
        role: "Responsabile acquisti",
        e164: "+393478821190",
        known: true,
      },
      {
        company: "Officine Verdì",
        person: "Paolo Verdì",
        role: "Direttore tecnico",
        e164: "+393204476621",
        known: true,
      },
      {
        company: "Cartaria del Nord",
        person: "Sara Colombo",
        role: "Acquisti",
        e164: "+393357719082",
        known: true,
      },
      {
        company: "Tecnoimpianti Meridionali",
        person: "Gennaro Esposito",
        role: "Titolare",
        e164: "+393485523318",
        known: true,
      },
      {
        company: "F.lli Marchetti",
        person: "Luca Marchetti",
        role: "Amministrazione",
        e164: "+393406607745",
        known: true,
      },
      {
        company: "Vetreria San Marco",
        person: "Chiara Basso",
        role: "Ufficio acquisti",
        e164: "+393339182264",
        known: true,
      },
      {
        company: "Imballaggi Toscana",
        person: "Andrea Fabbri",
        role: "Responsabile produzione",
        e164: "+393472204498",
        known: false,
      },
      {
        company: "Molino Adriatico",
        person: "Federica Neri",
        role: "Acquisti",
        e164: "+393209135570",
        known: false,
      },
      {
        company: "Acciai Veneti",
        person: "Stefano Rizzo",
        role: "Direttore commerciale",
        e164: "+393354028861",
        known: false,
      },
    ],
  },
  {
    key: "catalogue",
    purpose: "Nuovo catalogo — lancio",
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
        company: "Bricolage Centro",
        person: "Martina Galli",
        role: "Buyer",
        e164: "+393401187732",
        known: true,
      },
      {
        company: "Casa & Giardino",
        person: "Davide Fontana",
        role: "Titolare",
        e164: "+393335592210",
        known: true,
      },
      {
        company: "Ferramenta Lombarda",
        person: "Silvia Moretti",
        role: "Responsabile",
        e164: "+393473306678",
        known: true,
      },
      {
        company: "Emporio del Legno",
        person: "Giorgio Villa",
        role: "Acquisti",
        e164: "+393207714409",
        known: true,
      },
      {
        company: "Utensileria Padana",
        person: "Laura Serra",
        role: "Titolare",
        e164: "+393356601123",
        known: true,
      },
      {
        company: "Colorificio Ligure",
        person: "Matteo Bruno",
        role: "Buyer",
        e164: "+393402238890",
        known: true,
      },
      {
        company: "Serramenti Aurora",
        person: "Anna De Luca",
        role: "Ufficio tecnico",
        e164: "+393487715534",
        known: true,
      },
      {
        company: "Edilizia Sud",
        person: "Vincenzo Greco",
        role: "Titolare",
        e164: "+393334409987",
        known: false,
      },
      {
        company: "Legnami Alpini",
        person: "Elisa Conti",
        role: "Acquisti",
        e164: "+393471182245",
        known: false,
      },
      {
        company: "Casa Sicura Srl",
        person: "Roberto Mancini",
        role: "Direttore",
        e164: "+393205527713",
        known: false,
      },
    ],
  },
  {
    key: "suppliers",
    purpose: "Fornitori — richiesta preventivi",
    scriptTitle: "Quote call",
    script: `Good morning, this is Gilbert.

We are collecting quotes for the first quarter and we would like one from this
company. The volumes are the same as last year, with one change: we need the
delivery split in two, half in January and half in March.

Ask for a written quote by the end of the week, and for the name of whoever
signs it — a quote that arrives without a name is a quote nobody can chase.`,
    people: [
      {
        company: "Carta & Cartone Spa",
        person: "Giulia Ferri",
        role: "Ufficio commerciale",
        e164: "+393357741120",
        known: true,
      },
      {
        company: "Plastica Moderna",
        person: "Alessandro Costa",
        role: "Vendite",
        e164: "+393408893312",
        known: true,
      },
      {
        company: "Metalli Uniti",
        person: "Francesca Rinaldi",
        role: "Commerciale",
        e164: "+393336624478",
        known: true,
      },
      {
        company: "Trasporti Veloci",
        person: "Nicola Caruso",
        role: "Logistica",
        e164: "+393475512231",
        known: true,
      },
      {
        company: "Chimica del Porto",
        person: "Valeria Lombardi",
        role: "Acquisti",
        e164: "+393483309964",
        known: true,
      },
      {
        company: "Elettroforniture Spa",
        person: "Simone Barbieri",
        role: "Vendite",
        e164: "+393204477712",
        known: true,
      },
      {
        company: "Sacchi Industriali",
        person: "Marta Giordano",
        role: "Commerciale",
        e164: "+393352215589",
        known: true,
      },
      {
        company: "Lavorazioni CNC",
        person: "Fabio Martini",
        role: "Titolare",
        e164: "+393407743361",
        known: false,
      },
      {
        company: "Vernici Ecologiche",
        person: "Ilaria Fontana",
        role: "Ufficio tecnico",
        e164: "+393331186623",
        known: false,
      },
      {
        company: "Ricambi Auto Nord",
        person: "Carlo Serra",
        role: "Vendite",
        e164: "+393476621189",
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
  purpose: "Fiera di settembre — appuntamenti",
  scriptTitle: "Fair follow-up",
  script: `Thank you for stopping at our stand.

We met at the September fair and you asked for the two brochures on the painted
line. This call books the visit: twenty minutes at your premises, with the
technical colleague who was at the stand.

If the visit is not wanted, ask whether the brochures arrived — that is the
answer the next list works from.`,
  people: [
    {
      company: "Gruppo Aldebaran",
      person: "Roberto Salvi",
      role: "Direttore acquisti",
      e164: "+393337741120",
      known: true,
    },
    {
      company: "Metalwork Srl",
      person: "Giovanna Pellegrini",
      role: "Titolare",
      e164: "+393471129983",
      known: true,
    },
    {
      company: "Nuova Elettrica",
      person: "Pietro Sanna",
      role: "Ufficio tecnico",
      e164: "+393205561178",
      known: true,
    },
    {
      company: "Il Ferramenta",
      person: "Cristina Villa",
      role: "Buyer",
      e164: "+393356678812",
      known: false,
    },
    {
      company: "Tecnologie Applicate",
      person: "Marco D'Amico",
      role: "Amministratore",
      e164: "+393402211348",
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
  // The scripts are the group's own knowledge pages, in the folder a reader finds
  // them in.
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
      const rowUid = `ob-row-${list.key}-${index + 1}`;
      let cardUid: string | null = null;
      if (person.known) {
        cardUid = `ob-card-${list.key}-${index + 1}`;
        cards.push({
          id: cardUid,
          addressBookIds: { [book]: true },
          "@type": "Card",
          version: "1.0",
          uid: `uid-${cardUid}`,
          kind: "individual",
          name: { full: person.person },
          organizations: { o1: { name: person.company } },
          titles: { t1: { "@type": "Title", name: person.role } },
          phones: { p1: { "@type": "Phone", number: person.e164 } },
          updated: at,
        } satisfies Obj);
      }
      return {
        version: 1,
        uid: rowUid,
        campaignUid: campaign.uid,
        e164: person.e164,
        extension: null,
        context: `${person.company}, chiedi di ${person.person.split(" ")[0]}`,
        cardUid,
        state: "open",
        claim: null,
        nextCallAt: null,
        calls: [],
        trimmed: 0,
        createdAt: at,
      };
    });
    nodes.push(
      node.json(`ob-rows-${list.key}`, "ob-rows", `${campaign.uid}.json`, { version: 1, rows }, group),
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
  const closedRows: RowDoc[] = CLOSED.people.map((person, index) => ({
    version: 1,
    uid: `ob-row-${CLOSED.key}-${index + 1}`,
    campaignUid: closed.uid,
    e164: person.e164,
    extension: null,
    context: `${person.company}, chiedi di ${person.person.split(" ")[0]}`,
    cardUid: person.known ? `ob-card-${CLOSED.key}-${index + 1}` : null,
    state: "done",
    claim: null,
    nextCallAt: null,
    calls: [
      {
        at,
        by: author,
        outcome: index % 3 === 0 ? "spoke" : index % 3 === 1 ? "no-answer" : "not-interested",
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
  }));
  for (const person of CLOSED.people) {
    if (!person.known) continue;
    const cardUid = `ob-card-${CLOSED.key}-${CLOSED.people.indexOf(person) + 1}`;
    cards.push({
      id: cardUid,
      addressBookIds: { [book]: true },
      "@type": "Card",
      version: "1.0",
      uid: `uid-${cardUid}`,
      kind: "individual",
      name: { full: person.person },
      organizations: { o1: { name: person.company } },
      titles: { t1: { "@type": "Title", name: person.role } },
      phones: { p1: { "@type": "Phone", number: person.e164 } },
      updated: at,
    } satisfies Obj);
  }
  nodes.push(
    node.json(`ob-rows-${CLOSED.key}`, "ob-rows", `${closed.uid}.json`, {
      version: 1,
      rows: closedRows,
    }, group),
  );

  return { nodes, cards };
}
