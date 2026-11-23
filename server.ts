import 'dotenv/config';
import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import multer from 'multer';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { renderAdaptiveClip } from './src/server/agents/adaptiveEditingAgent';
import { exportClipLocally } from './src/server/agents/exportManager';
import { generateAndScoreHighlights } from './src/server/agents/highlightAgent';
import { runProjectPipeline, runYouTubePipeline } from './src/server/agents/orchestrator';
import {
  autoHealAndRegenerateClip,
  validateRenderedClip,
} from './src/server/agents/qualityControlAgent';
import {
  SAMPLE_PRESETS,
  SUPPORTED_EXTENSIONS,
  synthesizeSampleVideo,
} from './src/server/agents/videoIngestionAgent';
import {
  downloadYouTubeVideo,
  fetchYouTubeMetadata,
} from './src/server/agents/youtubeIngestionAgent';
import { probeVideoMetadata } from './src/server/agents/videoIngestionAgent';
import {
  BUILTIN_CATEGORIES,
  EDITING_PROFILES,
  findCategoryByIdOrName,
} from './src/server/categories';
import {
  EXPORTS_DIR,
  PROJECTS_DIR,
  UPLOADS_DIR,
  resolveSafePath,
  store,
} from './src/server/db';
import { formatGeminiError } from './src/server/geminiClient';
import type { EditingProfileId, HighlightRecord, StudioSettings } from './src/types/studio';

const PORT = 3000;

const uploadStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    cb(null, UPLOADS_DIR);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const safeId = `${Date.now()}_${crypto.randomUUID().slice(0, 8)}${ext}`;
    cb(null, safeId);
  },
});

const upload = multer({
  storage: uploadStorage,
  limits: {
    fileSize: 2 * 1024 * 1024 * 1024, // 2 GB local file support
  },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      cb(new Error('Unsupported format. Import MP4, MOV, or MKV files.'));
      return;
    }
    cb(null, true);
  },
});

