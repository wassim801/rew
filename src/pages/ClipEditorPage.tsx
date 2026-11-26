import {
  AlertTriangle,
  CheckCircle2,
  Download,
  Film,
  Image as ImageIcon,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Save,
  Upload,
  Wand2,
  XCircle,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  BgmVibe,
  CameraEnergy,
  CropFocusMode,
  EditingProfileId,
  EditingProfileSpec,
  HighlightRecord,
  ProjectRecord,
  RemixSegment,
  SfxCueType,
  SfxMode,
  SubtitleStylePreset,
  ThumbnailVibeStyle,
  TransitionStyle,
} from '../types/studio';
import { formatTimecode, isArabicText } from '../utils/format';
import type { StudioPage } from '../components/Sidebar';

interface ClipEditorPageProps {
  project: ProjectRecord | null;
  highlights: HighlightRecord[];
  selectedHighlightId: string | null;
  editingProfiles: EditingProfileSpec[];
  onSelectHighlight: (id: string) => void;
  onSaveHighlight: (id: string, patch: Partial<HighlightRecord>) => Promise<HighlightRecord>;
  onRegenerateThumbnail: (
    id: string,
    overrides?: Partial<HighlightRecord>
  ) => Promise<HighlightRecord>;
  onRenderClip: (id: string) => Promise<void>;
  onAutoHealClip: (id: string) => Promise<void>;
  onExportClip: (id: string) => Promise<void>;
  onAttachLocalVideo: (projectId: string, file: File) => Promise<void>;
  onRetryYouTubeDownload: (projectId: string, cookie: string) => Promise<void>;
  onNavigate: (page: StudioPage) => void;
}

