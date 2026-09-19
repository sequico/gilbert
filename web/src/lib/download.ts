/**
 * Hand the browser a file the app made, to save.
 *
 * The object URL is released as soon as the download has been started. A click
 * on the link starts it synchronously, and an unreleased URL keeps the whole
 * file in memory for as long as the tab is open — an address book's worth of
 * vCards per export, a calendar, a copy of an audit log.
 *
 * One place, because five of these had been written by hand and three of them
 * never released anything: the leak is invisible, costs memory in proportion to
 * what was exported, and is exactly the kind of line that gets copied.
 */
export function downloadFile(content: BlobPart, type: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
