/**
 * Hand the browser a file to save.
 *
 * Two shapes, one click. `triggerDownload` takes a URL the server serves — an
 * attachment, a message as `.eml`, a file in the account — and is the only place
 * a download anchor is written: three lines that get copied, and a copy is where
 * a filename stops matching the URL it names. `downloadFile` takes the content the
 * app made and releases the object URL as soon as the download has been started,
 * because a click on the link starts it synchronously and an unreleased URL
 * keeps the whole file in memory for as long as the tab is open — an address
 * book's worth of vCards per export, a calendar, a copy of an audit log.
 *
 * A server URL is not an object URL and is not released by anyone: the browser
 * ends the read when the response does.
 */
export function triggerDownload(url: string, filename: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
}

export function downloadFile(content: BlobPart, type: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  triggerDownload(url, filename);
  URL.revokeObjectURL(url);
}
