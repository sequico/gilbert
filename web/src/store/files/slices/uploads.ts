import { errorMessage } from "@gilbert/shared/errors";
import type { Id } from "@/jmap/types";
import { folderPathKey, foldersNeeded } from "@/lib/dropUpload";
import { isAlreadyExists } from "@/lib/filenode";
import { t as translate } from "@/lib/i18n";
import {
  createDirectory,
  endRun,
  levelKey,
  levelNames,
  nameTakenMessage,
  putFile,
  readLevels,
  runRow,
  type SiblingNode,
  startRun,
  trayRuns,
  uploadOne,
} from "../shared";
import type { FilesGet, FilesSet, FilesState } from "../types";

/**
 * Uploads: the picker's files, a dropped tree, a save into another account,
 * and the tray rows that report them.
 *
 * A slice of the files store: the state is assembled in `../index`, and this
 * function only says what this job does with `set` and `get`.
 */
export function uploadsSlice(
  set: FilesSet,
  get: FilesGet,
): Pick<FilesState, "upload" | "uploadTo" | "uploadPlan" | "dismissRun" | "cancelRun"> {
  return {
    /*
     * A file the folder already holds is written over, and its bytes are uploaded
     * to do it: that is the same upload the first copy cost, paid again because
     * the reader asked for these bytes to be here. A name a **folder** holds is
     * the one case that stops, and the server is what says so -- the create is
     * refused and the row carries the refusal. No level is listed first: the
     * refusal names the node, which is what a replacement needs, so a drop of two
     * hundred files costs two hundred uploads and one set each rather than a
     * listing on top of them.
     */
    async upload(parentId, files) {
      const accountId = get().accountId!;
      /* One run for the whole picker selection, so a file that is taking too
       long is a thing the reader can stop -- together with the files of the
       same gesture that had not started -- and so the count beside each row is
       about the whole selection rather than about one file. */
      const run = startRun(files.length);
      try {
        for (const f of files) {
          if (run.controller.signal.aborted) break;
          await uploadOne(set, accountId, parentId, f, run);
        }
      } finally {
        endRun(run);
      }
      await get().loadChildren(parentId);
    },

    /*
     * The way out of a row that failed.
     *
     * Nothing else takes one away: the tray is the only place a failed upload is
     * reported, and a row left in it would sit there for the rest of the session,
     * in every folder, with nothing to press.
     */
    dismissRun(id) {
      set((s) => ({ runs: s.runs.filter((u) => u.id !== id) }));
    },

    /*
     * The way out of a row that is still going.
     *
     * The row names its run, so a reader who presses Cancel on the file that is
     * on screen stops the run that file belongs to -- including the files of the
     * same drop that had not started, which is the only way a folder of two
     * hundred items can be stopped in one press. The abort travels two ways: the
     * upload in flight is aborted through the signal it was given, and the loop
     * that owns the run sees it before it starts the next file. A row whose run
     * is already over has nothing to abort and does nothing, which is why the
     * registry is emptied as each run ends.
     *
     * Only a row **in flight** may cancel: a row carrying an error is a failure
     * the reader has been told about and has still to read, and its run may well
     * have moved on to another file by now -- pressing Cancel there would stop
     * work the press had nothing to do with. The tray offers Cancel on the row in
     * flight alone, and this is the same rule one layer down, where it cannot be
     * forgotten by a second caller.
     */
    cancelRun(id) {
      const row = get().runs.find((u) => u.id === id);
      if (row && !row.error) trayRuns.get(row.runId)?.abort();
    },

    async uploadTo(accountId, files, parentId = null) {
      const failed: string[] = [];
      const existing: string[] = [];
      let saved = 0;
      /*
       * One read of the folder, and whatever it answered is worth checking
       * against: a page of a large folder still names real siblings, so a name
       * found in it really is taken, and an attachment that must not overwrite
       * anything is worth not paying a blob for. A read that failed leaves an
       * empty map, which refuses nothing and lets the server say so -- the same
       * outcome as having no list at all, one blob later.
       */
      const read = await readLevels(accountId, { kind: "level", parentId }).catch(
        () => null,
      );
      const taken = levelNames(read ?? undefined, parentId);
      for (const f of files) {
        try {
          if (taken.has(f.name)) {
            existing.push(f.name);
            continue;
          }
          await putFile(accountId, parentId, f, { onExists: "refuse" });
          taken.set(f.name, { id: "", name: f.name, nodeType: "file" });
          saved += 1;
        } catch (err) {
          // The folder's own answer decides which list it goes in: a name that is
          // taken leaves a file that is still there, which is not a failure and
          // must not be reported as one.
          if (isAlreadyExists(err)) existing.push(f.name);
          else failed.push(f.name);
        }
      }
      return { saved, failed, existing };
    },

    /*
     * A drop, landed in the tree it names -- reusing what is already there.
     *
     * Every folder of the drop is resolved first: the one already under the
     * target is used as it is, and only a name that is not there is created. A
     * folder dropped twice therefore adds what is new to the same folders instead
     * of building a second copy beside them, which is what dropping onto a
     * folder one already has has to mean.
     *
     * The files are written over what the folder already holds of the same name,
     * folder and file alike, so dropping the same tree twice leaves one tree and
     * the latest bytes rather than a tray full of refusals. What that may not
     * overwrite is a folder: a file whose name a folder carries is refused (see
     * `putFile`).
     *
     * A folder that cannot be resolved is not a folder to guess at. Nothing below
     * it is created, and the files that were headed for it are left in the tray as
     * failures: filing them into the nearest folder that does exist is how a drop
     * comes to scatter files somewhere nobody chose.
     */
    async uploadPlan(parentId, plan) {
      const accountId = get().accountId!;
      /* One run for the whole dropped tree, so a folder of two hundred items is
       one thing the reader can stop: the file in flight, and every file of the
       drop that had not started. The count starts at the files the drop carried
       and is corrected below, once the folders have said which of them have
       anywhere to go. */
      const run = startRun(plan.files.length);
      try {
        /*
         * One read of the account answers every level the drop names -- as far as
         * it got.
         *
         * The walk resolves one folder at a time and would otherwise list a folder
         * per folder -- a request each -- for a tree the account can describe in a
         * single query. So the levels are read together here, and on an account the
         * read finished the walk makes no request at all except the creates it has
         * to make.
         *
         * A read that came back short is finished by **narrowing**, not by paging
         * the account until it is exhausted: the drop already knows which levels it
         * touches, and those are the smaller and more targeted piece of work. A
         * read that failed outright is the same situation as a short one -- look
         * each level up when it is asked for.
         */
        const scan = await readLevels(accountId, { kind: "account" }).catch(() => null);
        const hint = scan ?? new Map<string, Map<string, SiblingNode>>();

        /*
         * The names a folder may be resolved from: a hint is enough.
         *
         * A partial read can only make this walk try a create the server refuses,
         * and that refusal sends it back to look at the level for real -- so the
         * worst a short read costs here is one wasted create per folder that does
         * exist, and the level it teaches is then in hand for everything below it.
         *
         * This is the walk's only use for a level's names. What a folder **holds**
         * is not read at all: a file's name is written into rather than checked,
         * and the refusal of a create is what names the node that has it (see
         * `putFile`), so a level the drop writes files into costs no read.
         */
        const namesAt = async (id: Id | null): Promise<Map<string, SiblingNode>> => {
          const key = levelKey(id);
          const known = hint.get(key);
          if (known) return known;
          const read = await readLevels(accountId, { kind: "level", parentId: id });
          const names = levelNames(read, id);
          hint.set(key, names);
          return names;
        };

        // Folders first, parents before children, so every file has somewhere to go.
        //
        // Nothing in this walk checks the run's signal, and that is deliberate: a
        // run becomes cancellable when its first file is in flight, because until
        // then the tray holds no row of it for the reader to press. The checks
        // that matter are the ones in front of each file, below.
        const dirIds = new Map<string, Id | null>([["", parentId]]);
        // Paths the drop asked for and cannot have; the empty key is the drop
        // itself, which always exists because that is where the reader aimed.
        const missing = new Set<string>();
        for (const path of foldersNeeded(plan)) {
          const key = folderPathKey(path);
          const parentKey = folderPathKey(path.slice(0, -1));
          const name = path[path.length - 1]!;
          /* A parent that could not be resolved takes its whole subtree with it:
         creating the child elsewhere would put it outside the folder it was
         dropped in. */
          if (missing.has(parentKey)) {
            missing.add(key);
            continue;
          }
          const into = dirIds.get(parentKey) ?? parentId;
          const siblings = await namesAt(into);
          const found = siblings.get(name);
          if (found?.nodeType === "directory") {
            dirIds.set(key, found.id);
            continue;
          }
          if (found) {
            // A file is standing where the folder goes. Neither one may be moved
            // out of the way silently, so the folder -- and what was in it -- stop
            // here and say why.
            missing.add(key);
            set({ error: nameTakenMessage(name) });
            continue;
          }
          try {
            const id = await createDirectory(accountId, into, name);
            dirIds.set(key, id);
            siblings.set(name, { id, name, nodeType: "directory" });
          } catch (err) {
            /*
             * Another writer can make the folder between the read and this create,
             * and the server refuses a second create of the same name. That refusal
             * means the folder this drop wanted exists -- so take it rather than
             * reporting a name nobody can see. The level is re-read rather than
             * trusted: the listing in hand was taken before the other writer's
             * create, which is why the create was refused at all.
             */
            if (isAlreadyExists(err)) {
              const key0 = levelKey(into);
              const read = await readLevels(accountId, { kind: "level", parentId: into });
              const fresh = levelNames(read, into);
              /* Merged rather than substituted: the read in hand may have held names
             this one did not (both can be pages of a level larger than one), and
             every name either read saw is a real sibling, so dropping one set
             for the other gives up refusals that were already paid for. */
              const known = hint.get(key0);
              const names = known ? new Map([...known, ...fresh]) : fresh;
              hint.set(key0, names);
              const theirs = names.get(name);
              if (theirs?.nodeType === "directory") {
                dirIds.set(key, theirs.id);
                continue;
              }
            }
            missing.add(key);
            set({ error: errorMessage(err) });
          }
        }
        const byFolder = new Map<string, File[]>();
        const orphans: File[] = [];
        for (const item of plan.files) {
          const key = folderPathKey(item.path);
          if (missing.has(key)) {
            orphans.push(item.file);
            continue;
          }
          byFolder.set(key, [...(byFolder.get(key) ?? []), item.file]);
        }
        /*
         * The run's size is the files that have somewhere to go, counted once
         * they all do. A file whose folder could not be made is not of this run
         * -- it was never going to be written -- and its row says so on its own
         * line below, with the count the run it was not part of has.
         */
        run.tally.total = [...byFolder.values()].reduce((n, f) => n + f.length, 0);
        if (orphans.length)
          set((s) => ({
            runs: [
              ...s.runs,
              ...orphans.map((f) =>
                runRow(
                  f.name,
                  translate("Its folder could not be created."),
                  run.id,
                  run.tally,
                ),
              ),
            ],
          }));
        /*
         * Every folder of the drop, uploaded through one writer each, one file
         * after another. What each file finds under its own name is the server's
         * answer rather than a listing taken first: a name the folder already
         * holds is written over, and one a folder holds stops the file with the
         * refusal.
         */
        for (const [key, files] of byFolder) {
          if (run.controller.signal.aborted) break;
          const into = dirIds.get(key) ?? parentId;
          for (const file of files) {
            if (run.controller.signal.aborted) break;
            await uploadOne(set, accountId, into, file, run);
          }
        }
      } finally {
        endRun(run);
      }
      await get().loadChildren(parentId);
      void get().loadTree();
    },
  };
}
