/**
 * The one folder, and the one type a document in it is stored as.
 *
 * Every byte Gilbert keeps durably is a document in the `gilbert` folder of an
 * account's own Files, written by one tier and often read by the other: the
 * synced settings, a group's label catalog, a chat transcript, the agent's
 * rules and records, the identity lock. So the folder's name and the MIME type
 * those documents are stored and fetched with are contracts between the tiers,
 * not names either of them owns — and a second spelling of one of them is not a
 * cosmetic difference: `isAppFolder` looks for the folder by name, and a
 * document written under a different type is a document a reader opening it
 * with the expected type may refuse.
 *
 * The mock reproduces Stalwart and writes its own copies on purpose; that is
 * the one place a duplicate is tolerable, because it is simulating a server
 * rather than speaking to one.
 *
 * Constants only: no runtime code reaches a bundle through this file.
 */

/** The folder Gilbert keeps its own documents in, in every account. */
export const APP_FOLDER_NAME = "gilbert";

/** What an app-folder document is stored and fetched as, in both tiers. */
export const APP_DOCUMENT_TYPE = "application/json";
