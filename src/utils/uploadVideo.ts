import type { ProjectRecord } from '../types/studio';

const CHUNK_SIZE_BYTES = 14 * 1024 * 1024; // 14 MB chunks stay safely under 32 MB proxy limits with fewer round trips
const UPLOAD_CONCURRENCY = 4; // 4 parallel chunk streams maximize residential/fiber upload throughput

export interface UploadProgressStats {
  percent: number;
  uploadedBytes: number;
  totalBytes: number;
  speedBytesPerSec: number;
  etaSeconds: number | null;
  resumedChunks: number;
}

async function parseJsonSafe(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    const cleaned = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    throw new Error(
      `Server returned HTTP ${res.status}${cleaned ? `: ${cleaned.slice(0, 140)}` : ''}`
    );
  }
}

function sendChunkWithXhr(params: {
  uploadId: string;
  chunkIndex: number;
  chunk: Blob;
  onChunkProgress: (loadedBytes: number) => void;
}): Promise<void> {
  const { uploadId, chunkIndex, chunk, onChunkProgress } = params;
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/projects/upload/chunk');
    xhr.timeout = 120000;
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-Upload-Id', uploadId);
    xhr.setRequestHeader('X-Chunk-Index', String(chunkIndex));

    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable) {
        onChunkProgress(ev.loaded);
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onChunkProgress(chunk.size);
        resolve();
        return;
      }
      try {
        const json = JSON.parse(xhr.responseText || '{}') as { error?: string };
        reject(new Error(json.error || `Chunk upload failed (HTTP ${xhr.status})`));
      } catch {
        reject(
          new Error(
            `Upload chunk ${chunkIndex + 1} failed (HTTP ${xhr.status} ${xhr.statusText || ''})`.trim()
          )
        );
      }
    };

    xhr.onerror = () => reject(new Error('Network error while uploading video chunk'));
    xhr.ontimeout = () => reject(new Error(`Upload chunk ${chunkIndex + 1} timed out`));
    xhr.send(chunk);
  });
}

export interface StagedUploadFile {
  filename: string;
  storedFilename: string;
  sourceUrl: string;
}

