import type { CategoryConfig, EditingProfileId, EditingProfileSpec, StudioSettings } from '../types/studio';

export const BUILTIN_CATEGORIES: CategoryConfig[] = [
  {
    id: 'motivation',
    name: 'Motivation & Self-Improvement',
    description: 'High-conviction mindset shifts, discipline principles, and personal breakthroughs.',
    highlightStrategy:
      'Prioritize powerful declarative statements, emotional inflection peaks, memorable life lessons, and discipline or resilience stories with a clear takeaway.',
    defaultEditingProfile: 'Cinematic',
    avoidEffects: false,
    criteriaWeights: {
      hookStrength: 0.22,
      standaloneContext: 0.18,
      audienceInterest: 0.18,
      emotionalOrInfoValue: 0.24,
      contentCompleteness: 0.12,
      audioVisualQuality: 0.06,
    },
  },
  {
    id: 'podcasts',
    name: 'Podcasts & Interviews',
    description: 'Long-form conversations, debates, candid stories, and host-guest exchanges.',
    highlightStrategy:
      'Select spirited back-and-forth exchanges, strong contrarian opinions, surprising revelations, and complete conversational arcs with clear speaker attribution.',
    defaultEditingProfile: 'Podcast',
    avoidEffects: false,
    criteriaWeights: {
      hookStrength: 0.2,
      standaloneContext: 0.22,
      audienceInterest: 0.2,
      emotionalOrInfoValue: 0.16,
      contentCompleteness: 0.14,
      audioVisualQuality: 0.08,
    },
  },
  {
    id: 'business',
    name: 'Business & Entrepreneurship',
    description: 'Startup tactics, marketing playbooks, financial frameworks, and founder lessons.',
    highlightStrategy:
      'Focus on actionable business lessons, concrete marketing strategies, unit-economics or financial insights, and candid entrepreneurial stories with clear outcomes.',
    defaultEditingProfile: 'Minimal',
    avoidEffects: true,
    criteriaWeights: {
      hookStrength: 0.18,
      standaloneContext: 0.22,
      audienceInterest: 0.18,
      emotionalOrInfoValue: 0.24,
      contentCompleteness: 0.12,
      audioVisualQuality: 0.06,
    },
  },
  {
    id: 'education',
    name: 'Education & Tutorials',
    description: 'Step-by-step explanations, demonstrations, study frameworks, and how-to guides.',
    highlightStrategy:
      'Extract self-contained lessons, crystal-clear explanations of one concept, practical demonstrations, and immediately usable tips without cutting off prerequisites.',
    defaultEditingProfile: 'Educational',
    avoidEffects: true,
    criteriaWeights: {
      hookStrength: 0.14,
      standaloneContext: 0.26,
      audienceInterest: 0.14,
      emotionalOrInfoValue: 0.26,
      contentCompleteness: 0.14,
      audioVisualQuality: 0.06,
    },
  },
  {
    id: 'comedy',
    name: 'Comedy & Entertainment',
    description: 'Stand-up sets, comedic timing, funny reactions, and entertaining storytelling.',
    highlightStrategy:
      'Capture complete jokes preserving both setup and punchline payoff, unexpected comedic turns, and expressive reactions without clipping laughter.',
    defaultEditingProfile: 'Comedy',
    avoidEffects: false,
    criteriaWeights: {
      hookStrength: 0.22,
      standaloneContext: 0.18,
      audienceInterest: 0.24,
      emotionalOrInfoValue: 0.18,
      contentCompleteness: 0.14,
      audioVisualQuality: 0.04,
    },
  },
  {
    id: 'fitness',
    name: 'Fitness & Sports',
    description: 'Training methodology, exercise form breakdowns, nutrition, and athletic stories.',
    highlightStrategy:
      'Highlight clear exercise demonstrations, actionable training advice, myth-busting physiology facts, and inspiring athletic transformation moments.',
    defaultEditingProfile: 'Dynamic',
    avoidEffects: false,
    criteriaWeights: {
      hookStrength: 0.2,
      standaloneContext: 0.2,
      audienceInterest: 0.18,
      emotionalOrInfoValue: 0.22,
      contentCompleteness: 0.12,
      audioVisualQuality: 0.08,
    },
  },
  {
    id: 'news_tech',
    name: 'News & Technology',
    description: 'Industry analysis, product breakdowns, engineering insights, and current events.',
    highlightStrategy:
      'Select sharp commentary on why a development matters, concise explanations of technical breakthroughs, and clear predictions or implications.',
    defaultEditingProfile: 'Minimal',
    avoidEffects: true,
    criteriaWeights: {
      hookStrength: 0.18,
      standaloneContext: 0.24,
      audienceInterest: 0.2,
      emotionalOrInfoValue: 0.22,
      contentCompleteness: 0.1,
      audioVisualQuality: 0.06,
    },
  },
  {
    id: 'travel',
    name: 'Travel & Lifestyle',
    description: 'Destination vlogs, cultural discoveries, aesthetic sequences, and daily routines.',
    highlightStrategy:
      'Find vivid personal stories, hidden-gem discoveries, scenic visual reveals, and relatable lifestyle reflections.',
    defaultEditingProfile: 'Travel',
    avoidEffects: false,
    criteriaWeights: {
      hookStrength: 0.18,
      standaloneContext: 0.16,
      audienceInterest: 0.2,
      emotionalOrInfoValue: 0.18,
      contentCompleteness: 0.12,
      audioVisualQuality: 0.16,
    },
  },
  {
    id: 'gaming',
    name: 'Gaming',
    description: 'Gameplay highlights, clutch plays, reactions, strategy commentary, and lore.',
    highlightStrategy:
      'Pick high-stakes clutch gameplay, unexpected in-game events, genuine streamer reactions, and concise tactical breakdowns.',
    defaultEditingProfile: 'Gaming',
    avoidEffects: false,
    criteriaWeights: {
      hookStrength: 0.24,
      standaloneContext: 0.14,
      audienceInterest: 0.24,
      emotionalOrInfoValue: 0.18,
      contentCompleteness: 0.1,
      audioVisualQuality: 0.1,
    },
  },
  {
    id: 'personal_stories',
    name: 'Personal Stories',
    description: 'First-person narratives, memoirs, turning points, and reflective monologues.',
    highlightStrategy:
      'Preserve narrative arc with an intriguing opening hook, emotional turning point, and resonant closing reflection without rushing pauses.',
    defaultEditingProfile: 'Cinematic',
    avoidEffects: true,
    criteriaWeights: {
      hookStrength: 0.2,
      standaloneContext: 0.22,
      audienceInterest: 0.18,
      emotionalOrInfoValue: 0.24,
      contentCompleteness: 0.12,
      audioVisualQuality: 0.04,
    },
  },
  {
    id: 'general',
    name: 'General & Mixed Content',
    description: 'Multi-topic videos, variety shows, or hybrid formats spanning multiple domains.',
    highlightStrategy:
      'Identify the strongest self-contained insights, surprising shifts, compelling mini-stories, and high-engagement segments regardless of topic.',
    defaultEditingProfile: 'Dynamic',
    avoidEffects: false,
    criteriaWeights: {
      hookStrength: 0.2,
      standaloneContext: 0.2,
      audienceInterest: 0.2,
      emotionalOrInfoValue: 0.2,
      contentCompleteness: 0.12,
      audioVisualQuality: 0.08,
    },
  },
];

