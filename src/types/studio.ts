export type EditingProfileId =
  | 'Cinematic'
  | 'Podcast'
  | 'Educational'
  | 'Comedy'
  | 'Dynamic'
  | 'Minimal'
  | 'Gaming'
  | 'Travel';

export type SubtitleStylePreset = 'clean' | 'bold-highlight' | 'karaoke-pop' | 'minimal-caption';

export type CropFocusMode = 'auto-speaker' | 'center' | 'left-subject' | 'right-subject' | 'fit-blur';

export interface CriteriaWeights {
  hookStrength: number;
  standaloneContext: number;
  audienceInterest: number;
  emotionalOrInfoValue: number;
  contentCompleteness: number;
  audioVisualQuality: number;
}

export interface CategoryConfig {
  id: string;
  name: string;
  description: string;
  highlightStrategy: string;
  defaultEditingProfile: EditingProfileId;
  avoidEffects: boolean;
  criteriaWeights: CriteriaWeights;
  isCustom?: boolean;
}

export interface EditingProfileSpec {
  id: EditingProfileId;
  label: string;
  description: string;
  subtitlePreset: SubtitleStylePreset;
  highlightColorHex: string;
  allowDynamicZoom: boolean;
  fadeTransitionSec: number;
  cropMode: CropFocusMode;
  normalizeAudio: boolean;
  paceNote: string;
}

export interface VideoMetadata {
  duration: number;
  width: number;
  height: number;
  fps: number;
  videoCodec: string;
  audioCodec: string | null;
  bitrate: number;
  fileSize: number;
  formatName: string;
  hasAudio: boolean;
}

export interface TranscriptSegment {
  id: string;
  start: number;
  end: number;
  text: string;
  speaker: string;
  language?: string;
}

export interface SceneKeyframe {
  timestamp: number;
  thumbnailUrl: string;
  sceneScore: number;
}

export interface CategoryScore {
  categoryId: string;
  categoryName: string;
  confidence: number;
  rationale: string;
}

export interface ContentAnalysis {
  primaryCategoryId: string;
  primaryCategoryName: string;
  secondaryCategories: CategoryScore[];
  isMixedContent: boolean;
  uncertaintyNotes: string;
  mainTopics: string[];
  targetAudience: string;
  detectedLanguage: string;
  languageCode: 'en' | 'fr' | 'ar' | string;
  videoFormat: string;
  recommendedProfile: EditingProfileId;
  emotionalArc: string;
  structureNotes: string;
  userOverriddenCategory?: boolean;
}

export interface HighlightScoreBreakdown {
  hookStrength: number;
  standaloneContext: number;
  audienceInterest: number;
  emotionalOrInfoValue: number;
  contentCompleteness: number;
  audioVisualQuality: number;
  totalScore: number;
}

export interface QualityCheckItem {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  detail: string;
}

export interface QualityControlReport {
  passed: boolean;
  checkedAt: string;
  checks: QualityCheckItem[];
  fixableIssues: string[];
  autoRegenerated: boolean;
}

export interface PlatformSocialCopy {
  title: string;
  description: string;
  hashtags: string[];
}

export interface ExportPlatformPack {
  tiktok: PlatformSocialCopy;
  reels: PlatformSocialCopy;
  shorts: PlatformSocialCopy;
}

export interface HighlightRecord {
  id: string;
  projectId: string;
  startTime: number;
  endTime: number;
  duration: number;
  title: string;
  description: string;
  categoryId: string;
  categoryName: string;
  secondaryCategoryName: string | null;
  selectionExplanation: string;
  keywords: string[];
  criteriaBreakdown: HighlightScoreBreakdown;
  status: 'candidate' | 'selected' | 'rejected' | 'rendered' | 'exported';
  editingProfile: EditingProfileId;
  subtitleStyle: SubtitleStylePreset;
  highlightColor: string;
  cropMode: CropFocusMode;
  dynamicZoom: boolean;
  normalizeAudio: boolean;
  watermarkEnabled: boolean;
  renderedVideoUrl: string | null;
  qcReport: QualityControlReport | null;
}

export interface ExportRecord {
  id: string;
  projectId: string;
  projectTitle: string;
  highlightId: string;
  clipTitle: string;
  categoryId: string;
  categoryName: string;
  editingProfile: EditingProfileId;
  videoUrl: string;
  metadataJsonUrl: string;
  outputDir: string;
  resolution: string;
  duration: number;
  fileSize: number;
  platforms: ExportPlatformPack;
  createdAt: string;
}

export type PipelineStage =
  | 'queued'
  | 'downloading'
  | 'ingesting'
  | 'transcribing'
  | 'analyzing'
  | 'extracting_highlights'
  | 'completed'
  | 'failed';

export interface ProjectRecord {
  id: string;
  title: string;
  sourceFilename: string;
  sourceUrl: string;
  youtubeVideoId?: string | null;
  hasLocalVideoFile?: boolean;
  status: 'processing' | 'ready' | 'error';
  currentStage: PipelineStage;
  stageProgress: number;
  stageMessage: string;
  errorMessage: string | null;
  metadata: VideoMetadata | null;
  transcript: TranscriptSegment[];
  scenes: SceneKeyframe[];
  analysis: ContentAnalysis | null;
  createdAt: string;
  updatedAt: string;
}

export interface StudioSettings {
  minClipDuration: number;
  maxClipDuration: number;
  targetResolution: '1080x1920';
  audioTargetLufs: number;
  subtitleFontSize: number;
  defaultHighlightColor: string;
  watermarkText: string;
  enableWatermarkByDefault: boolean;
  defaultLanguageHint: 'auto' | 'en' | 'fr' | 'ar';
  customCategories: CategoryConfig[];
}