async function runChunkedUploadCore(params: {
  file: File;
  title?: string;
  brief?: string;
  attachProjectId?: string;
  stageOnly?: boolean;
  onProgress?: (percent: number, stats?: UploadProgressStats) => void;
}): Promise<{ project?: ProjectRecord; stagedFile?: StagedUploadFile }> {
  const { file, title, brief, attachProjectId, stageOnly, onProgress } = params;
  const totalChunks = Math.max(1, Math.ceil(file.size / CHUNK_SIZE_BYTES));
  const fingerprint = `${file.name}|${file.size}|${file.lastModified}|${attachProjectId || ''}|${
    stageOnly ? 'stage' : 'proj'
  }`;

  onProgress?.(0, {
    percent: 0,
    uploadedBytes: 0,
    totalBytes: file.size,
    speedBytesPerSec: 0,
    etaSeconds: null,
    resumedChunks: 0,
  });

  const initRes = await fetch('/api/projects/upload/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filename: file.name,
      title: title?.trim() || file.name,
      brief: brief?.trim() || undefined,
      fileSize: file.size,
      totalChunks,
      chunkSize: CHUNK_SIZE_BYTES,
      fingerprint,
      attachProjectId,
      stageOnly: Boolean(stageOnly),
    }),
  });
  const initData = await parseJsonSafe(initRes);
  if (!initRes.ok || typeof initData.uploadId !== 'string') {
    throw new Error(
      (typeof initData.error === 'string' && initData.error) ||
        `Failed to initialize upload (HTTP ${initRes.status})`
    );
  }

  const uploadId = initData.uploadId;
  const alreadyUploaded = new Set<number>(
    Array.isArray(initData.uploadedChunks)
      ? initData.uploadedChunks.filter((n): n is number => typeof n === 'number')
      : []
  );

  const chunkSizes = Array.from({ length: totalChunks }, (_, idx) => {
    const start = idx * CHUNK_SIZE_BYTES;
    return Math.min(file.size, start + CHUNK_SIZE_BYTES) - start;
  });

  const chunkProgress = new Array<number>(totalChunks).fill(0);
  let resumedBytes = 0;
  for (const idx of alreadyUploaded) {
    if (idx >= 0 && idx < totalChunks) {
      chunkProgress[idx] = chunkSizes[idx];
      resumedBytes += chunkSizes[idx];
    }
  }

  const pendingIndices = Array.from({ length: totalChunks }, (_, idx) => idx).filter(
    (idx) => !alreadyUploaded.has(idx)
  );

  const startedAt = Date.now();
  let lastReportAt = 0;

  const emitProgress = (force = false) => {
    const now = Date.now();
    if (!force && now - lastReportAt < 180) return;
    lastReportAt = now;

    const totalUploaded = chunkProgress.reduce((acc, v) => acc + v, 0);
    const newlyUploaded = Math.max(0, totalUploaded - resumedBytes);
    const elapsedSec = Math.max(0.25, (now - startedAt) / 1000);
    const speedBytesPerSec = newlyUploaded / elapsedSec;
    const remainingBytes = Math.max(0, file.size - totalUploaded);
    const etaSeconds = speedBytesPerSec > 1024 ? Math.ceil(remainingBytes / speedBytesPerSec) : null;
    const percent = Math.min(99, Math.round((totalUploaded / Math.max(1, file.size)) * 100));

    onProgress?.(percent, {
      percent,
      uploadedBytes: totalUploaded,
      totalBytes: file.size,
      speedBytesPerSec,
      etaSeconds,
      resumedChunks: alreadyUploaded.size,
    });
  };

  emitProgress(true);

  // Keep server & browser session active during multi-minute uploads
  const heartbeat = window.setInterval(() => {
    void fetch('/api/health').catch(() => undefined);
  }, 20000);

  let nextQueuePos = 0;

  const runWorker = async (): Promise<void> => {
    while (nextQueuePos < pendingIndices.length) {
      const idx = pendingIndices[nextQueuePos++];
      const start = idx * CHUNK_SIZE_BYTES;
      const end = Math.min(file.size, start + CHUNK_SIZE_BYTES);
      const chunk = file.slice(start, end);

      let lastErr: unknown = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await sendChunkWithXhr({
            uploadId,
            chunkIndex: idx,
            chunk,
            onChunkProgress: (loadedInChunk) => {
              chunkProgress[idx] = Math.min(chunk.size, loadedInChunk);
              emitProgress(false);
            },
          });
          chunkProgress[idx] = chunk.size;
          emitProgress(true);
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          chunkProgress[idx] = 0;
          if (attempt < 2) {
            await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
          }
        }
      }
      if (lastErr) {
        throw lastErr;
      }
    }
  };

  try {
    const workerCount = Math.min(UPLOAD_CONCURRENCY, Math.max(1, pendingIndices.length));
    await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  } finally {
    window.clearInterval(heartbeat);
  }

  const completeRes = await fetch('/api/projects/upload/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uploadId }),
  });
  const completeData = await parseJsonSafe(completeRes);
  if (!completeRes.ok || (!completeData.project && !completeData.stagedFile)) {
    throw new Error(
      (typeof completeData.error === 'string' && completeData.error) ||
        `Failed to finalize uploaded video (HTTP ${completeRes.status})`
    );
  }

  onProgress?.(100, {
    percent: 100,
    uploadedBytes: file.size,
    totalBytes: file.size,
    speedBytesPerSec: 0,
    etaSeconds: 0,
    resumedChunks: alreadyUploaded.size,
  });

  return {
    project: completeData.project as ProjectRecord | undefined,
    stagedFile: completeData.stagedFile as StagedUploadFile | undefined,
  };
}

export async function uploadVideoInChunks(params: {
  file: File;
  title?: string;
  brief?: string;
  attachProjectId?: string;
  onProgress?: (percent: number, stats?: UploadProgressStats) => void;
}): Promise<ProjectRecord> {
  const res = await runChunkedUploadCore({ ...params, stageOnly: false });
  if (!res.project) {
    throw new Error('Server did not return created project.');
  }
  return res.project;
}

export async function stageVideoInChunks(params: {
  file: File;
  onProgress?: (percent: number, stats?: UploadProgressStats) => void;
}): Promise<StagedUploadFile> {
  const res = await runChunkedUploadCore({ ...params, stageOnly: true });
  if (!res.stagedFile) {
    throw new Error('Server did not return staged upload metadata.');
  }
  return res.stagedFile;
}
