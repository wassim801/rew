import fs from 'fs';
import type { VideoMetadata } from '../../types/studio';
import { store } from '../db';
import { formatGeminiError, isTransientGeminiError } from '../geminiClient';
import { analyzeVideoContent } from './contentUnderstandingAgent';
import { generateAndScoreHighlights } from './highlightAgent';
import { generateProjectHighlightThumbnails } from './thumbnailAgent';
import { transcribeProjectAudio } from './transcriptionAgent';
import {
  extractAudioTrack,
  extractSceneKeyframes,
  probeVideoMetadata,
} from './videoIngestionAgent';
import {
  downloadYouTubeThumbnail,
  downloadYouTubeVideo,
  isYouTubeBotCheckError,
  transcribeYouTubeUrlWithGemini,
} from './youtubeIngestionAgent';

const MAX_PIPELINE_RETRIES = 5;
const PIPELINE_RETRY_BASE_DELAY_MS = 10000; // 10 seconds

async function withPipelineAutoRetry<T>(
  fn: () => Promise<T>,
  projectId: string,
  label: string
): Promise<T> {
  let lastError: unknown;
  
  for (let attempt = 0; attempt <= MAX_PIPELINE_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      
      if (!isTransientGeminiError(err) || attempt === MAX_PIPELINE_RETRIES) {
        throw err;
      }
      
      const waitMs = Math.round(
        PIPELINE_RETRY_BASE_DELAY_MS * Math.pow(2, attempt) * (0.85 + Math.random() * 0.3)
      );
      
      console.log(
        `[Pipeline] ${label} attempt ${attempt + 1}/${MAX_PIPELINE_RETRIES + 1} interrupted by temporary spike; auto-retrying in ${waitMs}ms...`
      );

      store.updateProjectStage(
        projectId,
        'transcribing',
        0,
        `Gemini API temporarily busy. Auto-retrying in ${Math.round(waitMs / 1000)}s (attempt ${attempt + 2}/${MAX_PIPELINE_RETRIES + 1})...`,
        'processing',
        null
      );

      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  throw lastError;
}

export async function runYouTubePipeline(params: {
  projectId: string;
  canonicalUrl: string;
  videoId: string;
  outputMp4Path: string;
  sourceUrl: string;
  sourceFilename: string;
  cookie?: string;
  hasCustomTitle: boolean;
}): Promise<void> {
  const {
    projectId,
    canonicalUrl,
    videoId,
    outputMp4Path,
    sourceUrl,
    sourceFilename,
    cookie,
    hasCustomTitle,
  } = params;

  try {
    await withPipelineAutoRetry(async () => {
      store.updateProjectStage(
        projectId,
        'downloading',
        4,
        'Connecting to YouTube and resolving MP4 video stream...'
      );

      try {
        const { title } = await downloadYouTubeVideo({
          canonicalUrl,
          outputMp4Path,
          cookie,
          onProgress: (pct, detail) => {
            const mapped = Math.max(4, Math.min(14, Math.round(4 + (pct / 100) * 10)));
            store.updateProjectStage(projectId, 'downloading', mapped, detail);
          },
        });

        if (!hasCustomTitle && title) {
          store.updateProjectTitle(projectId, title);
        }

        store.updateProjectLocalMedia(projectId, {
          sourceFilename,
          sourcePath: outputMp4Path,
          sourceUrl,
          hasLocalVideoFile: true,
        });

        await runProjectPipeline(projectId);
        return;
      } catch (downloadErr) {
        // If YouTube bot-verification blocks unauthenticated cloud IP download and no cookie was supplied,
        // seamlessly fall back to Gemini's native YouTube URL multimodal analysis.
        if (!isYouTubeBotCheckError(downloadErr) || cookie?.trim()) {
          throw downloadErr;
        }
      }

      // Cloud IP Bot-Check Fallback: Gemini direct YouTube URL transcription + analysis + highlights
      const settings = store.getSettings();

      store.updateProjectStage(
        projectId,
        'transcribing',
        35,
        'YouTube blocked cloud stream download; analyzing video directly via Gemini multimodal YouTube URL...'
      );

      const scenes = await downloadYouTubeThumbnail(projectId, videoId);
      const ytTranscript = await transcribeYouTubeUrlWithGemini({
        projectId,
        canonicalUrl,
        languageHint: settings.defaultLanguageHint,
      });

      const fallbackMetadata: VideoMetadata = {
        duration: ytTranscript.estimatedDurationSec,
        width: 1280,
        height: 720,
        fps: 30,
        videoCodec: 'h264',
        audioCodec: 'aac',
        bitrate: 0,
        fileSize: 0,
        formatName: 'youtube-stream',
        hasAudio: true,
      };

      store.saveIngestionData(projectId, fallbackMetadata, null, scenes);
      store.saveTranscript(projectId, ytTranscript.segments);

      store.updateProjectStage(
        projectId,
        'analyzing',
        68,
        'Analyzing topics, speaker context, and multi-label content categories...'
      );

      const project = store.getProjectInternal(projectId)!;
      const analysis = await analyzeVideoContent({
        projectId,
        title: project.title,
        brief: project.brief,
        metadata: fallbackMetadata,
        transcript: ytTranscript.segments,
        scenes,
        customCategories: settings.customCategories,
      });

      store.saveAnalysis(projectId, analysis);

      store.updateProjectStage(
        projectId,
        'extracting_highlights',
        88,
        `Scoring candidate clips using ${analysis.primaryCategoryName} selection strategy...`
      );

      const highlights = await generateAndScoreHighlights({
        projectId,
        title: project.title,
        brief: project.brief,
        metadata: fallbackMetadata,
        transcript: ytTranscript.segments,
        analysis,
        settings,
      });

      store.replaceProjectHighlights(projectId, highlights);

      store.updateProjectStage(
        projectId,
        'extracting_highlights',
        95,
        `Designing vibe-matched cover thumbnails for ${highlights.length} highlights...`
      );
      await generateProjectHighlightThumbnails({
        projectId,
        highlights,
        scenes,
        projectBrief: project.brief,
        durationFallback: fallbackMetadata.duration,
        onEachComplete: (hlId, res) => {
          store.updateHighlight(hlId, {
            thumbnailPath: res.thumbnailPath,
            thumbnailUrl: res.thumbnailUrl,
            thumbnailText: res.thumbnailText,
            thumbnailEmojis: res.thumbnailEmojis,
            thumbnailStyle: res.thumbnailStyle,
            thumbnailTimestamp: res.thumbnailTimestamp,
          });
        },
      });

      store.updateProjectStage(
        projectId,
        'completed',
        100,
        `Analyzed via YouTube URL (${highlights.length} highlights with cover thumbnails). Attach local MP4 or retry with YouTube cookies in Editor to render 1080×1920 exports.`,
        'ready',
        null
      );
    }, projectId, 'YouTube pipeline');
  } catch (err) {
    const message = formatGeminiError(err) || 'YouTube import failed.';
    store.updateProjectStage(projectId, 'failed', 0, message, 'error', message);
  }
}

export async function runProjectPipeline(projectId: string): Promise<void> {
  if (!store.getProjectInternal(projectId)) return;

  const settings = store.getSettings();

  try {
    await withPipelineAutoRetry(async () => {
      const project = store.getProjectInternal(projectId);
      if (!project) return;
      // Multi-Source Mix-and-Match Remix Pipeline
      if (project.sources && project.sources.length > 1) {
        const updatedSources = project.sources.map((s) => ({ ...s }));
        const totalSources = updatedSources.length;

        // Stage 1: Per-source ingestion
        const allIngested = updatedSources.every(
          (s) =>
            Boolean(s.metadata) &&
            (!s.metadata?.hasAudio || (Boolean(s.audioPath) && fs.existsSync(s.audioPath!))) &&
            (s.scenes?.length ?? 0) > 0
        );

        if (!allIngested) {
          for (let i = 0; i < totalSources; i++) {
            const src = updatedSources[i];
            if (
              src.metadata &&
              (!src.metadata.hasAudio || (src.audioPath && fs.existsSync(src.audioPath))) &&
              (src.scenes?.length ?? 0) > 0
            ) {
              continue;
            }
            if (!src.sourcePath || !fs.existsSync(src.sourcePath)) {
              throw new Error(`Missing source video file for Clip #${src.index + 1} (${src.filename}).`);
            }
            store.updateProjectStage(
              projectId,
              'ingesting',
              Math.round(10 + ((i + 0.3) / totalSources) * 25),
              `Ingesting source clip ${i + 1}/${totalSources}: ${src.filename}...`
            );
            const srcMeta = await probeVideoMetadata(src.sourcePath);
            const srcAudio = srcMeta.hasAudio
              ? await extractAudioTrack(src.sourcePath, projectId, src.index)
              : null;
            const srcScenes = await extractSceneKeyframes(
              src.sourcePath,
              projectId,
              srcMeta.duration,
              src.index,
              src.filename
            );
            updatedSources[i] = {
              ...src,
              metadata: srcMeta,
              audioPath: srcAudio,
              scenes: srcScenes,
            };
          }
        } else {
          store.updateProjectStage(
            projectId,
            'ingesting',
            35,
            `Resuming from saved metadata & keyframes across ${totalSources} source clips...`
          );
        }

        const primaryMeta = updatedSources[0].metadata!;
        const mergedMetadata: VideoMetadata = {
          duration: Number(
            updatedSources.reduce((acc, s) => acc + (s.metadata?.duration ?? 0), 0).toFixed(2)
          ),
          width: primaryMeta.width,
          height: primaryMeta.height,
          fps: primaryMeta.fps,
          videoCodec: primaryMeta.videoCodec,
          audioCodec: primaryMeta.audioCodec,
          bitrate: primaryMeta.bitrate,
          fileSize: updatedSources.reduce((acc, s) => acc + (s.metadata?.fileSize ?? 0), 0),
          formatName: primaryMeta.formatName,
          hasAudio: updatedSources.some((s) => Boolean(s.metadata?.hasAudio)),
        };
        const mergedScenes = updatedSources.flatMap((s) => s.scenes ?? []);
        store.saveMultiSourceIngestion(projectId, updatedSources, mergedMetadata, mergedScenes);

        // Stage 2: Per-source transcription with checkpoint persistence
        for (let i = 0; i < totalSources; i++) {
          const src = updatedSources[i];
          if (src.transcript && src.transcript.length > 0) {
            continue;
          }
          if (!src.audioPath || !fs.existsSync(src.audioPath)) {
            updatedSources[i] = { ...src, transcript: [] };
            continue;
          }
          store.updateProjectStage(
            projectId,
            'transcribing',
            Math.round(38 + (i / totalSources) * 26),
            `Transcribing clip ${i + 1}/${totalSources} (${src.filename})...`
          );
          const transcribed = await transcribeProjectAudio({
            projectId,
            audioPath: src.audioPath,
            duration: src.metadata?.duration ?? 30,
            languageHint: settings.defaultLanguageHint,
            sourceIndex: src.index,
            sourceFilename: src.filename,
          });
          updatedSources[i] = { ...src, transcript: transcribed.segments };
          const partialMerged = updatedSources.flatMap((s) => s.transcript ?? []);
          store.saveMultiSourceTranscript(projectId, updatedSources, partialMerged);
        }

        const mergedTranscript = updatedSources.flatMap((s) => s.transcript ?? []);
        store.saveMultiSourceTranscript(projectId, updatedSources, mergedTranscript);

        // Stage 3: Multi-clip Content Understanding
        let analysis = project.analysis;
        if (!analysis) {
          store.updateProjectStage(
            projectId,
            'analyzing',
            70,
            `Analyzing all ${totalSources} clips & campaign consigne...`
          );
          analysis = await analyzeVideoContent({
            projectId,
            title: project.title,
            brief: project.brief,
            metadata: mergedMetadata,
            transcript: mergedTranscript,
            scenes: mergedScenes,
            customCategories: settings.customCategories,
            sources: updatedSources,
          });
          store.saveAnalysis(projectId, analysis);
        }

        // Stage 4: Mix-and-Match Remix Director
        store.updateProjectStage(
          projectId,
          'extracting_highlights',
          88,
          `Composing mix-and-match viral edits across ${totalSources} clips...`
        );

        const highlights = await generateAndScoreHighlights({
          projectId,
          title: project.title,
          brief: project.brief,
          metadata: mergedMetadata,
          transcript: mergedTranscript,
          analysis,
          settings,
          sources: updatedSources,
          scenes: mergedScenes,
        });

        store.replaceProjectHighlights(projectId, highlights);

        store.updateProjectStage(
          projectId,
          'extracting_highlights',
          95,
          `Designing vibe-matched cover thumbnails for ${highlights.length} remix videos...`
        );
        await generateProjectHighlightThumbnails({
          projectId,
          highlights,
          sources: updatedSources,
          scenes: mergedScenes,
          projectBrief: project.brief,
          durationFallback: mergedMetadata.duration,
          onEachComplete: (hlId, res) => {
            store.updateHighlight(hlId, {
              thumbnailPath: res.thumbnailPath,
              thumbnailUrl: res.thumbnailUrl,
              thumbnailText: res.thumbnailText,
              thumbnailEmojis: res.thumbnailEmojis,
              thumbnailStyle: res.thumbnailStyle,
              thumbnailTimestamp: res.thumbnailTimestamp,
            });
          },
        });

        store.updateProjectStage(
          projectId,
          'completed',
          100,
          `Multi-clip remix ready: ${highlights.length} viral mix-and-match videos & thumbnails composed from ${totalSources} sources.`,
          'ready',
          null
        );
        return;
      }

      // Stage 1: Single-Video Ingestion (FFprobe + Audio extraction + Scene keyframes)
      const hasCachedIngestion =
        Boolean(project.metadata) &&
        (!project.metadata?.hasAudio || (Boolean(project.audioPath) && fs.existsSync(project.audioPath!))) &&
        project.scenes.length > 0;

      let metadata: VideoMetadata;
      let audioPath: string | null;
      let scenes = project.scenes;

      if (hasCachedIngestion && project.metadata) {
        metadata = project.metadata;
        audioPath = project.audioPath;
        store.updateProjectStage(
          projectId,
          'ingesting',
          35,
          'Resuming from saved video metadata, audio track, and scene keyframes...'
        );
      } else {
        store.updateProjectStage(
          projectId,
          'ingesting',
          15,
          'Validating video streams with FFprobe and extracting audio & scene keyframes...'
        );

        metadata = await probeVideoMetadata(project.sourcePath);
        audioPath = metadata.hasAudio
          ? await extractAudioTrack(project.sourcePath, projectId)
          : null;
        scenes = await extractSceneKeyframes(project.sourcePath, projectId, metadata.duration);

        store.saveIngestionData(projectId, metadata, audioPath, scenes);
      }

      // Stage 2: Transcription Agent (reuses full transcript if saved, or resumes per-10m chunks on retry)
      let segments = project.transcript;
      if (segments.length > 0) {
        store.updateProjectStage(
          projectId,
          'transcribing',
          64,
          `Resuming with saved transcript (${segments.length} segments)...`
        );
      } else {
        store.updateProjectStage(
          projectId,
          'transcribing',
          40,
          'Generating timestamped transcript with sentence boundaries and speaker labels...'
        );

        const transcribed = audioPath
          ? await transcribeProjectAudio({
              projectId,
              audioPath,
              duration: metadata.duration,
              languageHint: settings.defaultLanguageHint,
              onChunkProgress: (completed, total) => {
                if (total > 1) {
                  const pct = Math.min(64, Math.round(40 + (completed / total) * 24));
                  store.updateProjectStage(
                    projectId,
                    'transcribing',
                    pct,
                    `Transcribed audio segment ${completed} of ${total}...`
                  );
                }
              },
            })
          : { segments: [] };

        segments = transcribed.segments;
        store.saveTranscript(projectId, segments);
      }

      // Stage 3: Content Understanding & Category Classification Agent
      let analysis = project.analysis;
      if (analysis) {
        store.updateProjectStage(
          projectId,
          'analyzing',
          84,
          `Resuming with saved ${analysis.primaryCategoryName} content analysis...`
        );
      } else {
        store.updateProjectStage(
          projectId,
          'analyzing',
          68,
          'Analyzing topics, speaker context, scenes, and multi-label content categories...'
        );

        analysis = await analyzeVideoContent({
          projectId,
          title: project.title,
          brief: project.brief,
          metadata,
          transcript: segments,
          scenes,
          customCategories: settings.customCategories,
        });

        store.saveAnalysis(projectId, analysis);
      }

      // Stage 4: Category-Specific Highlight Agent & Scoring Engine
      store.updateProjectStage(
        projectId,
        'extracting_highlights',
        88,
        `Scoring candidate clips using ${analysis.primaryCategoryName} selection strategy...`
      );

      const highlights = await generateAndScoreHighlights({
        projectId,
        title: project.title,
        brief: project.brief,
        metadata,
        transcript: segments,
        analysis,
        settings,
        sourcePath: project.sourcePath,
      });

      store.replaceProjectHighlights(projectId, highlights);

      store.updateProjectStage(
        projectId,
        'extracting_highlights',
        95,
        `Designing vibe-matched cover thumbnails for ${highlights.length} highlights...`
      );
      await generateProjectHighlightThumbnails({
        projectId,
        highlights,
        sourcePath: project.sourcePath,
        scenes,
        projectBrief: project.brief,
        durationFallback: metadata.duration,
        onEachComplete: (hlId, res) => {
          store.updateHighlight(hlId, {
            thumbnailPath: res.thumbnailPath,
            thumbnailUrl: res.thumbnailUrl,
            thumbnailText: res.thumbnailText,
            thumbnailEmojis: res.thumbnailEmojis,
            thumbnailStyle: res.thumbnailStyle,
            thumbnailTimestamp: res.thumbnailTimestamp,
          });
        },
      });

      store.updateProjectStage(
        projectId,
        'completed',
        100,
        `Pipeline complete: ${highlights.length} highlight candidates & cover thumbnails ready.`,
        'ready',
        null
      );
    }, projectId, 'Project pipeline');
  } catch (err) {
    const message = formatGeminiError(err) || 'Pipeline execution failed.';
    store.updateProjectStage(projectId, 'failed', 0, message, 'error', message);
  }
}
