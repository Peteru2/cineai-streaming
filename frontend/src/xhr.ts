import { PartError } from './uploader';

export function xhrPutPart(
  url: string,
  body: Blob,
  onProgress: (loadedBytes: number) => void,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.timeout = 120_000;

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new PartError(xhr.status, `Storage answered ${xhr.status}`));
    };
    xhr.onerror = () => reject(new PartError(null, 'Network error'));
    xhr.ontimeout = () => reject(new PartError(null, 'Upload timed out'));

    signal.addEventListener(
      'abort',
      () => {
        xhr.abort();
        reject(new PartError(null, 'Upload cancelled'));
      },
      { once: true },
    );

    xhr.send(body);
  });
}