/**
 * The installation document's own client door (ADR 0011).
 *
 * One reader and one writer for `GET`/`POST /api/admin/installation`, and the
 * shape both answer with. The Installation editor is the one administration
 * page that publishes the document, and it shows and writes the whole of it,
 * which is why the writer takes it as text rather than as a parsed value: a
 * document the server can refuse is better than one the editor silently
 * reshaped.
 */
import { installationDefaults } from "@gilbert/shared/installation";
import { apiFetch } from "@/jmap/client";

/** What `GET /api/admin/installation` answers, as the server builds it. */
export interface InstallationView {
  present: boolean;
  document: string | null;
  problem: string | null;
  /** The Files account whose app folder holds it — the Master's own. */
  account: string;
  /** The address that account belongs to: the Master the installation signs in as. */
  master: string;
  location: string;
}

/**
 * What a publish wrote, and when it applies.
 *
 * `applies` is a time, not a reassurance: the server reads the document at
 * boot, so a publish lands in the account's Files and the *next* boot runs on
 * it. The running process keeps the configuration it booted with.
 */
export interface InstallationPublished {
  account: string;
  master: string;
  location: string;
  /** The document as it is now stored: byte for byte what a read returns. */
  document: string;
  epoch: number;
  applies: "next-boot";
  message: string;
}

/** Read the stored document, and what a boot would make of it. */
export async function fetchInstallation(): Promise<InstallationView> {
  const res = await apiFetch<{ installation: InstallationView }>(
    "/api/admin/installation",
  );
  return res.installation;
}

/** Publish the document whole, and get back what is now stored. */
export async function publishInstallation(text: string): Promise<InstallationPublished> {
  const res = await apiFetch<{ outcome: InstallationPublished }>(
    "/api/admin/installation",
    { method: "POST", body: text },
  );
  return res.outcome;
}

/**
 * A document to start from when the account holds none.
 *
 * The shared defaults (`@gilbert/shared/installation`) are the same values the
 * boot writes on a first start, so this is not a second idea of what an
 * installation is; the one thing a person cannot supply is the app secret, and
 * it is generated here the way the boot generates it.
 */
export function startingInstallationDocument(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const secret = btoa(String.fromCharCode(...bytes));
  return JSON.stringify({ ...installationDefaults(), secret }, null, 2);
}