async function startServer() {
  store.recoverInterruptedProjects();
  const app = express();
  app.use(express.json({ limit: '4mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  // Bootstrap studio state
  app.get('/api/bootstrap', (_req, res) => {
    const settings = store.getSettings();
    res.json({
      projects: store.listProjects(),
      highlights: store.listHighlights(),
      exports: store.listExports(),
      settings,
      builtinCategories: BUILTIN_CATEGORIES,
      editingProfiles: Object.values(EDITING_PROFILES),
      samplePresets: SAMPLE_PRESETS.map((p) => ({
        id: p.id,
        title: p.title,
        languageLabel: p.languageLabel,
        categoryHint: p.categoryHint,
      })),
    });
  });

  // Upload a local MP4, MOV, or MKV file
  app.post('/api/projects/upload', upload.single('video'), (req, res) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: 'No video file uploaded.' });
        return;
      }

      const projectId = `prj_${crypto.randomUUID().slice(0, 8)}`;
      const rawTitle =
        typeof req.body?.title === 'string' && req.body.title.trim()
          ? req.body.title.trim()
          : path.basename(req.file.originalname, path.extname(req.file.originalname));

      const sourcePath = resolveSafePath(UPLOADS_DIR, req.file.filename);
      const sourceUrl = `/api/uploads/${encodeURIComponent(req.file.filename)}`;

      const project = store.createProject({
        id: projectId,
        title: rawTitle,
        sourceFilename: req.file.originalname,
        sourcePath,
        sourceUrl,
      });

      // Run central orchestrator asynchronously
      void runProjectPipeline(projectId);

      res.status(201).json({ project });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Upload failed';
      res.status(400).json({ error: msg });
    }
  });

  // Resumable, parallel-safe chunked local video upload endpoints (up to 10 GB across 32 MB proxy limits)
  const uploadChunkSets = new Map<string, Set<number>>();

  app.post('/api/projects/upload/init', (req, res) => {
    try {
      const filename = typeof req.body?.filename === 'string' ? req.body.filename.trim() : '';
      const rawTitle = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
      const fileSize = Number(req.body?.fileSize ?? 0);
      const totalChunks = Number(req.body?.totalChunks ?? 0);
      const chunkSize = Number(req.body?.chunkSize ?? 14 * 1024 * 1024);
      const fingerprint = typeof req.body?.fingerprint === 'string' ? req.body.fingerprint.trim() : '';
      const attachProjectId =
        typeof req.body?.attachProjectId === 'string' ? req.body.attachProjectId.trim() : undefined;

      const ext = path.extname(filename).toLowerCase();
      if (!SUPPORTED_EXTENSIONS.has(ext)) {
        res.status(400).json({ error: 'Unsupported format. Import MP4, MOV, or MKV files.' });
        return;
      }
      if (!Number.isFinite(fileSize) || fileSize <= 0 || fileSize > 10 * 1024 * 1024 * 1024) {
        res.status(400).json({ error: 'File size must be between 1 byte and 10 GB.' });
        return;
      }
      if (!Number.isInteger(totalChunks) || totalChunks < 1 || chunkSize <= 0 || chunkSize > 20 * 1024 * 1024) {
        res.status(400).json({ error: 'Invalid chunk parameters.' });
        return;
      }
      if (attachProjectId && !store.getProjectInternal(attachProjectId)) {
        res.status(404).json({ error: 'Target project not found.' });
        return;
      }

      fs.mkdirSync(UPLOADS_DIR, { recursive: true });
      const uploadId = fingerprint
        ? `up_${crypto.createHash('sha256').update(fingerprint).digest('hex').slice(0, 16)}`
        : `up_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
      const partPath = resolveSafePath(UPLOADS_DIR, `${uploadId}.part`);
      const metaPath = resolveSafePath(UPLOADS_DIR, `${uploadId}.meta.json`);
      const chunksPath = resolveSafePath(UPLOADS_DIR, `${uploadId}.chunks.json`);

      if (fingerprint && fs.existsSync(metaPath) && fs.existsSync(partPath)) {
        try {
          const existingMeta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as {
            fileSize: number;
            chunkSize: number;
            totalChunks: number;
          };
          if (
            existingMeta.fileSize === fileSize &&
            existingMeta.chunkSize === chunkSize &&
            existingMeta.totalChunks === totalChunks
          ) {
            let uploadedChunks: number[] = [];
            if (uploadChunkSets.has(uploadId)) {
              uploadedChunks = Array.from(uploadChunkSets.get(uploadId)!);
            } else if (fs.existsSync(chunksPath)) {
              const saved = JSON.parse(fs.readFileSync(chunksPath, 'utf-8')) as number[];
              if (Array.isArray(saved)) {
                uploadChunkSets.set(uploadId, new Set(saved));
                uploadedChunks = saved;
              }
            }
            res.status(200).json({ uploadId, chunkSize, uploadedChunks });
            return;
          }
        } catch {
          // Fall through and recreate clean session
        }
      }

      fs.writeFileSync(partPath, Buffer.alloc(0));
      fs.writeFileSync(
        metaPath,
        JSON.stringify({
          uploadId,
          filename: path.basename(filename),
          title: rawTitle || path.basename(filename, ext),
          ext,
          fileSize,
          totalChunks,
          chunkSize,
          attachProjectId: attachProjectId || null,
        }),
        'utf-8'
      );
      uploadChunkSets.set(uploadId, new Set());
      fs.writeFileSync(chunksPath, '[]', 'utf-8');

      res.status(201).json({ uploadId, chunkSize, uploadedChunks: [] });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to initialize upload';
      res.status(400).json({ error: msg });
    }
  });

  app.post(
    '/api/projects/upload/chunk',
    express.raw({ type: 'application/octet-stream', limit: '20mb' }),
    (req, res) => {
      try {
        const uploadId = String(req.header('x-upload-id') || '').trim();
        const chunkIndex = Number(req.header('x-chunk-index'));
        if (!/^up_[a-f0-9]+$/i.test(uploadId)) {
          res.status(400).json({ error: 'Invalid upload ID.' });
          return;
        }
        const metaPath = resolveSafePath(UPLOADS_DIR, `${uploadId}.meta.json`);
        const partPath = resolveSafePath(UPLOADS_DIR, `${uploadId}.part`);
        const chunksPath = resolveSafePath(UPLOADS_DIR, `${uploadId}.chunks.json`);
        if (!fs.existsSync(metaPath) || !fs.existsSync(partPath)) {
          res.status(404).json({ error: 'Upload session expired or not found.' });
          return;
        }
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as {
          totalChunks: number;
          chunkSize: number;
        };
        if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= meta.totalChunks) {
          res.status(400).json({ error: 'Invalid chunk index.' });
          return;
        }
        if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
          res.status(400).json({ error: 'Empty upload chunk.' });
          return;
        }

        const fd = fs.openSync(partPath, 'r+');
        try {
          fs.writeSync(fd, req.body, 0, req.body.length, chunkIndex * meta.chunkSize);
        } finally {
          fs.closeSync(fd);
        }

        let set = uploadChunkSets.get(uploadId);
        if (!set) {
          set = new Set<number>();
          if (fs.existsSync(chunksPath)) {
            try {
              const prev = JSON.parse(fs.readFileSync(chunksPath, 'utf-8')) as number[];
              prev.forEach((n) => set!.add(n));
            } catch {
              // ignore
            }
          }
          uploadChunkSets.set(uploadId, set);
        }
        set.add(chunkIndex);
        fs.writeFileSync(chunksPath, JSON.stringify(Array.from(set)), 'utf-8');

        res.json({ ok: true, chunkIndex });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Chunk write failed';
        res.status(400).json({ error: msg });
      }
    }
  );

  app.post('/api/projects/upload/complete', async (req, res) => {
    try {
      const uploadId = typeof req.body?.uploadId === 'string' ? req.body.uploadId.trim() : '';
      if (!/^up_[a-f0-9]+$/i.test(uploadId)) {
        res.status(400).json({ error: 'Invalid upload ID.' });
        return;
      }

      const metaPath = resolveSafePath(UPLOADS_DIR, `${uploadId}.meta.json`);
      const partPath = resolveSafePath(UPLOADS_DIR, `${uploadId}.part`);
      const chunksPath = resolveSafePath(UPLOADS_DIR, `${uploadId}.chunks.json`);
      if (!fs.existsSync(metaPath) || !fs.existsSync(partPath)) {
        res.status(404).json({ error: 'Upload session not found.' });
        return;
      }

      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as {
        filename: string;
        title: string;
        ext: string;
        fileSize: number;
        totalChunks: number;
        attachProjectId: string | null;
      };

      const stat = fs.statSync(partPath);
      if (stat.size !== meta.fileSize) {
        res.status(400).json({
          error: `Uploaded file size mismatch (received ${stat.size} bytes, expected ${meta.fileSize} bytes).`,
        });
        return;
      }

      const finalFilename = `${Date.now()}_${crypto.randomUUID().slice(0, 8)}${meta.ext}`;
      const finalPath = resolveSafePath(UPLOADS_DIR, finalFilename);
      const sourceUrl = `/api/uploads/${encodeURIComponent(finalFilename)}`;
      fs.renameSync(partPath, finalPath);
      fs.unlinkSync(metaPath);
      if (fs.existsSync(chunksPath)) {
        fs.unlinkSync(chunksPath);
      }
      uploadChunkSets.delete(uploadId);

      if (meta.attachProjectId) {
        const existing = store.getProjectInternal(meta.attachProjectId);
        if (!existing) {
          res.status(404).json({ error: 'Target project not found.' });
          return;
        }
        const probe = await probeVideoMetadata(finalPath);
        store.updateProjectLocalMedia(existing.id, {
          sourceFilename: meta.filename,
          sourcePath: finalPath,
          sourceUrl,
          hasLocalVideoFile: true,
        });
        store.saveIngestionData(existing.id, probe, null, existing.scenes);
        store.updateProjectStage(
          existing.id,
          'completed',
          100,
          'Local MP4 attached. Ready for 9:16 FFmpeg rendering and export.',
          'ready',
          null
        );
        res.json({ project: store.getProject(existing.id) });
        return;
      }

      const projectId = `prj_${crypto.randomUUID().slice(0, 8)}`;
      const project = store.createProject({
        id: projectId,
        title: meta.title,
        sourceFilename: meta.filename,
        sourcePath: finalPath,
        sourceUrl,
      });

      void runProjectPipeline(projectId);
      res.status(201).json({ project });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to finalize upload';
      res.status(400).json({ error: msg });
    }
  });

  // Import a video directly from a YouTube link (with automatic Gemini URL fallback if cloud IP hits bot check)
  app.post('/api/projects/youtube', async (req, res) => {
    try {
      const rawUrl = typeof req.body?.url === 'string' ? req.body.url : '';
      const customTitle =
        typeof req.body?.title === 'string' && req.body.title.trim()
          ? req.body.title.trim()
          : '';
      const cookie = typeof req.body?.cookie === 'string' ? req.body.cookie : undefined;

      const meta = await fetchYouTubeMetadata({ rawUrl, cookie });
      const projectId = `prj_${crypto.randomUUID().slice(0, 8)}`;
      const storedFilename = `${Date.now()}_yt_${meta.videoId}.mp4`;
      const sourcePath = resolveSafePath(UPLOADS_DIR, storedFilename);
      const sourceUrl = `/api/uploads/${encodeURIComponent(storedFilename)}`;
      const sourceFilename = `youtube_${meta.videoId}.mp4`;

      const project = store.createProject({
        id: projectId,
        title: customTitle || meta.title,
        sourceFilename,
        sourcePath,
        sourceUrl,
        youtubeVideoId: meta.videoId,
        hasLocalVideoFile: false,
      });

      void runYouTubePipeline({
        projectId,
        canonicalUrl: meta.canonicalUrl,
        videoId: meta.videoId,
        outputMp4Path: sourcePath,
        sourceUrl,
        sourceFilename,
        cookie,
        hasCustomTitle: Boolean(customTitle),
      });

      res.status(201).json({ project });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to import YouTube video';
      res.status(400).json({ error: msg });
    }
  });

  // Attach a local MP4/MOV/MKV file to an existing YouTube-analyzed project to unlock FFmpeg rendering
  app.post('/api/projects/:id/attach-video', upload.single('video'), async (req, res) => {
    try {
      const project = store.getProjectInternal(req.params.id);
      if (!project) {
        res.status(404).json({ error: 'Project not found.' });
        return;
      }
      if (!req.file) {
        res.status(400).json({ error: 'No video file uploaded.' });
        return;
      }

      const sourcePath = resolveSafePath(UPLOADS_DIR, req.file.filename);
      const sourceUrl = `/api/uploads/${encodeURIComponent(req.file.filename)}`;
      const metadata = await probeVideoMetadata(sourcePath);

      store.updateProjectLocalMedia(project.id, {
        sourceFilename: req.file.originalname,
        sourcePath,
        sourceUrl,
        hasLocalVideoFile: true,
      });
      store.saveIngestionData(project.id, metadata, null, project.scenes);
      store.updateProjectStage(
        project.id,
        'completed',
        100,
        'Local MP4 attached. Ready for 9:16 FFmpeg rendering and export.',
        'ready',
        null
      );

      res.json({ project: store.getProject(project.id) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to attach local video';
      res.status(400).json({ error: msg });
    }
  });

  // Retry downloading the MP4 for a YouTube-analyzed project using user cookies
  app.post('/api/projects/:id/retry-youtube-download', async (req, res) => {
    try {
      const project = store.getProjectInternal(req.params.id);
      if (!project || !project.youtubeVideoId) {
        res.status(404).json({ error: 'YouTube project not found.' });
        return;
      }
      const cookie = typeof req.body?.cookie === 'string' ? req.body.cookie.trim() : '';
      if (!cookie) {
        res.status(400).json({ error: 'Please paste your YouTube Cookie header first.' });
        return;
      }

      const storedFilename = `${Date.now()}_yt_${project.youtubeVideoId}.mp4`;
      const sourcePath = resolveSafePath(UPLOADS_DIR, storedFilename);
      const sourceUrl = `/api/uploads/${encodeURIComponent(storedFilename)}`;

      await downloadYouTubeVideo({
        canonicalUrl: `https://www.youtube.com/watch?v=${project.youtubeVideoId}`,
        outputMp4Path: sourcePath,
        cookie,
      });

      const metadata = await probeVideoMetadata(sourcePath);
      store.updateProjectLocalMedia(project.id, {
        sourceFilename: `youtube_${project.youtubeVideoId}.mp4`,
        sourcePath,
        sourceUrl,
        hasLocalVideoFile: true,
      });
      store.saveIngestionData(project.id, metadata, null, project.scenes);
      store.updateProjectStage(
        project.id,
        'completed',
        100,
        'YouTube MP4 downloaded. Ready for 9:16 FFmpeg rendering and export.',
        'ready',
        null
      );

      res.json({ project: store.getProject(project.id) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'YouTube download retry failed';
      res.status(400).json({ error: msg });
    }
  });

  // Synthesize a genuine local MP4 sample video (English, French, or Arabic) and run full pipeline
  app.post('/api/projects/sample', async (req, res) => {
    try {
      const presetId = req.body?.presetId as
        | 'business_podcast_en'
        | 'tech_tutorial_fr'
        | 'motivation_ar';

      const projectId = `prj_${crypto.randomUUID().slice(0, 8)}`;
      const storedFilename = `${Date.now()}_${projectId}.mp4`;
      const sourcePath = resolveSafePath(UPLOADS_DIR, storedFilename);
      const sourceUrl = `/api/uploads/${encodeURIComponent(storedFilename)}`;

      const synth = await synthesizeSampleVideo(presetId, sourcePath);

      const project = store.createProject({
        id: projectId,
        title: synth.title,
        sourceFilename: synth.filename,
        sourcePath,
        sourceUrl,
      });

      void runProjectPipeline(projectId);
      res.status(201).json({ project });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to synthesize sample video';
      res.status(500).json({ error: msg });
    }
  });

  // Get single project + highlights
  app.get('/api/projects/:id', (req, res) => {
    const project = store.getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    const highlights = store.listHighlights(project.id);
    res.json({ project, highlights });
  });

  // Delete project and local artifacts
  app.delete('/api/projects/:id', (req, res) => {
    const internal = store.getProjectInternal(req.params.id);
    if (!internal) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    store.deleteProject(internal.id);
    try {
      if (internal.sourcePath && fs.existsSync(internal.sourcePath)) {
        fs.unlinkSync(internal.sourcePath);
      }
      const pDir = resolveSafePath(PROJECTS_DIR, internal.id);
      if (fs.existsSync(pDir)) {
        fs.rmSync(pDir, { recursive: true, force: true });
      }
    } catch {
      // Best-effort cleanup
    }
    res.json({ ok: true });
  });

  // Retry a failed or stalled pipeline
  app.post('/api/projects/:id/retry', (req, res) => {
    const project = store.getProjectInternal(req.params.id);
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    store.updateProjectStage(project.id, 'queued', 0, 'Retrying pipeline...', 'processing', null);

    if (project.youtubeVideoId && !project.hasLocalVideoFile) {
      void runYouTubePipeline({
        projectId: project.id,
        canonicalUrl: `https://www.youtube.com/watch?v=${project.youtubeVideoId}`,
        videoId: project.youtubeVideoId,
        outputMp4Path: project.sourcePath,
        sourceUrl: project.sourceUrl,
        sourceFilename: project.sourceFilename,
        hasCustomTitle: true,
      });
    } else {
      void runProjectPipeline(project.id);
    }

    res.json({ project: store.getProject(project.id) });
  });

  // Review or override automatic category detection & editing profile
  app.patch('/api/projects/:id/analysis', (req, res) => {
    const project = store.getProjectInternal(req.params.id);
    if (!project || !project.analysis) {
      res.status(404).json({ error: 'Project analysis not found' });
      return;
    }

    const settings = store.getSettings();
    const { primaryCategoryId, recommendedProfile } = req.body as {
      primaryCategoryId?: string;
      recommendedProfile?: EditingProfileId;
    };

    const nextCategory = primaryCategoryId
      ? findCategoryByIdOrName(primaryCategoryId, settings.customCategories)
      : findCategoryByIdOrName(project.analysis.primaryCategoryId, settings.customCategories);

    const nextProfile =
      recommendedProfile && EDITING_PROFILES[recommendedProfile]
        ? recommendedProfile
        : nextCategory.defaultEditingProfile;

    const updatedAnalysis = {
      ...project.analysis,
      primaryCategoryId: nextCategory.id,
      primaryCategoryName: nextCategory.name,
      recommendedProfile: nextProfile,
      userOverriddenCategory: true,
    };

    store.saveAnalysis(project.id, updatedAnalysis);
    res.json({ analysis: updatedAnalysis });
  });

  // Re-run Highlight Agent with updated category/settings
  app.post('/api/projects/:id/reanalyze-highlights', async (req, res) => {
    try {
      const project = store.getProjectInternal(req.params.id);
      if (!project || !project.analysis || !project.metadata) {
        res.status(404).json({ error: 'Project is not ready for highlight extraction.' });
        return;
      }

      const settings = store.getSettings();
      const highlights = await generateAndScoreHighlights({
        projectId: project.id,
        title: project.title,
        metadata: project.metadata,
        transcript: project.transcript,
        analysis: project.analysis,
        settings,
        sourcePath: project.hasLocalVideoFile ? project.sourcePath : undefined,
      });

      store.replaceProjectHighlights(project.id, highlights);
      res.json({ highlights });
    } catch (err) {
      const msg = formatGeminiError(err) || 'Highlight re-analysis failed';
      res.status(500).json({ error: msg });
    }
  });

  // Update highlight selection, trim boundaries, or editing controls
  app.patch('/api/highlights/:id', (req, res) => {
    const existing = store.getHighlightInternal(req.params.id);
    if (!existing) {
      res.status(404).json({ error: 'Highlight not found' });
      return;
    }

    const body = req.body as Partial<HighlightRecord>;
    const patch: Parameters<typeof store.updateHighlight>[1] = {};

    if (typeof body.startTime === 'number' && body.startTime >= 0) {
      patch.startTime = Number(body.startTime.toFixed(2));
    }
    if (typeof body.endTime === 'number' && body.endTime > (patch.startTime ?? existing.startTime)) {
      patch.endTime = Number(body.endTime.toFixed(2));
    }
    if (typeof body.title === 'string' && body.title.trim()) {
      patch.title = body.title.trim();
    }
    if (typeof body.hookHeadline === 'string') {
      patch.hookHeadline = body.hookHeadline.trim();
    }
    if (typeof body.description === 'string') {
      patch.description = body.description.trim();
    }
    if (body.status && ['candidate', 'selected', 'rejected', 'rendered', 'exported'].includes(body.status)) {
      patch.status = body.status;
    }
    if (body.editingProfile && EDITING_PROFILES[body.editingProfile]) {
      patch.editingProfile = body.editingProfile;
      // Also apply profile defaults when explicitly switching profile unless overridden in same request
      if (body.subtitleStyle === undefined) {
        patch.subtitleStyle = EDITING_PROFILES[body.editingProfile].subtitlePreset;
      }
      if (body.highlightColor === undefined) {
        patch.highlightColor = EDITING_PROFILES[body.editingProfile].highlightColorHex;
      }
      if (body.cropMode === undefined) {
        patch.cropMode = EDITING_PROFILES[body.editingProfile].cropMode;
      }
      if (body.dynamicZoom === undefined) {
        patch.dynamicZoom = EDITING_PROFILES[body.editingProfile].allowDynamicZoom;
      }
    }
    if (body.subtitleStyle) patch.subtitleStyle = body.subtitleStyle;
    if (body.highlightColor) patch.highlightColor = body.highlightColor;
    if (body.cropMode) patch.cropMode = body.cropMode;
    if (typeof body.dynamicZoom === 'boolean') patch.dynamicZoom = body.dynamicZoom;
    if (typeof body.normalizeAudio === 'boolean') patch.normalizeAudio = body.normalizeAudio;
    if (typeof body.watermarkEnabled === 'boolean') patch.watermarkEnabled = body.watermarkEnabled;

    const affectsRender =
      (patch.startTime !== undefined && patch.startTime !== existing.startTime) ||
      (patch.endTime !== undefined && patch.endTime !== existing.endTime) ||
      (patch.hookHeadline !== undefined && patch.hookHeadline !== (existing.hookHeadline ?? '')) ||
      (patch.editingProfile !== undefined && patch.editingProfile !== existing.editingProfile) ||
      (patch.subtitleStyle !== undefined && patch.subtitleStyle !== existing.subtitleStyle) ||
      (patch.highlightColor !== undefined && patch.highlightColor !== existing.highlightColor) ||
      (patch.cropMode !== undefined && patch.cropMode !== existing.cropMode) ||
      (patch.dynamicZoom !== undefined && patch.dynamicZoom !== existing.dynamicZoom) ||
      (patch.normalizeAudio !== undefined && patch.normalizeAudio !== existing.normalizeAudio) ||
      (patch.watermarkEnabled !== undefined && patch.watermarkEnabled !== existing.watermarkEnabled);

    if (affectsRender) {
      patch.renderedVideoPath = null;
      patch.renderedVideoUrl = null;
      patch.qcReport = null;
    }

    const updated = store.updateHighlight(existing.id, patch);
    res.json({ highlight: updated });
  });

  // Deduplicate concurrent FFmpeg renders per highlightId so duplicate clicks/exports never corrupt output
  type LockedRenderResult = {
    highlight: HighlightRecord;
    renderedPath: string;
    qcReport: NonNullable<HighlightRecord['qcReport']>;
  };
  const activeRenderJobs = new Map<string, Promise<LockedRenderResult>>();

  const renderHighlightWithLock = async (highlightId: string): Promise<LockedRenderResult> => {
    const existingJob = activeRenderJobs.get(highlightId);
    if (existingJob) {
      return existingJob;
    }

    const job = (async () => {
      const hl = store.getHighlightInternal(highlightId);
      if (!hl) {
        throw Object.assign(new Error('Highlight not found'), { statusCode: 404 });
      }
      const project = store.getProjectInternal(hl.projectId);
      if (!project) {
        throw Object.assign(new Error('Parent project not found'), { statusCode: 404 });
      }
      if (!project.hasLocalVideoFile || !fs.existsSync(project.sourcePath)) {
        throw Object.assign(
          new Error(
            'This project does not have a local MP4 file on disk. Attach a local MP4 or retry YouTube download with cookies before rendering or exporting.'
          ),
          { statusCode: 400 }
        );
      }

      const settings = store.getSettings();
      const rendered = await renderAdaptiveClip({
        projectId: project.id,
        sourcePath: project.sourcePath,
        metadata: project.metadata,
        highlight: hl,
        transcript: project.transcript,
        settings,
        languageCode: project.analysis?.languageCode || 'en',
      });

      const qcReport = await validateRenderedClip({
        renderedPath: rendered.outputPath,
        highlight: hl,
        transcript: project.transcript,
        sourceMetadata: project.metadata,
        settings,
      });

      const updated = store.updateHighlight(hl.id, {
        status: hl.status === 'exported' ? 'exported' : 'rendered',
        renderedVideoPath: rendered.outputPath,
        renderedVideoUrl: rendered.outputUrl,
        qcReport,
      });

      if (!updated) {
        throw new Error('Failed to save rendered highlight metadata.');
      }

      return {
        highlight: updated,
        renderedPath: rendered.outputPath,
        qcReport,
      };
    })();

    activeRenderJobs.set(highlightId, job);
    try {
      return await job;
    } finally {
      activeRenderJobs.delete(highlightId);
    }
  };

  // Voice-aligned 2-4 word subtitle cues for exact live preview & rendering sync
  app.get('/api/highlights/:id/aligned-subtitles', async (req, res) => {
    try {
      const hl = store.getHighlightInternal(req.params.id);
      if (!hl) {
        res.status(404).json({ error: 'Highlight not found' });
        return;
      }
      const project = store.getProjectInternal(hl.projectId);
      if (!project) {
        res.status(404).json({ error: 'Parent project not found' });
        return;
      }

      if (!project.hasLocalVideoFile || !fs.existsSync(project.sourcePath) || project.metadata?.hasAudio === false) {
        const clipDur = Math.max(1, hl.endTime - hl.startTime);
        const cues = project.transcript
          .filter((s) => s.end > hl.startTime && s.start < hl.endTime)
          .map((s) => ({
            start: Number(Math.max(0, s.start - hl.startTime).toFixed(2)),
            end: Number(Math.min(clipDur, s.end - hl.startTime).toFixed(2)),
            speaker: s.speaker,
            text: s.text,
          }));
        res.json({ cues });
        return;
      }

      const startQ = Number(req.query.start);
      const endQ = Number(req.query.end);
      const startTime = Number.isFinite(startQ) && startQ >= 0 ? startQ : hl.startTime;
      const endTime = Number.isFinite(endQ) && endQ > startTime ? endQ : hl.endTime;

      const { alignClipSubtitlesWithAudio } = await import('./src/server/agents/transcriptionAgent');
      const cues = await alignClipSubtitlesWithAudio({
        projectId: project.id,
        sourcePath: project.sourcePath,
        highlightId: hl.id,
        startTime,
        endTime,
        fallbackTranscript: project.transcript,
        languageHint: project.analysis?.languageCode || 'en',
      });
      res.json({ cues });
    } catch (err) {
      const msg = formatGeminiError(err) || 'Failed to align clip subtitles';
      res.status(500).json({ error: msg });
    }
  });

  // Render vertical 9:16 1080x1920 clip with FFmpeg & run Quality Control Agent
  app.post('/api/highlights/:id/render', async (req, res) => {
    try {
      const result = await renderHighlightWithLock(req.params.id);
      res.json({ highlight: result.highlight, qcReport: result.qcReport });
    } catch (err) {
      const status = (err as { statusCode?: number })?.statusCode || 500;
      const msg = formatGeminiError(err) || (err instanceof Error ? err.message : 'FFmpeg clip rendering failed');
      res.status(status).json({ error: msg });
    }
  });

  // Auto-regenerate clip when Quality Control detects a fixable issue
  app.post('/api/highlights/:id/auto-heal', async (req, res) => {
    try {
      const inFlight = activeRenderJobs.get(req.params.id);
      if (inFlight) {
        await inFlight;
      }

      const hl = store.getHighlightInternal(req.params.id);
      if (!hl) {
        res.status(404).json({ error: 'Highlight not found' });
        return;
      }
      const project = store.getProjectInternal(hl.projectId);
      if (!project) {
        res.status(404).json({ error: 'Parent project not found' });
        return;
      }
      if (!project.hasLocalVideoFile || !fs.existsSync(project.sourcePath)) {
        res.status(400).json({ error: 'Local source video file is required to regenerate clip.' });
        return;
      }

      const settings = store.getSettings();
      const healJob = autoHealAndRegenerateClip({
        projectId: project.id,
        sourcePath: project.sourcePath,
        sourceMetadata: project.metadata,
        highlight: hl,
        transcript: project.transcript,
        settings,
        languageCode: project.analysis?.languageCode || 'en',
      }).then((healed) => {
        const updated = store.updateHighlight(hl.id, {
          ...healed.patchedHighlight,
          status: 'rendered',
          renderedVideoPath: healed.renderedPath,
          renderedVideoUrl: healed.renderedUrl,
          qcReport: healed.qcReport,
        });
        if (!updated) throw new Error('Failed to persist regenerated highlight.');
        return {
          highlight: updated,
          renderedPath: healed.renderedPath,
          qcReport: healed.qcReport,
        };
      });

      activeRenderJobs.set(hl.id, healJob);
      try {
        const result = await healJob;
        res.json({ highlight: result.highlight, qcReport: result.qcReport });
      } finally {
        activeRenderJobs.delete(hl.id);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Auto-regeneration failed';
      res.status(500).json({ error: msg });
    }
  });

  // Export single clip locally with platform titles/descriptions/hashtags and metadata.json
  app.post('/api/highlights/:id/export', async (req, res) => {
    try {
      let hl = store.getHighlightInternal(req.params.id);
      if (!hl) {
        res.status(404).json({ error: 'Highlight not found' });
        return;
      }
      const project = store.getProjectInternal(hl.projectId);
      if (!project) {
        res.status(404).json({ error: 'Parent project not found' });
        return;
      }
      if (!project.hasLocalVideoFile || !fs.existsSync(project.sourcePath)) {
        res.status(400).json({
          error:
            'Attach a local MP4 or retry YouTube download with cookies before exporting rendered MP4 files.',
        });
        return;
      }

      const inFlight = activeRenderJobs.get(hl.id);
      if (inFlight) {
        await inFlight;
        hl = store.getHighlightInternal(hl.id)!;
      }

      let renderedPath = hl.renderedVideoPath;
      const hasValidRender =
        renderedPath && fs.existsSync(renderedPath) && fs.statSync(renderedPath).size > 1024;

      if (!hasValidRender) {
        const rendered = await renderHighlightWithLock(hl.id);
        renderedPath = rendered.renderedPath;
        hl = store.getHighlightInternal(hl.id)!;
      }

      const exportData = await exportClipLocally({
        project,
        highlight: hl,
        renderedVideoPath: renderedPath!,
      });

      const savedExport = store.createExport(exportData);
      const updatedHighlight = store.updateHighlight(hl.id, { status: 'exported' });

      res.json({ exportRecord: savedExport, highlight: updatedHighlight });
    } catch (err) {
      const status = (err as { statusCode?: number })?.statusCode || 500;
      const msg = formatGeminiError(err) || 'Export failed';
      res.status(status).json({ error: msg });
    }
  });

  // Batch export multiple highlights
  app.post('/api/exports/batch', async (req, res) => {
    try {
      const highlightIds = Array.isArray(req.body?.highlightIds)
        ? (req.body.highlightIds as string[])
        : [];
      if (highlightIds.length === 0) {
        res.status(400).json({ error: 'Select at least one highlight to export.' });
        return;
      }

      const createdExports = [];

      for (const id of highlightIds) {
        let hl = store.getHighlightInternal(id);
        if (!hl) continue;
        const project = store.getProjectInternal(hl.projectId);
        if (!project) continue;
        if (!project.hasLocalVideoFile || !fs.existsSync(project.sourcePath)) {
          throw Object.assign(
            new Error(`Project "${project.title}" has no local video file on disk for rendering.`),
            { statusCode: 400 }
          );
        }

        const inFlight = activeRenderJobs.get(hl.id);
        if (inFlight) {
          await inFlight;
          hl = store.getHighlightInternal(hl.id)!;
        }

        let renderedPath = hl.renderedVideoPath;
        const hasValidRender =
          renderedPath && fs.existsSync(renderedPath) && fs.statSync(renderedPath).size > 1024;

        if (!hasValidRender) {
          const rendered = await renderHighlightWithLock(hl.id);
          renderedPath = rendered.renderedPath;
          hl = store.getHighlightInternal(hl.id)!;
        }

        const exportData = await exportClipLocally({
          project,
          highlight: hl,
          renderedVideoPath: renderedPath!,
        });
        createdExports.push(store.createExport(exportData));
        store.updateHighlight(hl.id, { status: 'exported' });
      }

      res.json({ exports: createdExports });
    } catch (err) {
      const status = (err as { statusCode?: number })?.statusCode || 500;
      const msg = formatGeminiError(err) || 'Batch export failed';
      res.status(status).json({ error: msg });
    }
  });

  // Save Studio Settings & Custom Categories
  app.put('/api/settings', (req, res) => {
    try {
      const incoming = req.body as StudioSettings;
      const saved = store.saveSettings(incoming);
      res.json({ settings: saved });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to save settings';
      res.status(400).json({ error: msg });
    }
  });

  // Safe local file streaming routes with strict path confinement
  app.get('/api/uploads/:filename', (req, res) => {
    try {
      const filePath = resolveSafePath(UPLOADS_DIR, path.basename(req.params.filename));
      if (!fs.existsSync(filePath)) {
        res.status(404).end();
        return;
      }
      res.sendFile(filePath);
    } catch {
      res.status(403).end();
    }
  });

  app.get('/api/projects/:id/scenes/:filename', (req, res) => {
    try {
      const filePath = resolveSafePath(
        PROJECTS_DIR,
        path.basename(req.params.id),
        'scenes',
        path.basename(req.params.filename)
      );
      if (!fs.existsSync(filePath)) {
        res.status(404).end();
        return;
      }
      res.sendFile(filePath);
    } catch {
      res.status(403).end();
    }
  });

  app.get('/api/projects/:id/renders/:filename', (req, res) => {
    try {
      const filePath = resolveSafePath(
        PROJECTS_DIR,
        path.basename(req.params.id),
        'renders',
        path.basename(req.params.filename)
      );
      if (!fs.existsSync(filePath)) {
        res.status(404).end();
        return;
      }
      res.sendFile(filePath);
    } catch {
      res.status(403).end();
    }
  });

  app.get('/api/exports/files/:projectSlug/:categorySlug/:filename', (req, res) => {
    try {
      const filePath = resolveSafePath(
        EXPORTS_DIR,
        path.basename(req.params.projectSlug),
        path.basename(req.params.categorySlug),
        path.basename(req.params.filename)
      );
      if (!fs.existsSync(filePath)) {
        res.status(404).end();
        return;
      }
      if (req.query.download === '1') {
        res.download(filePath);
        return;
      }
      res.sendFile(filePath);
    } catch {
      res.status(403).end();
    }
  });

  // API error handler (e.g. Multer upload validation errors)
  app.use('/api', (err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(400).json({ error: err.message || 'Request failed' });
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`ClipForge Local Studio listening on http://localhost:${PORT}`);
  });
}

startServer();
