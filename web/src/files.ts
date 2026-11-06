/** Blob URLs stay local to the browser and never contain a server URL or key. */
function localLink(blob: Blob): HTMLAnchorElement {
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.rel = 'noopener noreferrer';
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return link;
}

export function downloadBlob(blob: Blob, name: string): void {
  const link = localLink(blob);
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
}

/** A text/plain document cannot interpret paste content as HTML or script. */
export function openRawText(text: string): void {
  const link = localLink(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  link.target = '_blank';
  document.body.append(link);
  link.click();
  link.remove();
}
