import { ThinkingLevel, Type } from '@google/genai';
import fs from 'fs';
import type {
  CategoryConfig,
  ContentAnalysis,
  EditingProfileId,
  ProjectSourceVideo,
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
  brief?: string;
  metadata: VideoMetadata;
  transcript: TranscriptSegment[];
  scenes: SceneKeyframe[];
  customCategories: CategoryConfig[];
  sources?: ProjectSourceVideo[];
}): Promise<ContentAnalysis> {
  const { projectId, title, brief, metadata, transcript, scenes, customCategories, sources } = params;
  const allCategories = getAllCategories(customCategories);
  const ai = getGeminiClient();

  const categoryCatalogText = allCategories
    .map((c) => `- id: "${c.id}" | name: "${c.name}" | description: ${c.description}`)
    .join('\n');

  const isMultiSource = Boolean(sources && sources.length > 1);
  let formattedTranscript = '';
  if (isMultiSource && sources) {
    formattedTranscript = sources
      .map((src) => {
        const lines = (src.transcript ?? []).map(
          (s) => `[${s.start.toFixed(1)}s - ${s.end.toFixed(1)}s] ${s.speaker}: ${s.text}`
        );
        return `=== SOURCE CLIP #${src.index}: "${src.filename}" (${(src.metadata?.duration ?? 0).toFixed(1)}s) ===\n${
          lines.join('\n') || '(No spoken dialogue detected in this clip — check visual keyframes)'
        }`;
      })
      .join('\n\n');
  } else {
    const transcriptLines = transcript.map(
      (s) => `[${s.start.toFixed(1)}s - ${s.end.toFixed(1)}s] ${s.speaker}: ${s.text}`
    );
    formattedTranscript = transcriptLines.join('\n');
    if (formattedTranscript.length > 120000 && transcriptLines.length > 200) {
      const stride = Math.ceil(formattedTranscript.length / 110000);
      const sampled = transcriptLines.filter(
        (_, idx) => idx < 40 || idx >= transcriptLines.length - 40 || idx % stride === 0
      );
      formattedTranscript = sampled.join('\n');
    }
  }

  // Include real extracted scene keyframes across all source clips so the model sees every clip's visuals
  const parts: Array<
    { inlineData: { mimeType: string; data: string } } | { text: string }
  > = [];

  const scenesDir = resolveSafePath(PROJECTS_DIR, projectId, 'scenes');
  const selectedScenes = isMultiSource ? scenes.slice(0, 10) : scenes.slice(0, 4);
  for (const scene of selectedScenes) {
    const filename = scene.thumbnailUrl.split('/').pop();
    if (filename) {
      const framePath = resolveSafePath(scenesDir, filename);
      if (fs.existsSync(framePath)) {
        if (isMultiSource && scene.sourceIndex !== undefined) {
          parts.push({
            text: `Keyframe from Source Clip #${scene.sourceIndex} (${scene.sourceFilename || 'clip'}) at ${scene.timestamp.toFixed(1)}s:`,
          });
        }
        parts.push({
          inlineData: {
            mimeType: 'image/jpeg',
            data: fs.readFileSync(framePath).toString('base64'),
          },
        });
      }
    }
  }

  const cleanBrief = brief?.trim() || '';
  const briefSection = cleanBrief
    ? `\nUSER CONSIGNE / CREATIVE BRIEF (Follow and interpret carefully):\n"""\n${cleanBrief}\n"""\n`
    : '\nUSER CONSIGNE / CREATIVE BRIEF: (None provided — infer optimal viral short-form strategy automatically from video content and visuals.)\n';

  const sourceInventoryNote =
    isMultiSource && sources
      ? `\nMULTI-CLIP REMIX PROJECT (${sources.length} raw source videos to mix & match):\n${sources
          .map(
            (s) =>
              `- Clip #${s.index}: "${s.filename}" (${(s.metadata?.duration ?? 0).toFixed(1)}s, ${s.metadata?.width ?? 0}x${s.metadata?.height ?? 0})`
          )
          .join('\n')}\n`
      : '';

  parts.push({
    text: `You are the Content Understanding & Category Classification Agent for a local AI video clipping studio.
Analyze the video title, user creative brief (consigne), technical metadata, scene frames, and timestamped transcript below.

Video Title: "${title}"
Total Footage Duration: ${metadata.duration.toFixed(1)}s | Resolution: ${metadata.width}x${metadata.height} | FPS: ${metadata.fps}
${sourceInventoryNote}${briefSection}
Supported Categories:
${categoryCatalogText}

Available Editing Profiles: ${VALID_PROFILES.join(', ')}

Rules:
1. Automatically determine the primary category AND any relevant secondary categories (with confidence 0-100).
2. Support mixed-category content honestly: never force a video into a single category if multiple domains apply; set isMixedContent=true and explain in uncertaintyNotes if classification spans multiple themes or is ambiguous.
3. Recommend the most suitable editing profile from the list, aligning with BOTH the video's true nature AND the user's consigne (never forcing flashy effects onto serious or educational material unless requested).
4. Detect primary spoken language and format (e.g., Multi-Clip Brand Campaign Remix, Two-Person Podcast, Solo Tutorial, Keynote Talk, Gameplay Commentary, Travel Vlog).
5. In "briefInterpretation", write a clear, actionable 2-4 sentence creative & compliance plan explaining how these clip(s) should be edited/remixed, what mandatory rules/dos-and-don'ts exist in the consigne (e.g., product visibility, forbidden voice edits, required story arc, platform handles), and what visual & subtitle styling fits best.

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
              briefInterpretation: { type: Type.STRING },
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
              'briefInterpretation',
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
    briefInterpretation?: string;
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
    briefInterpretation: parsed.briefInterpretation?.trim() || undefined,
    userOverriddenCategory: false,
  };
}
