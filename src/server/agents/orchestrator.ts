import type { VideoMetadata } from '../../types/studio';
import { store } from '../db';
import { analyzeVideoContent } from './contentUnderstandingAgent';
import { generateAndScoreHighlights } from './highlightAgent';
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
      metadata: fallbackMetadata,
      transcript: ytTranscript.segments,
      analysis,
      settings,
    });

    store.replaceProjectHighlights(projectId, highlights);

    store.updateProjectStage(
      projectId,
      'completed',
      100,
      `Analyzed via YouTube URL (${highlights.length} highlights). Attach local MP4 or retry with YouTube cookies in Editor to render 1080×1920 exports.`,
      'ready',
      null
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'YouTube import failed.';
    store.updateProjectStage(projectId, 'failed', 0, message, 'error', message);
  }
}

export async function runProjectPipeline(projectId: string): Promise<void> {
  const project = store.getProjectInternal(projectId);
  if (!project) return;

  const settings = store.getSettings();

  try {
    // Stage 1: Video Ingestion (FFprobe + Audio extraction + Scene keyframes)
    store.updateProjectStage(
      projectId,
      'ingesting',
      15,
      'Validating video streams with FFprobe and extracting audio & scene keyframes...'
    );

    const metadata = await probeVideoMetadata(project.sourcePath);
    const audioPath = metadata.hasAudio
      ? await extractAudioTrack(project.sourcePath, projectId)
      : null;
    const scenes = await extractSceneKeyframes(project.sourcePath, projectId, metadata.duration);

    store.saveIngestionData(projectId, metadata, audioPath, scenes);

    // Stage 2: Transcription Agent
    store.updateProjectStage(
      projectId,
      'transcribing',
      40,
      'Generating timestamped transcript with sentence boundaries and speaker labels...'
    );

    const { segments } = audioPath
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

    store.saveTranscript(projectId, segments);

    // Stage 3: Content Understanding & Category Classification Agent
    store.updateProjectStage(
      projectId,
      'analyzing',
      68,
      'Analyzing topics, speaker context, scenes, and multi-label content categories...'
    );

    const analysis = await analyzeVideoContent({
      projectId,
      title: project.title,
      metadata,
      transcript: segments,
      scenes,
      customCategories: settings.customCategories,
    });

    store.saveAnalysis(projectId, analysis);

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
      metadata,
      transcript: segments,
      analysis,
      settings,
    });

    store.replaceProjectHighlights(projectId, highlights);

    store.updateProjectStage(
      projectId,
      'completed',
      100,
      `Pipeline complete: ${highlights.length} highlight candidates scored.`,
      'ready',
      null
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Pipeline execution failed.';
    store.updateProjectStage(projectId, 'failed', 0, message, 'error', message);
  }
}
