import { ThinkingLevel, Type } from '@google/genai';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type {
  ExportPlatformPack,
  ExportRecord,
  HighlightRecord,
  ProjectRecord,
} from '../../types/studio';
import { EXPORTS_DIR, resolveSafePath, slugify } from '../db';
import { getGeminiClient, withModelFallback } from '../geminiClient';
import { probeVideoMetadata } from './videoIngestionAgent';

export async function generateSocialPlatformMetadata(params: {
  projectTitle: string;
  highlight: HighlightRecord;
  language: string;
}): Promise<ExportPlatformPack> {
  const { projectTitle, highlight, language } = params;
  const ai = getGeminiClient();

  const response = await withModelFallback(
    ['gemini-4-hydrogen', 'gemini-3.1-flash-lite'],
    (model) =>
      ai.models.generateContent({
        model,
        contents: `Generate platform-ready titles, descriptions, and hashtags for a short vertical video clip.
Clip Title: "${highlight.title}"
Clip Description: "${highlight.description}"
Source Video: "${projectTitle}"
Category: "${highlight.categoryName}"
Keywords: ${highlight.keywords.join(', ')}
Language: ${language}

Tailor copy natively for:
1. TikTok (punchy hook title, conversational caption, 4-5 relevant hashtags)
2. Instagram Reels (clean title, engaging value summary, 5-6 hashtags)
3. YouTube Shorts (searchable crisp title under 70 chars, concise description, 3-5 hashtags)

Write in ${language}. Return valid JSON only.`,
        config: {
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            tiktok: {
              type: Type.OBJECT,
              properties: {
                title: { type: Type.STRING },
                description: { type: Type.STRING },
                hashtags: { type: Type.ARRAY, items: { type: Type.STRING } },
              },
              required: ['title', 'description', 'hashtags'],
            },
            reels: {
              type: Type.OBJECT,
              properties: {
                title: { type: Type.STRING },
                description: { type: Type.STRING },
                hashtags: { type: Type.ARRAY, items: { type: Type.STRING } },
              },
              required: ['title', 'description', 'hashtags'],
            },
            shorts: {
              type: Type.OBJECT,
              properties: {
                title: { type: Type.STRING },
                description: { type: Type.STRING },
                hashtags: { type: Type.ARRAY, items: { type: Type.STRING } },
              },
              required: ['title', 'description', 'hashtags'],
            },
          },
          required: ['tiktok', 'reels', 'shorts'],
        },
      },
    }),
    'export-metadata'
  );

  return JSON.parse((response.text ?? '{}').trim()) as ExportPlatformPack;
}

export async function exportClipLocally(params: {
  project: ProjectRecord;
  highlight: HighlightRecord;
  renderedVideoPath: string;
}): Promise<ExportRecord & { videoPath: string; metadataJsonPath: string }> {
  const { project, highlight, renderedVideoPath } = params;

  if (!fs.existsSync(renderedVideoPath)) {
    throw new Error('Clip must be rendered before exporting.');
  }

  const probe = await probeVideoMetadata(renderedVideoPath);
  const language = project.analysis?.detectedLanguage || 'English';
  const platforms = await generateSocialPlatformMetadata({
    projectTitle: project.title,
    highlight,
    language,
  });

  const projectSlug = slugify(project.title);
  const categorySlug = slugify(highlight.categoryName);
  const clipSlug = `${slugify(highlight.title)}_${highlight.id.slice(-4)}`;

  const exportFolder = resolveSafePath(EXPORTS_DIR, projectSlug, categorySlug);
  fs.mkdirSync(exportFolder, { recursive: true });

  const mp4Filename = `${clipSlug}.mp4`;
  const jsonFilename = `${clipSlug}.metadata.json`;
  const videoPath = resolveSafePath(exportFolder, mp4Filename);
  const metadataJsonPath = resolveSafePath(exportFolder, jsonFilename);

  fs.copyFileSync(renderedVideoPath, videoPath);

  const exportId = `exp_${crypto.randomUUID().slice(0, 8)}`;
  const createdAt = new Date().toISOString();
  const relDir = path.relative(process.cwd(), exportFolder);

  const metadataPayload = {
    exportId,
    projectId: project.id,
    projectTitle: project.title,
    highlightId: highlight.id,
    title: highlight.title,
    description: highlight.description,
    category: highlight.categoryName,
    secondaryCategory: highlight.secondaryCategoryName,
    editingProfile: highlight.editingProfile,
    timestamps: {
      start: highlight.startTime,
      end: highlight.endTime,
      duration: probe.duration,
    },
    technicalSpec: {
      resolution: `${probe.width}x${probe.height}`,
      videoCodec: probe.videoCodec,
      audioCodec: probe.audioCodec,
      fps: probe.fps,
      fileSizeBytes: probe.fileSize,
    },
    criteriaBreakdown: highlight.criteriaBreakdown,
    selectionExplanation: highlight.selectionExplanation,
    platforms,
    createdAt,
  };

  fs.writeFileSync(metadataJsonPath, JSON.stringify(metadataPayload, null, 2), 'utf-8');

  const urlBase = `/api/exports/files/${encodeURIComponent(projectSlug)}/${encodeURIComponent(
    categorySlug
  )}`;

  return {
    id: exportId,
    projectId: project.id,
    projectTitle: project.title,
    highlightId: highlight.id,
    clipTitle: highlight.title,
    categoryId: highlight.categoryId,
    categoryName: highlight.categoryName,
    editingProfile: highlight.editingProfile,
    videoPath,
    videoUrl: `${urlBase}/${encodeURIComponent(mp4Filename)}`,
    metadataJsonPath,
    metadataJsonUrl: `${urlBase}/${encodeURIComponent(jsonFilename)}`,
    outputDir: relDir,
    resolution: `${probe.width}×${probe.height}`,
    duration: probe.duration,
    fileSize: probe.fileSize,
    platforms,
    createdAt,
  };
}
