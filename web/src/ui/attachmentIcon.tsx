import {
  Calendar,
  FileArchive,
  FileIcon,
  FileSpreadsheet,
  FileText,
  Film,
  Image as ImageIcon,
  Music,
  UserPlus,
} from "lucide-react";

/**
 * The icon an attachment wears, from its media type and — where the type is
 * vague — its name.
 *
 * The reader and the composer both list attachments, and each imported this
 * from the other before it lived here: a mapping kept in one of its two users
 * is a mapping the second one drags the whole first module in for, which is
 * how the composer's chunk came to contain the message view.
 */
export function attachmentIcon(type: string, name?: string | null) {
  const t = type.toLowerCase();
  const n = (name ?? "").toLowerCase();
  if (t.startsWith("image/")) return <ImageIcon size={18} />;
  if (t.startsWith("video/")) return <Film size={18} />;
  if (t.startsWith("audio/")) return <Music size={18} />;
  if (t === "application/pdf") return <FileText size={18} />;
  if (/zip|tar|gzip|7z|rar|compressed/.test(t) || /\.(zip|tgz|gz|7z|rar)$/.test(n))
    return <FileArchive size={18} />;
  if (/spreadsheet|excel|csv/.test(t) || /\.(xlsx?|csv)$/.test(n))
    return <FileSpreadsheet size={18} />;
  if (t === "text/calendar") return <Calendar size={18} />;
  if (t.includes("vcard")) return <UserPlus size={18} />;
  if (t.startsWith("text/") || /word|document/.test(t)) return <FileText size={18} />;
  return <FileIcon size={18} />;
}
