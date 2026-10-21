import { create } from "zustand";
import { useSession } from "../session";
import { dragSlice } from "./slices/drag";
import { foldersSlice } from "./slices/folders";
import { textSlice } from "./slices/text";
import { treeSlice } from "./slices/tree";
import { uploadsSlice } from "./slices/uploads";
import type { FilesState } from "./types";

export const useFiles = create<FilesState>((set, get) => ({
  accountId: null,
  ownAccountId: null,
  sharedAccounts: [],
  available: false,
  initialized: false,
  nodes: {},
  children: {},
  listingShown: null,
  loading: false,
  error: null,
  runs: [],
  dirIds: [],
  treeLoaded: false,
  draggingIds: [],

  ...treeSlice(set, get),
  ...foldersSlice(set, get),
  ...uploadsSlice(set, get),
  ...textSlice(set, get),
  ...dragSlice(set, get),
}));

export {
  countChildren,
  emptyForAccount,
  LEVEL_LIMIT,
  readChildren,
  withoutAppFolder,
} from "./shared";
useSession.subscribe((s) => {
  if (s.status !== "authenticated")
    useFiles.setState({ accountId: null, nodes: {}, children: {}, listingShown: null });
});
