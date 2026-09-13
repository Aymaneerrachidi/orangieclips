// Three concurrent parts keep uploads responsive without loading the video into memory.
export async function uploadParts(pending, file, signal, onProgress) {
  const progress = pending.urls.map(() => 0);
  let next = 0;
  const report = () => onProgress(Math.round(progress.reduce((a, b) => a + b, 0) / file.size * 100));
  function part(index) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new DOMException('Upload canceled', 'AbortError'));
      const xhr = new XMLHttpRequest();
      const abort = () => xhr.abort();
      const cleanup = () => signal.removeEventListener('abort', abort);
      signal.addEventListener('abort', abort, { once: true });
      const chunk = file.slice(index * pending.partSize, (index + 1) * pending.partSize);
      xhr.open('PUT', pending.urls[index]);
      xhr.upload.onprogress = e => { progress[index] = e.loaded; report(); };
      xhr.onload = () => { cleanup(); if (xhr.status >= 200 && xhr.status < 300) { progress[index] = chunk.size; report(); resolve(); } else reject(new Error('A video part could not be uploaded. Please try again.')); };
      xhr.onerror = () => { cleanup(); reject(new Error('Connection lost. Please try your upload again.')); };
      xhr.onabort = () => { cleanup(); reject(new DOMException('Upload canceled', 'AbortError')); };
      xhr.send(chunk);
    });
  }
  async function worker() {
    while (next < pending.urls.length) {
      const index = next++;
      for (let attempt = 0; attempt < 3; attempt++) {
        try { await part(index); break; }
        catch (error) { if (signal.aborted || attempt === 2) throw error; progress[index] = 0; report(); }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, pending.urls.length) }, worker));
}
