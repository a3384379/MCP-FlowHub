export function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function download(
  filename: string,
  content: string,
  mimeType = "text/plain",
) {
  downloadBlob(
    filename,
    new Blob([content], { type: mimeType + ";charset=utf-8" }),
  );
}