export function ClipEditorPage({
  project,
  highlights,
  selectedHighlightId,
  editingProfiles,
  onSelectHighlight,
  onSaveHighlight,
  onRegenerateThumbnail,
  onRenderClip,
  onAutoHealClip,
  onExportClip,
  onAttachLocalVideo,
  onRetryYouTubeDownload,
  onNavigate,
}: ClipEditorPageProps) {
  const projectHighlights = useMemo(
    () => (project ? highlights.filter((h) => h.projectId === project.id) : highlights),
    [project, highlights]
  );

  const activeHighlight = useMemo(() => {
    if (selectedHighlightId) {
      const found = projectHighlights.find((h) => h.id === selectedHighlightId);
      if (found) return found;
    }
    return projectHighlights[0] ?? null;
  }, [projectHighlights, selectedHighlightId]);

  const [title, setTitle] = useState('');
  const [hookHeadline, setHookHeadline] = useState('');
  const [description, setDescription] = useState('');
  const [startTime, setStartTime] = useState(0);
  const [endTime, setEndTime] = useState(15);
  const [editingProfile, setEditingProfile] = useState<EditingProfileId>('Minimal');
  const [subtitleStyle, setSubtitleStyle] = useState<SubtitleStylePreset>('clean');
  const [highlightColor, setHighlightColor] = useState('#3B82F6');
  const [cropMode, setCropMode] = useState<CropFocusMode>('center');
  const [dynamicZoom, setDynamicZoom] = useState(false);
  const [normalizeAudio, setNormalizeAudio] = useState(true);
  const [watermarkEnabled, setWatermarkEnabled] = useState(false);
  const [bgmVibe, setBgmVibe] = useState<BgmVibe>('auto');
  const [transitionStyle, setTransitionStyle] = useState<TransitionStyle>('auto');
  const [cameraEnergy, setCameraEnergy] = useState<CameraEnergy>('auto');
  const [sfxMode, setSfxMode] = useState<SfxMode>('auto');
  const [hookSfx, setHookSfx] = useState<SfxCueType | 'auto' | 'none'>('auto');
  const [thumbnailText, setThumbnailText] = useState('');
  const [thumbnailEmojisInput, setThumbnailEmojisInput] = useState('');
  const [thumbnailStyle, setThumbnailStyle] = useState<ThumbnailVibeStyle>('auto');
  const [editSegments, setEditSegments] = useState<RemixSegment[]>([]);
  const [activeSegIdx, setActiveSegIdx] = useState(0);
  const [previewMode, setPreviewMode] = useState<'rendered' | 'source' | 'thumbnail'>('rendered');
  const [currentPlayTime, setCurrentPlayTime] = useState(0);

  const [saving, setSaving] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [regeneratingThumb, setRegeneratingThumb] = useState(false);
  const [healing, setHealing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [retryCookie, setRetryCookie] = useState('');
  const [upgradingSource, setUpgradingSource] = useState(false);

  const [isPlaying, setIsPlaying] = useState(false);
  const [videoBuffering, setVideoBuffering] = useState(false);
  const [videoError, setVideoError] = useState<string | null>(null);
  const [alignedCues, setAlignedCues] = useState<
    Array<{ start: number; end: number; speaker: string; text: string }>
  >([]);
  const [aligningCues, setAligningCues] = useState(false);

  const sourceVideoRef = useRef<HTMLVideoElement | null>(null);
  const renderedVideoRef = useRef<HTMLVideoElement | null>(null);
  const attachFileRef = useRef<HTMLInputElement | null>(null);
  const resumeAutoPlayRef = useRef(false);

  useEffect(() => {
    if (!activeHighlight) return;
    setTitle(activeHighlight.title);
    setHookHeadline(activeHighlight.hookHeadline ?? '');
    setDescription(activeHighlight.description);
    setStartTime(activeHighlight.startTime);
    setEndTime(activeHighlight.endTime);
    setEditingProfile(activeHighlight.editingProfile);
    setSubtitleStyle(activeHighlight.subtitleStyle);
    setHighlightColor(activeHighlight.highlightColor);
    setCropMode(activeHighlight.cropMode);
    setDynamicZoom(activeHighlight.dynamicZoom);
    setNormalizeAudio(activeHighlight.normalizeAudio);
    setWatermarkEnabled(activeHighlight.watermarkEnabled);
    setBgmVibe(activeHighlight.bgmVibe ?? 'auto');
    setTransitionStyle(activeHighlight.transitionStyle ?? 'auto');
    setCameraEnergy(activeHighlight.cameraEnergy ?? 'auto');
    setSfxMode(activeHighlight.sfxMode ?? 'auto');
    setHookSfx(activeHighlight.hookSfx ?? 'auto');
    setThumbnailText(activeHighlight.thumbnailText ?? '');
    setThumbnailEmojisInput((activeHighlight.thumbnailEmojis ?? []).join(' '));
    setThumbnailStyle(activeHighlight.thumbnailStyle ?? 'auto');
    setEditSegments(activeHighlight.editSegments ? activeHighlight.editSegments.map((s) => ({ ...s })) : []);
    setActiveSegIdx(0);
    setPreviewMode(activeHighlight.renderedVideoUrl ? 'rendered' : 'source');
    setCurrentPlayTime(
      activeHighlight.renderedVideoUrl || (activeHighlight.editSegments?.length ?? 0) > 0
        ? 0
        : activeHighlight.startTime
    );
    setIsPlaying(false);
    setVideoError(null);
  }, [activeHighlight?.id, activeHighlight?.renderedVideoUrl]);

  // Fetch voice-aligned subtitle cues for exact Live Source Preview sync
  useEffect(() => {
    if (!activeHighlight || !project || project.hasLocalVideoFile === false) {
      setAlignedCues([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      setAligningCues(true);
      try {
        const res = await fetch(
          `/api/highlights/${encodeURIComponent(
            activeHighlight.id
          )}/aligned-subtitles?start=${startTime.toFixed(2)}&end=${endTime.toFixed(2)}`
        );
        if (!res.ok) return;
        const data = (await res.json()) as {
          cues?: Array<{ start: number; end: number; speaker: string; text: string }>;
        };
        if (!cancelled && Array.isArray(data.cues)) {
          setAlignedCues(data.cues);
        }
      } catch {
        // Fallback smoothly to project.transcript chunks
      } finally {
        if (!cancelled) setAligningCues(false);
      }
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [activeHighlight?.id, project?.id, project?.hasLocalVideoFile, startTime, endTime]);

  const isRemix = editSegments.length > 0;
  const activeSeg = isRemix ? editSegments[Math.min(activeSegIdx, editSegments.length - 1)] : null;
  const segStart = activeSeg ? activeSeg.startTime : startTime;
  const segEnd = activeSeg ? activeSeg.endTime : endTime;

  // Keep source preview synced to startTime once video metadata is ready
  useEffect(() => {
    const el = sourceVideoRef.current;
    if (previewMode === 'source' && el && activeHighlight && el.readyState >= 1) {
      if (Math.abs(el.currentTime - segStart) > 0.25) {
        el.currentTime = segStart;
      }
      if (!isRemix) {
        setCurrentPlayTime(segStart);
      }
    }
  }, [previewMode, segStart, activeHighlight?.id, activeSegIdx, isRemix]);

  // Build rhythmic 2-4 word display phrases from voice-aligned cues (or weighted project transcript fallback)
  const previewSubtitlePhrases = useMemo(() => {
    const clipDur = Math.max(1, endTime - startTime);
    const sourceCues =
      alignedCues.length > 0
        ? alignedCues
        : (project?.transcript ?? [])
            .filter((s) => s.end > startTime && s.start < endTime)
            .map((s) => ({
              start: Math.max(0, s.start - startTime),
              end: Math.min(clipDur, s.end - startTime),
              speaker: s.speaker,
              text: s.text,
            }));

    const out: Array<{ start: number; end: number; text: string }> = [];
    for (const cue of sourceCues) {
      const cStart = Math.max(0, cue.start);
      const cEnd = Math.min(clipDur, cue.end);
      if (cEnd - cStart < 0.15) continue;
      const words = cue.text.trim().split(/\s+/).filter(Boolean);
      if (!words.length) continue;

      const groups: string[][] = [];
      let cur: string[] = [];
      for (const w of words) {
        const len = [...cur, w].join(' ').length;
        if (cur.length >= 4 || (cur.length >= 2 && len > 22)) {
          groups.push(cur);
          cur = [w];
        } else {
          cur.push(w);
        }
      }
      if (cur.length) groups.push(cur);

      const totalW = groups.reduce((acc, g) => acc + Math.max(2, g.join('').length), 0) || 1;
      const dur = Math.max(0.25, cEnd - cStart);
      let cursor = cStart;
      for (let i = 0; i < groups.length; i++) {
        const w = Math.max(2, groups[i].join('').length);
        const fDur = i === groups.length - 1 ? cEnd - cursor : (dur * w) / totalW;
        out.push({
          start: cursor,
          end: Math.min(clipDur, Math.max(cursor + 0.2, cursor + fDur)),
          text: groups[i].join(' '),
        });
        cursor += fDur;
      }
    }
    return out;
  }, [alignedCues, project?.transcript, startTime, endTime]);

  if (!project || !activeHighlight) {
    return (
      <div className="mx-auto max-w-4xl p-8 text-center">
        <Film className="mx-auto h-10 w-10 text-slate-600" />
        <h2 className="mt-4 text-xl font-semibold text-slate-100">No Clip Loaded in Editor</h2>
        <p className="mt-1 text-sm text-slate-400">
          Import a video and select a scored highlight to preview, adjust framing, and render 9:16 MP4s.
        </p>
        <button
          type="button"
          onClick={() => onNavigate('highlights')}
          className="mt-5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500"
        >
          Browse AI Highlights
        </button>
      </div>
    );
  }

  const maxSourceDuration = project.metadata?.duration ?? Math.max(endTime, 60);
  const remixTotalDuration = isRemix
    ? Math.max(
        1,
        Number(editSegments.reduce((acc, s) => acc + Math.max(0.5, s.endTime - s.startTime), 0).toFixed(2))
      )
    : Math.max(1, endTime - startTime);
  const clipDuration = remixTotalDuration;

  const segOffsetBefore = isRemix
    ? editSegments
        .slice(0, activeSegIdx)
        .reduce((acc, s) => acc + Math.max(0.5, s.endTime - s.startTime), 0)
    : 0;

  const relativePlayTime =
    previewMode === 'rendered' && activeHighlight.renderedVideoUrl
      ? currentPlayTime
      : isRemix
      ? Math.max(0, segOffsetBefore + Math.max(0, currentPlayTime - segStart))
      : Math.max(0, currentPlayTime - startTime);

  const activeSourceUrl =
    isRemix && activeSeg && project.sources?.[activeSeg.sourceIndex]?.sourceUrl
      ? project.sources[activeSeg.sourceIndex].sourceUrl
      : project.sourceUrl;

  const activeSubtitleCue =
    previewSubtitlePhrases.find((c) => relativePlayTime >= c.start && relativePlayTime <= c.end) ??
    previewSubtitlePhrases[0] ??
    null;

  const handleProfileChange = (nextId: EditingProfileId) => {
    setEditingProfile(nextId);
    const spec = editingProfiles.find((p) => p.id === nextId);
    if (spec) {
      setSubtitleStyle(spec.subtitlePreset);
      setHighlightColor(spec.highlightColorHex);
      setCropMode(spec.cropMode);
      setDynamicZoom(spec.allowDynamicZoom);
      setNormalizeAudio(spec.normalizeAudio);
    }
  };

  const parseEmojiTokens = (val: string): string[] => {
    const tokens = val
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    return tokens.slice(0, 3);
  };

  const persistCurrentSettings = async () => {
    setSaving(true);
    try {
      await onSaveHighlight(activeHighlight.id, {
        title,
        hookHeadline: hookHeadline.trim() || undefined,
        description,
        startTime: isRemix ? 0 : startTime,
        endTime: isRemix ? remixTotalDuration : endTime,
        duration: isRemix
          ? remixTotalDuration
          : Math.max(1, Number((endTime - startTime).toFixed(2))),
        editingProfile,
        subtitleStyle,
        highlightColor,
        cropMode,
        dynamicZoom,
        normalizeAudio,
        watermarkEnabled,
        bgmVibe,
        transitionStyle,
        cameraEnergy,
        sfxMode,
        hookSfx,
        thumbnailText: thumbnailText.trim() || undefined,
        thumbnailEmojis: parseEmojiTokens(thumbnailEmojisInput),
        thumbnailStyle,
        ...(isRemix ? { editSegments } : {}),
      });
    } finally {
      setSaving(false);
    }
  };

  const handleRegenerateCover = async () => {
    setRegeneratingThumb(true);
    try {
      const updated = await onRegenerateThumbnail(activeHighlight.id, {
        thumbnailText: thumbnailText.trim() || undefined,
        thumbnailEmojis: parseEmojiTokens(thumbnailEmojisInput),
        thumbnailStyle,
      });
      setThumbnailText(updated.thumbnailText ?? thumbnailText);
      setThumbnailEmojisInput((updated.thumbnailEmojis ?? []).join(' '));
      if (updated.thumbnailStyle) setThumbnailStyle(updated.thumbnailStyle);
      setPreviewMode('thumbnail');
    } finally {
      setRegeneratingThumb(false);
    }
  };

  const handleRender = async () => {
    setRendering(true);
    try {
      await persistCurrentSettings();
      await onRenderClip(activeHighlight.id);
      setPreviewMode('rendered');
      setVideoError(null);
    } catch {
      // Error banner handled in App
    } finally {
      setRendering(false);
    }
  };

  const handleAutoHeal = async () => {
    setHealing(true);
    try {
      await onAutoHealClip(activeHighlight.id);
      setPreviewMode('rendered');
      setVideoError(null);
    } catch {
      // Error banner handled in App
    } finally {
      setHealing(false);
    }
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      await persistCurrentSettings();
      await onExportClip(activeHighlight.id);
      onNavigate('exports');
    } catch {
      // Stay on editor page; error banner handled in App
    } finally {
      setExporting(false);
    }
  };

  const handleTogglePlay = async () => {
    const isRendered = previewMode === 'rendered' && Boolean(activeHighlight.renderedVideoUrl);
    const el = isRendered ? renderedVideoRef.current : sourceVideoRef.current;
    if (!el) return;
    setVideoError(null);

    if (!el.paused) {
      resumeAutoPlayRef.current = false;
      el.pause();
      return;
    }

    if (!isRendered && (el.currentTime < segStart - 0.5 || el.currentTime >= segEnd - 0.15)) {
      el.currentTime = segStart;
    }

    try {
      await el.play();
    } catch (err) {
      setVideoError(err instanceof Error ? err.message : 'Unable to start video playback.');
    }
  };

  const handleRestartSegment = async () => {
    const isRendered = previewMode === 'rendered' && Boolean(activeHighlight.renderedVideoUrl);
    if (!isRendered && isRemix) {
      setActiveSegIdx(0);
      resumeAutoPlayRef.current = true;
    }
    const el = isRendered ? renderedVideoRef.current : sourceVideoRef.current;
    if (!el) return;
    setVideoError(null);
    const targetStart = isRendered ? 0 : isRemix ? editSegments[0]?.startTime ?? 0 : startTime;
    el.currentTime = targetStart;
    setCurrentPlayTime(targetStart);
    try {
      await el.play();
    } catch (err) {
      setVideoError(err instanceof Error ? err.message : 'Unable to start video playback.');
    }
  };

  const objectPositionClass =
    cropMode === 'left-subject'
      ? 'object-[25%_50%]'
      : cropMode === 'right-subject'
      ? 'object-[75%_50%]'
      : 'object-center';

  const qc = activeHighlight.qcReport;
  const rtl = isArabicText(activeSubtitleCue?.text || hookHeadline || title);

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6 lg:p-8">
      {/* Top Clip Selector Strip */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-b border-slate-800 pb-4">
        <div className="min-w-0">
          <h2 className="text-xl font-semibold tracking-tight text-slate-50 truncate">
            Clip Preview & Adaptive Editor
          </h2>
          <p className="text-xs text-slate-400">
            {activeHighlight.categoryName} · Score{' '}
            <span className="font-mono tabular-nums text-slate-200">
              {activeHighlight.criteriaBreakdown.totalScore}/100
            </span>{' '}
            · Duration{' '}
            <span className="font-mono tabular-nums text-slate-200">
              {(endTime - startTime).toFixed(1)}s
            </span>
          </p>
        </div>

        <label className="flex items-center gap-2 text-xs text-slate-400">
          <span className="whitespace-nowrap">Switch clip</span>
          <select
            value={activeHighlight.id}
            onChange={(e) => onSelectHighlight(e.target.value)}
            className="max-w-xs truncate rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-100 focus:border-blue-500 focus:outline-none"
          >
            {projectHighlights.map((h) => (
              <option key={h.id} value={h.id}>
                [{h.criteriaBreakdown.totalScore}] {h.title}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="grid gap-8 lg:grid-cols-12 items-start">
        {/* Left: 9:16 Vertical Preview */}
        <div className="lg:col-span-5 flex flex-col items-center space-y-4">
          <div className="flex flex-wrap items-center justify-center gap-1 rounded-lg border border-slate-800 bg-slate-900 p-1">
            <button
              type="button"
              disabled={!activeHighlight.renderedVideoUrl}
              onClick={() => setPreviewMode('rendered')}
              className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap disabled:opacity-40 ${
                previewMode === 'rendered'
                  ? 'bg-slate-800 text-slate-50'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Rendered MP4
            </button>
            <button
              type="button"
              onClick={() => setPreviewMode('source')}
              className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                previewMode === 'source'
                  ? 'bg-slate-800 text-slate-50'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Live Source
            </button>
            <button
              type="button"
              onClick={() => setPreviewMode('thumbnail')}
              className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                previewMode === 'thumbnail'
                  ? 'bg-slate-800 text-slate-50'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Cover Thumbnail
            </button>
          </div>

          <div className="relative w-full max-w-[320px] aspect-[9/16] overflow-hidden rounded-2xl border border-slate-700 bg-black">
            {previewMode === 'thumbnail' ? (
              activeHighlight.thumbnailUrl ? (
                <img
                  key={activeHighlight.thumbnailUrl}
                  src={activeHighlight.thumbnailUrl}
                  alt={`Cover thumbnail for ${activeHighlight.title}`}
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="flex h-full w-full flex-col items-center justify-center gap-3 p-6 text-center">
                  <ImageIcon className="h-9 w-9 text-slate-600" />
                  <p className="text-xs text-slate-400">
                    No cover thumbnail generated for this highlight yet.
                  </p>
                  <button
                    type="button"
                    disabled={regeneratingThumb}
                    onClick={handleRegenerateCover}
                    className="rounded-lg bg-blue-600 px-3.5 py-2 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50"
                  >
                    {regeneratingThumb ? 'Designing Cover...' : 'Generate Cover Thumbnail'}
                  </button>
                </div>
              )
            ) : previewMode === 'rendered' && activeHighlight.renderedVideoUrl ? (
              <video
                key={activeHighlight.renderedVideoUrl}
                ref={renderedVideoRef}
                src={activeHighlight.renderedVideoUrl}
                preload="metadata"
                controls
                playsInline
                onLoadedMetadata={() => {
                  setVideoError(null);
                  setVideoBuffering(false);
                }}
                onWaiting={() => setVideoBuffering(true)}
                onPlaying={() => {
                  setVideoBuffering(false);
                  setIsPlaying(true);
                  setVideoError(null);
                }}
                onPause={() => setIsPlaying(false)}
                onEnded={() => setIsPlaying(false)}
                onTimeUpdate={(e) => setCurrentPlayTime(e.currentTarget.currentTime)}
                onError={() => {
                  setIsPlaying(false);
                  setVideoBuffering(false);
                  setVideoError(
                    'Rendered MP4 could not be loaded. Switch to Live Source Preview or re-render.'
                  );
                }}
                className="h-full w-full object-cover"
              />
            ) : project.hasLocalVideoFile === false && project.youtubeVideoId ? (
              <iframe
                key={`${project.youtubeVideoId}_${Math.floor(startTime)}_${Math.ceil(endTime)}`}
                src={`https://www.youtube.com/embed/${encodeURIComponent(
                  project.youtubeVideoId
                )}?start=${Math.floor(startTime)}&end=${Math.ceil(endTime)}&rel=0`}
                title={activeHighlight.title}
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
                className="h-full w-full border-0"
              />
            ) : (
              <>
                <video
                  key={`${activeSourceUrl}_${activeSegIdx}`}
                  ref={sourceVideoRef}
                  src={activeSourceUrl}
                  preload="metadata"
                  controls
                  playsInline
                  onLoadedMetadata={(e) => {
                    setVideoError(null);
                    setVideoBuffering(false);
                    if (Math.abs(e.currentTarget.currentTime - segStart) > 0.25) {
                      e.currentTarget.currentTime = segStart;
                    }
                    setCurrentPlayTime(segStart);
                    if (resumeAutoPlayRef.current) {
                      resumeAutoPlayRef.current = false;
                      void e.currentTarget.play().catch(() => undefined);
                    }
                  }}
                  onCanPlay={() => setVideoBuffering(false)}
                  onWaiting={() => setVideoBuffering(true)}
                  onPlay={(e) => {
                    if (
                      e.currentTarget.currentTime < segStart - 0.5 ||
                      e.currentTarget.currentTime >= segEnd - 0.15
                    ) {
                      e.currentTarget.currentTime = segStart;
                    }
                    setIsPlaying(true);
                    setVideoError(null);
                  }}
                  onPlaying={() => {
                    setVideoBuffering(false);
                    setIsPlaying(true);
                  }}
                  onPause={() => setIsPlaying(false)}
                  onEnded={() => setIsPlaying(false)}
                  onTimeUpdate={(e) => {
                    const t = e.currentTarget.currentTime;
                    setCurrentPlayTime(t);
                    if (t >= segEnd) {
                      if (isRemix && activeSegIdx + 1 < editSegments.length) {
                        const nextIdx = activeSegIdx + 1;
                        const nextSeg = editSegments[nextIdx];
                        if (nextSeg.sourceIndex === activeSeg?.sourceIndex) {
                          setActiveSegIdx(nextIdx);
                          e.currentTarget.currentTime = nextSeg.startTime;
                        } else {
                          resumeAutoPlayRef.current = true;
                          setActiveSegIdx(nextIdx);
                        }
                      } else {
                        e.currentTarget.pause();
                        if (isRemix) setActiveSegIdx(0);
                        e.currentTarget.currentTime = isRemix
                          ? editSegments[0]?.startTime ?? 0
                          : startTime;
                        setIsPlaying(false);
                      }
                    }
                  }}
                  onError={() => {
                    setIsPlaying(false);
                    setVideoBuffering(false);
                    setVideoError(
                      'Source video failed to stream in browser. Ensure the uploaded MP4 is H.264/AAC or render 9:16 MP4 directly.'
                    );
                  }}
                  className={`h-full w-full ${
                    cropMode === 'fit-blur'
                      ? 'object-contain bg-slate-950'
                      : `object-cover ${objectPositionClass}`
                  }`}
                />
                {/* Opening Hook Card Preview (0.0s - 3.2s) */}
                {subtitleStyle !== 'minimal-caption' &&
                  relativePlayTime <= 3.2 &&
                  (hookHeadline || title).trim() && (
                    <div className="pointer-events-none absolute inset-x-4 top-6 text-center space-y-1.5">
                      <div>
                        <span
                          className="inline-block rounded px-2 py-0.5 text-[9px] font-extrabold uppercase tracking-widest text-[#090e1a] shadow"
                          style={{ backgroundColor: highlightColor }}
                        >
                          {activeHighlight.categoryName}
                        </span>
                      </div>
                      <div
                        dir={rtl ? 'rtl' : 'ltr'}
                        className="inline-block rounded-lg bg-slate-950/85 px-3 py-1.5 text-xs font-bold leading-snug text-white shadow-lg border border-white/10"
                      >
                        {(hookHeadline || title).trim().split(/\s+/).slice(0, 7).join(' ')}
                      </div>
                    </div>
                  )}

                {/* Voice-Synced Live Caption Overlay with Active Word Pop */}
                {activeSubtitleCue && (
                  <div className="pointer-events-none absolute inset-x-4 bottom-16 text-center">
                    <span
                      dir={rtl ? 'rtl' : 'ltr'}
                      className={`inline-block rounded-lg px-3 py-1.5 text-sm leading-snug text-white shadow-lg ${
                        subtitleStyle === 'clean' || subtitleStyle === 'minimal-caption'
                          ? 'bg-slate-950/80 border border-white/10'
                          : 'bg-black/55 drop-shadow-[0_2px_4px_rgba(0,0,0,0.95)]'
                      } ${
                        subtitleStyle === 'bold-highlight' || subtitleStyle === 'karaoke-pop'
                          ? 'font-extrabold tracking-tight'
                          : 'font-semibold'
                      }`}
                    >
                      {(() => {
                        const words = activeSubtitleCue.text.split(/\s+/).filter(Boolean);
                        const cueDur = Math.max(0.25, activeSubtitleCue.end - activeSubtitleCue.start);
                        const frac = Math.max(
                          0,
                          Math.min(1, (relativePlayTime - activeSubtitleCue.start) / cueDur)
                        );
                        const activeWordIdx = Math.min(
                          words.length - 1,
                          Math.floor(frac * words.length)
                        );
                        return words.map((word, idx) => {
                          const isKw = activeHighlight.keywords.some((k) =>
                            word.toLowerCase().includes(k.toLowerCase())
                          );
                          const isSpoken =
                            !rtl &&
                            (subtitleStyle === 'karaoke-pop' || subtitleStyle === 'bold-highlight') &&
                            idx <= activeWordIdx;
                          const colorStyle =
                            subtitleStyle !== 'minimal-caption' && (isSpoken || isKw)
                              ? { color: highlightColor }
                              : undefined;
                          return (
                            <span key={idx} style={colorStyle}>
                              {word}{' '}
                            </span>
                          );
                        });
                      })()}
                    </span>
                  </div>
                )}

                {/* Sleek Live Bottom Progress Bar */}
                <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1 bg-black/45">
                  <div
                    className="h-full transition-[width] duration-75"
                    style={{
                      width: `${Math.max(2, Math.min(100, (relativePlayTime / clipDuration) * 100))}%`,
                      backgroundColor: highlightColor,
                    }}
                  />
                </div>
              </>
            )}

            {videoBuffering && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/45">
                <Loader2 className="h-7 w-7 animate-spin text-blue-400" />
              </div>
            )}
          </div>

          {/* Segment Playback Controls or Thumbnail Cover Controls */}
          {previewMode === 'thumbnail' ? (
            <div className="w-full max-w-[320px] flex items-center gap-2">
              <button
                type="button"
                disabled={regeneratingThumb}
                onClick={handleRegenerateCover}
                className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-100 hover:bg-slate-800 disabled:opacity-50"
              >
                <RefreshCw className={`h-3.5 w-3.5 text-blue-400 ${regeneratingThumb ? 'animate-spin' : ''}`} />
                <span>{regeneratingThumb ? 'Designing...' : 'Regenerate Cover'}</span>
              </button>
              {activeHighlight.thumbnailUrl && (
                <a
                  href={
                    activeHighlight.thumbnailUrl.includes('?')
                      ? `${activeHighlight.thumbnailUrl}&download=1`
                      : `${activeHighlight.thumbnailUrl}?download=1`
                  }
                  className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 whitespace-nowrap"
                >
                  <Download className="h-3.5 w-3.5" />
                  <span>JPG</span>
                </a>
              )}
            </div>
          ) : !(project.hasLocalVideoFile === false && project.youtubeVideoId && previewMode === 'source') && (
            <div className="w-full max-w-[320px] space-y-2">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleTogglePlay}
                  className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-100 hover:bg-slate-800"
                >
                  {isPlaying ? (
                    <>
                      <Pause className="h-3.5 w-3.5 text-blue-400" />
                      <span>Pause</span>
                    </>
                  ) : (
                    <>
                      <Play className="h-3.5 w-3.5 text-blue-400" />
                      <span>Play Highlight</span>
                    </>
                  )}
                </button>
                <button
                  type="button"
                  onClick={handleRestartSegment}
                  title="Jump back to highlight start and play"
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-800"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  <span>Restart</span>
                </button>
              </div>

              <div className="flex items-center justify-between font-mono text-[11px] tabular-nums text-slate-400">
                <span>
                  {formatTimecode(
                    previewMode === 'rendered' && activeHighlight.renderedVideoUrl
                      ? currentPlayTime
                      : Math.max(0, currentPlayTime - startTime)
                  )}
                </span>
                <span>
                  {formatTimecode(startTime)} – {formatTimecode(endTime)}
                </span>
                <span>{formatTimecode(Math.max(1, endTime - startTime))}</span>
              </div>
            </div>
          )}

          {videoError && (
            <div className="w-full max-w-[320px] rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-200 space-y-2">
              <p>{videoError}</p>
              {previewMode === 'rendered' && (
                <button
                  type="button"
                  onClick={() => {
                    setPreviewMode('source');
                    setVideoError(null);
                  }}
                  className="rounded border border-slate-700 bg-slate-900 px-2.5 py-1 text-xs font-medium text-slate-100 hover:bg-slate-800"
                >
                  Switch to Live Source Preview
                </button>
              )}
            </div>
          )}

          <p className="text-center text-xs text-slate-400 max-w-xs">
            {previewMode === 'thumbnail'
              ? '720×1280 9:16 stylized cover artwork matched to this highlight scene, hook writing, emojis, and overall video vibe.'
              : previewMode === 'rendered' && activeHighlight.renderedVideoUrl
              ? 'Playing actual FFmpeg-rendered 1080×1920 montage with voice-synced karaoke subtitles, hook card, and EBU R128 audio.'
              : project.hasLocalVideoFile === false && project.youtubeVideoId
              ? 'Previewing YouTube segment directly. Attach local MP4 or download with cookies below to unlock FFmpeg 9:16 rendering.'
              : aligningCues
              ? 'Synchronizing live captions with the voice track...'
              : 'Previewing live montage & voice-synced captions. Click "Render 9:16 MP4" to export dynamic cuts, color grade, and broadcast audio.'}
          </p>

          {project.hasLocalVideoFile === false && (
            <div className="w-full max-w-[320px] rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 space-y-3">
              <p className="text-xs font-medium text-amber-200">
                Local MP4 Required for 9:16 Export
              </p>
              <p className="text-xs text-slate-400">
                YouTube blocked direct MP4 download from this cloud IP. Attach the MP4 file from your device or paste YouTube cookies to download it.
              </p>

              <input
                ref={attachFileRef}
                type="file"
                accept=".mp4,.mov,.mkv,video/mp4,video/quicktime,video/x-matroska"
                className="hidden"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  setUpgradingSource(true);
                  try {
                    await onAttachLocalVideo(project.id, f);
                  } finally {
                    setUpgradingSource(false);
                  }
                }}
              />

              <button
                type="button"
                disabled={upgradingSource}
                onClick={() => attachFileRef.current?.click()}
                className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs font-medium text-slate-100 hover:bg-slate-800 disabled:opacity-50"
              >
                <Upload className="h-3.5 w-3.5" />
                <span>{upgradingSource ? 'Attaching...' : 'Attach Local MP4 / MOV'}</span>
              </button>

              {project.youtubeVideoId && (
                <div className="space-y-2 border-t border-slate-800 pt-2.5">
                  <input
                    type="text"
                    value={retryCookie}
                    onChange={(e) => setRetryCookie(e.target.value)}
                    placeholder="Paste YouTube Cookie header..."
                    className="w-full rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1.5 font-mono text-xs text-slate-100 placeholder:text-slate-500 focus:border-blue-500 focus:outline-none"
                  />
                  <button
                    type="button"
                    disabled={!retryCookie.trim() || upgradingSource}
                    onClick={async () => {
                      setUpgradingSource(true);
                      try {
                        await onRetryYouTubeDownload(project.id, retryCookie);
                      } finally {
                        setUpgradingSource(false);
                      }
                    }}
                    className="w-full rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50"
                  >
                    {upgradingSource ? 'Downloading MP4...' : 'Retry YouTube Download'}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right: Adaptive Editing Controls & QC */}
        <div className="lg:col-span-7 space-y-6">
          <section className="rounded-xl border border-slate-800 bg-[#111827] p-6 space-y-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block text-xs font-medium text-slate-300 sm:col-span-2">
                Clip Title
                <input
                  type="text"
                  dir={rtl ? 'rtl' : 'ltr'}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-blue-500 focus:outline-none"
                />
              </label>

              <label className="block text-xs font-medium text-slate-300 sm:col-span-2">
                On-Screen Hook Banner (first 3s)
                <input
                  type="text"
                  dir={rtl ? 'rtl' : 'ltr'}
                  value={hookHeadline}
                  onChange={(e) => setHookHeadline(e.target.value)}
                  placeholder={title.split(/\s+/).slice(0, 5).join(' ') || 'Punchy 3–5 word opening hook...'}
                  className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-blue-500 focus:outline-none"
                />
              </label>

              <label className="block text-xs font-medium text-slate-300 sm:col-span-2">
                Description
                <textarea
                  rows={2}
                  dir={rtl ? 'rtl' : 'ltr'}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-blue-500 focus:outline-none"
                />
              </label>

              {isRemix ? (
                <div className="sm:col-span-2 space-y-2.5 border-t border-slate-800 pt-4">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium text-slate-200">
                      Mix-and-Match Remix Cuts ({editSegments.length} segments · {remixTotalDuration.toFixed(1)}s)
                    </span>
                    <span className="text-slate-400">Click a cut to preview in player</span>
                  </div>
                  <div className="space-y-2">
                    {editSegments.map((seg, sIdx) => {
                      const srcDur = project.sources?.[seg.sourceIndex]?.metadata?.duration ?? 180;
                      return (
                        <div
                          key={seg.id || sIdx}
                          onClick={() => {
                            if (previewMode === 'source') {
                              setActiveSegIdx(sIdx);
                            }
                          }}
                          className={`flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-2 text-xs transition-colors ${
                            previewMode === 'source' && activeSegIdx === sIdx
                              ? 'border-blue-500/60 bg-blue-500/10'
                              : 'border-slate-800 bg-slate-900/70 hover:border-slate-700'
                          }`}
                        >
                          <div className="min-w-0 flex items-center gap-2">
                            <span className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] uppercase text-blue-400">
                              {seg.role}
                            </span>
                            <span className="font-medium text-slate-200 truncate">
                              Clip #{seg.sourceIndex + 1}: {seg.sourceFilename}
                            </span>
                          </div>
                          <div
                            className="flex items-center gap-2 font-mono"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <label className="flex items-center gap-1 text-slate-400">
                              <span>In</span>
                              <input
                                type="number"
                                min={0}
                                max={Math.max(0, seg.endTime - 1.5)}
                                step={0.2}
                                value={seg.startTime}
                                onChange={(e) => {
                                  const v = Math.max(0, Math.min(seg.endTime - 1.5, Number(e.target.value) || 0));
                                  setEditSegments((prev) =>
                                    prev.map((item, i) => (i === sIdx ? { ...item, startTime: Number(v.toFixed(2)) } : item))
                                  );
                                }}
                                className="w-16 rounded border border-slate-700 bg-slate-950 px-1.5 py-1 text-xs text-slate-100"
                              />
                            </label>
                            <label className="flex items-center gap-1 text-slate-400">
                              <span>Out</span>
                              <input
                                type="number"
                                min={seg.startTime + 1.5}
                                max={srcDur}
                                step={0.2}
                                value={seg.endTime}
                                onChange={(e) => {
                                  const v = Math.min(srcDur, Math.max(seg.startTime + 1.5, Number(e.target.value) || seg.startTime + 2));
                                  setEditSegments((prev) =>
                                    prev.map((item, i) => (i === sIdx ? { ...item, endTime: Number(v.toFixed(2)) } : item))
                                  );
                                }}
                                className="w-16 rounded border border-slate-700 bg-slate-950 px-1.5 py-1 text-xs text-slate-100"
                              />
                            </label>
                            <select
                              aria-label="Segment Sound Effect"
                              value={seg.sfxCue ?? 'auto'}
                              onChange={(e) => {
                                const val = e.target.value as SfxCueType | 'auto' | 'none';
                                setEditSegments((prev) =>
                                  prev.map((item, i) =>
                                    i === sIdx
                                      ? { ...item, sfxCue: val === 'auto' ? undefined : val }
                                      : item
                                  )
                                );
                              }}
                              className="rounded border border-slate-700 bg-slate-950 px-1.5 py-1 text-[11px] font-sans text-slate-200"
                            >
                              <option value="auto">SFX: Auto Scene</option>
                              <option value="shock-boom">Shock Boom</option>
                              <option value="buzz-zap">Buzz / Zap</option>
                              <option value="clever-ding">Clever Ding</option>
                              <option value="mouse-click">Mouse Click</option>
                              <option value="pop-bubble">Pop Bubble</option>
                              <option value="cash-sparkle">Sparkle Reveal</option>
                              <option value="whoosh-swish">Whoosh Cut</option>
                              <option value="riser-hit">Riser Hit</option>
                              <option value="none">No SFX</option>
                            </select>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <>
                  {/* Trim Start / End */}
                  <div>
                    <div className="flex justify-between text-xs text-slate-300">
                      <span>Start Time</span>
                      <span className="font-mono tabular-nums text-blue-400">
                        {formatTimecode(startTime)}
                      </span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={Math.max(0, endTime - 2)}
                      step={0.1}
                      value={startTime}
                      onChange={(e) => setStartTime(Number(e.target.value))}
                      className="mt-2 w-full accent-blue-500"
                    />
                  </div>

                  <div>
                    <div className="flex justify-between text-xs text-slate-300">
                      <span>End Time</span>
                      <span className="font-mono tabular-nums text-blue-400">
                        {formatTimecode(endTime)}
                      </span>
                    </div>
                    <input
                      type="range"
                      min={Math.min(maxSourceDuration, startTime + 2)}
                      max={maxSourceDuration}
                      step={0.1}
                      value={endTime}
                      onChange={(e) => setEndTime(Number(e.target.value))}
                      className="mt-2 w-full accent-blue-500"
                    />
                  </div>
                </>
              )}
            </div>

            {/* Adaptive Editing Profile & Framing */}
            <div className="grid gap-4 border-t border-slate-800 pt-5 sm:grid-cols-2">
              <label className="block text-xs font-medium text-slate-300">
                Adaptive Editing Profile
                <select
                  value={editingProfile}
                  onChange={(e) => handleProfileChange(e.target.value as EditingProfileId)}
                  className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-blue-500 focus:outline-none"
                >
                  {editingProfiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="block text-xs font-medium text-slate-300">
                Smart Crop & Framing
                <select
                  value={cropMode}
                  onChange={(e) => setCropMode(e.target.value as CropFocusMode)}
                  className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-blue-500 focus:outline-none"
                >
                  <option value="auto-speaker">Auto Speaker Framing</option>
                  <option value="center">Center Crop (9:16)</option>
                  <option value="left-subject">Left Subject Focus</option>
                  <option value="right-subject">Right Subject Focus</option>
                  <option value="fit-blur">Fit Frame + Blur Fill (Slides/Edu)</option>
                </select>
              </label>

              <label className="block text-xs font-medium text-slate-300">
                Subtitle Animation Style
                <select
                  value={subtitleStyle}
                  onChange={(e) => setSubtitleStyle(e.target.value as SubtitleStylePreset)}
                  className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-blue-500 focus:outline-none"
                >
                  <option value="clean">Clean Editorial</option>
                  <option value="bold-highlight">Bold Keyword Highlight</option>
                  <option value="karaoke-pop">Dynamic Pop Captions</option>
                  <option value="minimal-caption">Minimal Subtle Captions</option>
                </select>
              </label>

              <label className="block text-xs font-medium text-slate-300">
                Keyword Highlight Color
                <div className="mt-1.5 flex items-center gap-2">
                  <input
                    type="color"
                    value={highlightColor}
                    onChange={(e) => setHighlightColor(e.target.value)}
                    className="h-9 w-12 cursor-pointer rounded border border-slate-700 bg-slate-900 p-1"
                  />
                  <span className="font-mono text-xs text-slate-300">{highlightColor}</span>
                </div>
              </label>

              <label className="block text-xs font-medium text-slate-300">
                Background Music (Auto-Ducked)
                <select
                  value={bgmVibe}
                  onChange={(e) => setBgmVibe(e.target.value as BgmVibe)}
                  className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-blue-500 focus:outline-none"
                >
                  <option value="auto">Auto Match Vibe &amp; Brief</option>
                  <option value="upbeat-pop">Upbeat Lifestyle / Holiday Pop</option>
                  <option value="lofi-warm">Warm Lo-Fi Chill Groove</option>
                  <option value="hype-beat">Energetic Hype Beat</option>
                  <option value="cinematic-warm">Cinematic Warm Emotional Pad</option>
                  <option value="none">Voice Only (No Music)</option>
                </select>
              </label>

              <label className="block text-xs font-medium text-slate-300">
                Cut Transitions
                <select
                  value={transitionStyle}
                  onChange={(e) => setTransitionStyle(e.target.value as TransitionStyle)}
                  className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-blue-500 focus:outline-none"
                >
                  <option value="auto">Auto Match Editing Profile</option>
                  <option value="whip-slide">Whip Slide &amp; Smooth Push</option>
                  <option value="zoom-punch">Circle Open &amp; Radial Blur</option>
                  <option value="dissolve">Smooth Dissolve &amp; Fade</option>
                  <option value="flash-cut">Flash Cut &amp; Motion Blur</option>
                  <option value="hard-cut">Clean Snap Hard Cut</option>
                </select>
              </label>

              <label className="block text-xs font-medium text-slate-300">
                Camera Motion &amp; Impact Vibration
                <select
                  value={cameraEnergy}
                  onChange={(e) => setCameraEnergy(e.target.value as CameraEnergy)}
                  className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-blue-500 focus:outline-none"
                >
                  <option value="auto">Auto Match Profile</option>
                  <option value="viral-shake">Viral Impact Shake + Fast Zoom In/Out</option>
                  <option value="dynamic">Dynamic Zoom In / Zoom Out Pullback</option>
                  <option value="calm">Steady / Gentle Framing</option>
                </select>
              </label>

              <label className="block text-xs font-medium text-slate-300">
                Scene Sound Effects (SFX)
                <select
                  value={sfxMode}
                  onChange={(e) => setSfxMode(e.target.value as SfxMode)}
                  className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-blue-500 focus:outline-none"
                >
                  <option value="auto">Auto Match Scene &amp; Brief</option>
                  <option value="playful-viral">Playful Viral (Pops, Buzz, Sparkle, Ding)</option>
                  <option value="dramatic-impact">Dramatic Impact (Shock Boom, Riser, Whoosh)</option>
                  <option value="smart-ui">Smart &amp; Clever (Mouse Click, Lightbulb Ding)</option>
                  <option value="subtle-clean">Subtle Pro Transitions</option>
                  <option value="none">No Sound Effects</option>
                </select>
              </label>

              <label className="block text-xs font-medium text-slate-300 sm:col-span-2">
                Opening Hook Sound Effect
                <select
                  value={hookSfx}
                  onChange={(e) => setHookSfx(e.target.value as SfxCueType | 'auto' | 'none')}
                  disabled={sfxMode === 'none'}
                  className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-blue-500 focus:outline-none disabled:opacity-45"
                >
                  <option value="auto">Auto Match Hook Emotion</option>
                  <option value="shock-boom">Shock / Dramatic Boom</option>
                  <option value="clever-ding">Clever Lightbulb Ding</option>
                  <option value="buzz-zap">Electric Buzz / Zap</option>
                  <option value="mouse-click">Mouse Click / UI Pop</option>
                  <option value="pop-bubble">Playful Bubble Pop</option>
                  <option value="cash-sparkle">Gift / Reveal Sparkle</option>
                  <option value="whoosh-swish">Fast Air Whoosh</option>
                  <option value="riser-hit">Suspense Riser Hit</option>
                  <option value="none">No Opening Sound</option>
                </select>
              </label>

              {/* Cover Thumbnail & Vibe Controls */}
              <div className="sm:col-span-2 border-t border-slate-800 pt-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h4 className="text-xs font-semibold text-slate-100">
                      Cover Thumbnail &amp; Vibe Design
                    </h4>
                    <p className="text-[11px] text-slate-400">
                      Custom 9:16 cover writing, expressive emojis, and graphic art direction matched to this clip.
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={regeneratingThumb}
                    onClick={handleRegenerateCover}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-blue-500/40 bg-blue-500/10 px-3 py-1.5 text-xs font-medium text-blue-300 hover:bg-blue-500/20 disabled:opacity-50 whitespace-nowrap"
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${regeneratingThumb ? 'animate-spin' : ''}`} />
                    <span>{regeneratingThumb ? 'Designing Cover...' : 'Apply & Regenerate Cover'}</span>
                  </button>
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="block text-xs font-medium text-slate-300">
                    Thumbnail Design Vibe
                    <select
                      value={thumbnailStyle}
                      onChange={(e) => setThumbnailStyle(e.target.value as ThumbnailVibeStyle)}
                      className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-blue-500 focus:outline-none"
                    >
                      <option value="auto">Auto Match Video Vibe</option>
                      <option value="viral-pop">Viral Pop (Diagonal Accent &amp; Glow)</option>
                      <option value="lifestyle-warm">Lifestyle / Holiday Warm (Editorial Blush)</option>
                      <option value="comedy-sticker">Comedy Sticker Card (Bold Pop Outline)</option>
                      <option value="cinematic-editorial">Cinematic Editorial (Serif &amp; Hairline)</option>
                      <option value="tech-neon">Tech &amp; Gaming Neon (HUD Brackets)</option>
                      <option value="podcast-quote">Podcast Quote (Studio Statement)</option>
                    </select>
                  </label>

                  <label className="block text-xs font-medium text-slate-300">
                    Cover Writing (2–5 punchy words)
                    <input
                      type="text"
                      dir={rtl ? 'rtl' : 'ltr'}
                      value={thumbnailText}
                      onChange={(e) => setThumbnailText(e.target.value)}
                      placeholder="SAINT NIC TAX"
                      className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-blue-500 focus:outline-none"
                    />
                  </label>

                  <div className="sm:col-span-2 space-y-2">
                    <label className="block text-xs font-medium text-slate-300">
                      Cover Emojis (space-separated, up to 3)
                      <input
                        type="text"
                        value={thumbnailEmojisInput}
                        onChange={(e) => setThumbnailEmojisInput(e.target.value)}
                        placeholder="🎅 🎁 ✨"
                        className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-blue-500 focus:outline-none"
                      />
                    </label>
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="text-[11px] text-slate-400">Quick packs:</span>
                      {[
                        '🎅 🎁 ✨',
                        '😭 💀 🔥',
                        '😱 🚨 👀',
                        '💖 ✨ 💁‍♀️',
                        '🎙️ 💯 🔥',
                        '⚡ 🧠 🚀',
                      ].map((pack) => (
                        <button
                          key={pack}
                          type="button"
                          onClick={() => setThumbnailEmojisInput(pack)}
                          className="rounded border border-slate-700 bg-slate-900 px-2 py-0.5 text-xs text-slate-200 hover:border-slate-500"
                        >
                          {pack}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="flex flex-wrap gap-6 border-t border-slate-800 pt-4 text-xs text-slate-200">
              <label className="inline-flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={normalizeAudio}
                  onChange={(e) => setNormalizeAudio(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-600 accent-blue-500"
                />
                <span>EBU R128 Audio Normalization</span>
              </label>

              <label className="inline-flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={dynamicZoom}
                  onChange={(e) => setDynamicZoom(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-600 accent-blue-500"
                />
                <span>Subtle Dynamic Zoom</span>
              </label>

              <label className="inline-flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={watermarkEnabled}
                  onChange={(e) => setWatermarkEnabled(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-600 accent-blue-500"
                />
                <span>Include Watermark</span>
              </label>
            </div>

            {/* Action Buttons */}
            <div className="flex flex-wrap items-center gap-3 border-t border-slate-800 pt-5">
              <button
                type="button"
                disabled={saving}
                onClick={persistCurrentSettings}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-3.5 py-2 text-xs font-medium text-slate-100 hover:bg-slate-800 disabled:opacity-50"
              >
                <Save className="h-3.5 w-3.5" />
                <span>{saving ? 'Saving...' : 'Save Edits'}</span>
              </button>

              <button
                type="button"
                disabled={rendering}
                onClick={handleRender}
                className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50"
              >
                {rendering ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    <span>Rendering 1080×1920...</span>
                  </>
                ) : (
                  <>
                    <Wand2 className="h-3.5 w-3.5" />
                    <span>Render 9:16 MP4 (FFmpeg)</span>
                  </>
                )}
              </button>

              <button
                type="button"
                disabled={exporting}
                onClick={handleExport}
                className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-2 text-xs font-medium text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-50"
              >
                {exporting ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    <span>Exporting...</span>
                  </>
                ) : (
                  <>
                    <Download className="h-3.5 w-3.5" />
                    <span>Export Locally</span>
                  </>
                )}
              </button>
            </div>
          </section>

          {/* Quality Control Agent Panel */}
          <section className="rounded-xl border border-slate-800 bg-[#111827] p-6 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-slate-100">
                  Quality Control Agent Report
                </h3>
                <p className="text-xs text-slate-400">
                  Validates FFprobe resolution, codec integrity, complete speech framing, and category fit.
                </p>
              </div>
              {qc && (
                <span
                  className={`text-xs font-semibold ${
                    qc.passed ? 'text-emerald-400' : 'text-amber-400'
                  }`}
                >
                  {qc.passed ? 'Passed All Checks' : `${qc.fixableIssues.length} Fixable Issue(s)`}
                </span>
              )}
            </div>

            {!qc ? (
              <p className="text-xs text-slate-400">
                Render this clip to execute automated Quality Control validation.
              </p>
            ) : (
              <>
                <div className="divide-y divide-slate-800/80">
                  {qc.checks.map((chk) => (
                    <div key={chk.name} className="flex items-start justify-between gap-4 py-2.5 first:pt-0 last:pb-0">
                      <div className="flex items-start gap-2.5">
                        {chk.status === 'pass' ? (
                          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
                        ) : chk.status === 'warn' ? (
                          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
                        ) : (
                          <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
                        )}
                        <div>
                          <p className="text-xs font-medium text-slate-200">{chk.name}</p>
                          <p className="text-xs text-slate-400">{chk.detail}</p>
                        </div>
                      </div>
                      <span className="font-mono text-xs uppercase text-slate-400 shrink-0">
                        {chk.status}
                      </span>
                    </div>
                  ))}
                </div>

                {qc.fixableIssues.length > 0 && (
                  <div className="flex items-center justify-between gap-4 border-t border-slate-800 pt-4">
                    <p className="text-xs text-amber-300">
                      Fixable: {qc.fixableIssues.join(' · ')}
                    </p>
                    <button
                      type="button"
                      disabled={healing}
                      onClick={handleAutoHeal}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-amber-600 px-3.5 py-2 text-xs font-medium text-white hover:bg-amber-500 disabled:opacity-50 whitespace-nowrap shrink-0"
                    >
                      <RefreshCw className={`h-3.5 w-3.5 ${healing ? 'animate-spin' : ''}`} />
                      <span>{healing ? 'Regenerating...' : 'Auto-Regenerate Clip'}</span>
                    </button>
                  </div>
                )}
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
