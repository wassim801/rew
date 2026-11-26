import { ThinkingLevel, Type } from '@google/genai';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type {
  ExportPlatformPack,
  ExportRecord,
  ProjectRecord,
} from '../../types/studio';
import { EXPORTS_DIR, type HighlightRowInternal, resolveSafePath, slugify } from '../db';
import { getGeminiClient, withModelFallback } from '../geminiClient';
import { generateHighlightThumbnail } from './thumbnailAgent';
import { probeVideoMetadata } from './videoIngestionAgent';

export async function generateSocialPlatformMetadata(params: {
  projectTitle: string;
  highlight: HighlightRowInternal;
  language: string;
  brief?: string;
}): Promise<ExportPlatformPack> {
  const { projectTitle, highlight, language, brief } = params;
  const ai = getGeminiClient();

  const cleanBrief = brief?.trim() || '';
  const briefRuleBlock = cleanBrief
    ? `\nCAMPAIGN CONSIGNE / TAGGING & CAPTION RULES (STRICT COMPLIANCE REQUIRED):\n"""\n${cleanBrief}\n"""\nIMPORTANT: Strictly honor every @handle mention rule (e.g., platform-specific @tags), language requirement, banned/excluded people or tags ("DO NOT tag ..."), and product/brand name mention rules from the consigne above.\n`
    : '';

  const response = await withModelFallback(
    ['gemini-4-hydrogen', 'gemini-3.1-flash-lite'],
    (model) =>
      ai.models.generateContent({
        model,
        contents: `Generate platform-ready titles, descriptions, and hashtags for a short vertical video clip.
Clip Title: "${highlight.title}"
Hook Headline: "${highlight.hookHeadline || highlight.title}"
Clip Description: "${highlight.description}"
Source Project: "${projectTitle}"
Category: "${highlight.categoryName}"
Keywords: ${highlight.keywords.join(', ')}
Detected Video Language: ${language}
${briefRuleBlock}
Tailor copy natively for:
1. TikTok (punchy hook title, conversational caption with required TikTok @tags if any, 4-5 relevant hashtags)
2. Instagram Reels (clean title, engaging caption with required IG @tags if any, 5-6 hashtags)
3. YouTube Shorts (searchable crisp title under 70 chars, concise description with required YT @tags if any, 3-5 hashtags)

Follow any language override in the Campaign Consigne (otherwise write in ${language}). Return valid JSON only.`,
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
  highlight: HighlightRowInternal;
  renderedVideoPath: string;
  sourcePath?: string;
  sources?: ProjectRecord['sources'];
}): Promise<ExportRecord & { videoPath: string; metadataJsonPath: string }> {
  const { project, highlight, renderedVideoPath, sourcePath, sources } = params;

  if (!fs.existsSync(renderedVideoPath)) {
    throw new Error('Clip must be rendered before exporting.');
  }

  const probe = await probeVideoMetadata(renderedVideoPath);
  const language = project.analysis?.detectedLanguage || 'English';
  const platforms = await generateSocialPlatformMetadata({
    projectTitle: project.title,
    highlight,
    language,
    brief: project.brief,
  });

  const projectSlug = slugify(project.title);
  const categorySlug = slugify(highlight.categoryName);
  const clipSlug = `${slugify(highlight.title)}_${highlight.id.slice(-4)}`;

  const exportFolder = resolveSafePath(EXPORTS_DIR, projectSlug, categorySlug);
  fs.mkdirSync(exportFolder, { recursive: true });

  const mp4Filename = `${clipSlug}.mp4`;
  const thumbFilename = `${clipSlug}.thumbnail.jpg`;
  const jsonFilename = `${clipSlug}.metadata.json`;
  const videoPath = resolveSafePath(exportFolder, mp4Filename);
  const exportThumbPath = resolveSafePath(exportFolder, thumbFilename);
  const metadataJsonPath = resolveSafePath(exportFolder, jsonFilename);

  fs.copyFileSync(renderedVideoPath, videoPath);

  let exportedThumbnailUrl: string | null = null;
  let sourceThumbPath = highlight.thumbnailPath;
  if (!sourceThumbPath || !fs.existsSync(sourceThumbPath)) {
    try {
      const gen = await generateHighlightThumbnail({
        projectId: project.id,
        highlight,
        sourcePath: sourcePath ?? renderedVideoPath,
        sources: sources ?? project.sources,
        scenes: project.scenes,
        projectBrief: project.brief,
        durationFallback: project.metadata?.duration,
      });
      sourceThumbPath = gen.thumbnailPath;
    } catch {
      sourceThumbPath = null;
    }
  }
  if (sourceThumbPath && fs.existsSync(sourceThumbPath)) {
    fs.copyFileSync(sourceThumbPath, exportThumbPath);
    exportedThumbnailUrl = `${`/api/exports/files/${encodeURIComponent(
      projectSlug
    )}/${encodeURIComponent(categorySlug)}`}/${encodeURIComponent(thumbFilename)}`;
  }

  const exportId = `exp_${crypto.randomUUID().slice(0, 8)}`;
  const createdAt = new Date().toISOString();
  const relDir = path.relative(process.cwd(), exportFolder);

  const urlBase = `/api/exports/files/${encodeURIComponent(projectSlug)}/${encodeURIComponent(
    categorySlug
  )}`;

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
    thumbnailUrl: exportedThumbnailUrl,
    thumbnailStyle: highlight.thumbnailStyle ?? 'auto',
    thumbnailText: highlight.thumbnailText ?? null,
    thumbnailEmojis: highlight.thumbnailEmojis ?? [],
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
    thumbnailUrl: exportedThumbnailUrl,
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
