import { ThinkingLevel, Type } from '@google/genai';
import fs from 'fs';
import type {
  CategoryConfig,
  ContentAnalysis,
  EditingProfileId,
  SceneKeyframe,
  TranscriptSegment,
  VideoMetadata,
} from '../../types/studio';
import { EDITING_PROFILES, findCategoryByIdOrName, getAllCategories } from '../categories';
import { PROJECTS_DIR, resolveSafePath } from '../db';
import { getGeminiClient, withModelFallback } from '../geminiClient';

const VALID_PROFILES = Object.keys(EDITING_PROFILES) as EditingProfileId[];

export async function analyzeVideoContent(params: {
  projectId: string;
  title: string;
  metadata: VideoMetadata;
  transcript: TranscriptSegment[];
  scenes: SceneKeyframe[];
  customCategories: CategoryConfig[];
}): Promise<ContentAnalysis> {
  const { projectId, title, metadata, transcript, scenes, customCategories } = params;
  const allCategories = getAllCategories(customCategories);
  const ai = getGeminiClient();

  const categoryCatalogText = allCategories
    .map((c) => `- id: "${c.id}" | name: "${c.name}" | description: ${c.description}`)
    .join('\n');

  const transcriptLines = transcript.map(
    (s) => `[${s.start.toFixed(1)}s - ${s.end.toFixed(1)}s] ${s.speaker}: ${s.text}`
  );
  let formattedTranscript = transcriptLines.join('\n');
  if (formattedTranscript.length > 120000 && transcriptLines.length > 200) {
    const stride = Math.ceil(formattedTranscript.length / 110000);
    const sampled = transcriptLines.filter(
      (_, idx) => idx < 40 || idx >= transcriptLines.length - 40 || idx % stride === 0
    );
    formattedTranscript = sampled.join('\n');
  }

  // Include up to 4 real extracted scene keyframes so the model inspects visual context too
  const parts: Array<
    { inlineData: { mimeType: string; data: string } } | { text: string }
  > = [];

  const scenesDir = resolveSafePath(PROJECTS_DIR, projectId, 'scenes');
  for (const scene of scenes.slice(0, 4)) {
    const filename = scene.thumbnailUrl.split('/').pop();
    if (filename) {
      const framePath = resolveSafePath(scenesDir, filename);
      if (fs.existsSync(framePath)) {
        parts.push({
          inlineData: {
            mimeType: 'image/jpeg',
            data: fs.readFileSync(framePath).toString('base64'),
          },
        });
      }
    }
  }

  parts.push({
    text: `You are the Content Understanding & Category Classification Agent for a local AI video clipping studio.
Analyze the video title, technical metadata, scene frames, and timestamped transcript below.

Video Title: "${title}"
Duration: ${metadata.duration.toFixed(1)}s | Resolution: ${metadata.width}x${metadata.height} | FPS: ${metadata.fps}

Supported Categories:
${categoryCatalogText}

Available Editing Profiles: ${VALID_PROFILES.join(', ')}

Rules:
1. Automatically determine the primary category AND any relevant secondary categories (with confidence 0-100).
2. Support mixed-category content honestly: never force a video into a single category if multiple domains apply; set isMixedContent=true and explain in uncertaintyNotes if classification spans multiple themes or is ambiguous.
3. Recommend the most suitable editing profile from the list without forcing flashy effects onto serious or educational material.
4. Detect primary spoken language and format (e.g., Two-Person Podcast, Solo Tutorial, Keynote Talk, Gameplay Commentary, Travel Vlog).

Transcript:
${formattedTranscript || '(No spoken dialogue detected — classify from visual frames and title)'}`,
  });

  const response = await withModelFallback(
    ['gemini-4-hydrogen', 'gemini-3.1-flash-lite'],
    (model) =>
      ai.models.generateContent({
        model,
        contents: { parts },
        config: {
          thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH },
          responseMimeType: 'application/json',
          responseSchema: {
          type: Type.OBJECT,
          properties: {
            primaryCategoryId: { type: Type.STRING },
            secondaryCategories: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  categoryId: { type: Type.STRING },
                  confidence: { type: Type.NUMBER },
                  rationale: { type: Type.STRING },
                },
                required: ['categoryId', 'confidence', 'rationale'],
              },
            },
            isMixedContent: { type: Type.BOOLEAN },
            uncertaintyNotes: { type: Type.STRING },
            mainTopics: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
            },
            targetAudience: { type: Type.STRING },
            detectedLanguage: { type: Type.STRING },
            languageCode: { type: Type.STRING },
            videoFormat: { type: Type.STRING },
            recommendedProfile: { type: Type.STRING },
            emotionalArc: { type: Type.STRING },
            structureNotes: { type: Type.STRING },
          },
          required: [
            'primaryCategoryId',
            'secondaryCategories',
            'isMixedContent',
            'uncertaintyNotes',
            'mainTopics',
            'targetAudience',
            'detectedLanguage',
            'languageCode',
            'videoFormat',
            'recommendedProfile',
            'emotionalArc',
            'structureNotes',
          ],
        },
      },
    }),
    'content-understanding'
  );

  const parsed = JSON.parse((response.text ?? '{}').trim()) as {
    primaryCategoryId: string;
    secondaryCategories: Array<{ categoryId: string; confidence: number; rationale: string }>;
    isMixedContent: boolean;
    uncertaintyNotes: string;
    mainTopics: string[];
    targetAudience: string;
    detectedLanguage: string;
    languageCode: string;
    videoFormat: string;
    recommendedProfile: string;
    emotionalArc: string;
    structureNotes: string;
  };

  const primaryCat = findCategoryByIdOrName(parsed.primaryCategoryId || 'general', customCategories);
  const recommendedProfile = VALID_PROFILES.includes(parsed.recommendedProfile as EditingProfileId)
    ? (parsed.recommendedProfile as EditingProfileId)
    : primaryCat.defaultEditingProfile;

  const secondaryCategories = (parsed.secondaryCategories || [])
    .map((sc) => {
      const matched = findCategoryByIdOrName(sc.categoryId, customCategories);
      return {
        categoryId: matched.id,
        categoryName: matched.name,
        confidence: Math.max(0, Math.min(100, Math.round(sc.confidence || 0))),
        rationale: sc.rationale || '',
      };
    })
    .filter((sc) => sc.categoryId !== primaryCat.id);

  return {
    primaryCategoryId: primaryCat.id,
    primaryCategoryName: primaryCat.name,
    secondaryCategories,
    isMixedContent: Boolean(parsed.isMixedContent || secondaryCategories.length > 0),
    uncertaintyNotes: parsed.uncertaintyNotes || 'High confidence classification.',
    mainTopics: Array.isArray(parsed.mainTopics) ? parsed.mainTopics.slice(0, 8) : [],
    targetAudience: parsed.targetAudience || 'General short-form viewers',
    detectedLanguage: parsed.detectedLanguage || 'English',
    languageCode: parsed.languageCode || transcript[0]?.language || 'en',
    videoFormat: parsed.videoFormat || 'Long-form Video',
    recommendedProfile,
    emotionalArc: parsed.emotionalArc || 'Steady informational pacing',
    structureNotes: parsed.structureNotes || 'Structured spoken segments',
    userOverriddenCategory: false,
  };
}