export const EDITING_PROFILES: Record<EditingProfileId, EditingProfileSpec> = {
  Cinematic: {
    id: 'Cinematic',
    label: 'Cinematic',
    description: 'Measured pacing, subtle crossfades, refined serif-like subtitle spacing, warm amber keyword emphasis.',
    subtitlePreset: 'clean',
    highlightColorHex: '#F59E0B',
    allowDynamicZoom: false,
    fadeTransitionSec: 0.35,
    cropMode: 'center',
    normalizeAudio: true,
    paceNote: 'Preserves dramatic pauses and clean lower-third framing.',
  },
  Podcast: {
    id: 'Podcast',
    label: 'Podcast',
    description: 'Speaker-centered vertical framing, crisp conversational captions, speaker clarity audio leveling.',
    subtitlePreset: 'bold-highlight',
    highlightColorHex: '#3B82F6',
    allowDynamicZoom: false,
    fadeTransitionSec: 0.2,
    cropMode: 'auto-speaker',
    normalizeAudio: true,
    paceNote: 'Balances conversational rhythm without distracting zoom cuts.',
  },
  Educational: {
    id: 'Educational',
    label: 'Educational',
    description: 'High-legibility subtitles, zero unnecessary motion effects, preserves visual context and slides.',
    subtitlePreset: 'minimal-caption',
    highlightColorHex: '#10B981',
    allowDynamicZoom: false,
    fadeTransitionSec: 0.15,
    cropMode: 'fit-blur',
    normalizeAudio: true,
    paceNote: 'Keeps diagrams and full frame context legible with blur-pillar 9:16 fill.',
  },
  Comedy: {
    id: 'Comedy',
    label: 'Comedy',
    description: 'Expressive punchline keyword pops, subtle reaction zoom-in, tight beat-aligned timing.',
    subtitlePreset: 'karaoke-pop',
    highlightColorHex: '#FACC15',
    allowDynamicZoom: true,
    fadeTransitionSec: 0.1,
    cropMode: 'auto-speaker',
    normalizeAudio: true,
    paceNote: 'Supports comedic timing with punchy yellow emphasis on key words.',
  },
  Dynamic: {
    id: 'Dynamic',
    label: 'Dynamic',
    description: 'Energetic vertical crop, high-contrast bold captions, subtle motion punch-in and loudnorm.',
    subtitlePreset: 'bold-highlight',
    highlightColorHex: '#38BDF8',
    allowDynamicZoom: true,
    fadeTransitionSec: 0.15,
    cropMode: 'center',
    normalizeAudio: true,
    paceNote: 'Ideal for high-energy commentary, fitness, and mixed highlights.',
  },
  Minimal: {
    id: 'Minimal',
    label: 'Minimal',
    description: 'Clean editorial captions, static steady framing, serious tone suitable for business and tech news.',
    subtitlePreset: 'minimal-caption',
    highlightColorHex: '#E2E8F0',
    allowDynamicZoom: false,
    fadeTransitionSec: 0.2,
    cropMode: 'center',
    normalizeAudio: true,
    paceNote: 'Restrained visual treatment that lets the argument stand on its own.',
  },
  Gaming: {
    id: 'Gaming',
    label: 'Gaming',
    description: 'Center-action crop with high-visibility uppercase-accented captions and punchy audio leveling.',
    subtitlePreset: 'karaoke-pop',
    highlightColorHex: '#22C55E',
    allowDynamicZoom: true,
    fadeTransitionSec: 0.1,
    cropMode: 'center',
    normalizeAudio: true,
    paceNote: 'Keeps HUD and gameplay focal region centered in 9:16.',
  },
  Travel: {
    id: 'Travel',
    label: 'Travel',
    description: 'Atmospheric fade transitions, unobtrusive captions, gentle framing that honors scenic composition.',
    subtitlePreset: 'clean',
    highlightColorHex: '#FBBF24',
    allowDynamicZoom: true,
    fadeTransitionSec: 0.4,
    cropMode: 'center',
    normalizeAudio: true,
    paceNote: 'Prioritizes visual scenery and natural ambient rhythm.',
  },
};

export const DEFAULT_STUDIO_SETTINGS: StudioSettings = {
  minClipDuration: 15,
  maxClipDuration: 60,
  targetResolution: '1080x1920',
  audioTargetLufs: -14,
  subtitleFontSize: 54,
  defaultHighlightColor: '#3B82F6',
  watermarkText: 'ClipForge Studio',
  enableWatermarkByDefault: false,
  defaultLanguageHint: 'auto',
  customCategories: [],
};

export function getAllCategories(customCategories: CategoryConfig[] = []): CategoryConfig[] {
  return [...BUILTIN_CATEGORIES, ...customCategories];
}

export function findCategoryByIdOrName(
  idOrName: string,
  customCategories: CategoryConfig[] = []
): CategoryConfig {
  const all = getAllCategories(customCategories);
  const norm = idOrName.trim().toLowerCase();
  return (
    all.find(
      (c) =>
        c.id.toLowerCase() === norm ||
        c.name.toLowerCase() === norm ||
        c.name.toLowerCase().includes(norm)
    ) ?? BUILTIN_CATEGORIES[BUILTIN_CATEGORIES.length - 1]
  );
}
