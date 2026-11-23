import {
  AlertTriangle,
  CheckCircle2,
  Download,
  Film,
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
  CropFocusMode,
  EditingProfileId,
  EditingProfileSpec,
  HighlightRecord,
  ProjectRecord,
  SubtitleStylePreset,
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
  const [previewMode, setPreviewMode] = useState<'rendered' | 'source'>('rendered');
  const [currentPlayTime, setCurrentPlayTime] = useState(0);

  const [saving, setSaving] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [healing, setHealing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [retryCookie, setRetryCookie] = useState('');
  const [upgradingSource, setUpgradingSource] = useState(false);

  const [isPlaying, setIsPlaying] = useState(false);
  const [videoBuffering, setVideoBuffering] = useState(false);
  const [videoError, setVideoError] = useState<string | null>(null);

  const sourceVideoRef = useRef<HTMLVideoElement | null>(null);
  const renderedVideoRef = useRef<HTMLVideoElement | null>(null);
  const attachFileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!activeHighlight) return;
    setTitle(activeHighlight.title);
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
    setPreviewMode(activeHighlight.renderedVideoUrl ? 'rendered' : 'source');
    setCurrentPlayTime(activeHighlight.renderedVideoUrl ? 0 : activeHighlight.startTime);
    setIsPlaying(false);
    setVideoError(null);
  }, [activeHighlight?.id, activeHighlight?.renderedVideoUrl]);

  // Keep source preview synced to startTime once video metadata is ready
  useEffect(() => {
    const el = sourceVideoRef.current;
    if (previewMode === 'source' && el && activeHighlight && el.readyState >= 1) {
      if (Math.abs(el.currentTime - startTime) > 0.25) {
        el.currentTime = startTime;
      }
      setCurrentPlayTime(startTime);
    }
  }, [previewMode, startTime, activeHighlight?.id]);

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

  const activeTranscriptLine = useMemo(() => {
    if (!project.transcript.length) return null;
    const t = previewMode === 'rendered' ? startTime + currentPlayTime : currentPlayTime;
    return (
      project.transcript.find((seg) => t >= seg.start && t <= seg.end) ??
      project.transcript.find((seg) => seg.end >= startTime && seg.start <= endTime) ??
      null
    );
  }, [project.transcript, currentPlayTime, previewMode, startTime, endTime]);

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

  const persistCurrentSettings = async () => {
    setSaving(true);
    try {
      await onSaveHighlight(activeHighlight.id, {
        title,
        description,
        startTime,
        endTime,
        duration: Math.max(1, Number((endTime - startTime).toFixed(2))),
        editingProfile,
        subtitleStyle,
        highlightColor,
        cropMode,
        dynamicZoom,
        normalizeAudio,
        watermarkEnabled,
      });
    } finally {
      setSaving(false);
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
      el.pause();
      return;
    }

    if (!isRendered && (el.currentTime < startTime - 0.5 || el.currentTime >= endTime - 0.15)) {
      el.currentTime = startTime;
    }

    try {
      await el.play();
    } catch (err) {
      setVideoError(err instanceof Error ? err.message : 'Unable to start video playback.');
    }
  };

  const handleRestartSegment = async () => {
    const isRendered = previewMode === 'rendered' && Boolean(activeHighlight.renderedVideoUrl);
    const el = isRendered ? renderedVideoRef.current : sourceVideoRef.current;
    if (!el) return;
    setVideoError(null);
    el.currentTime = isRendered ? 0 : startTime;
    setCurrentPlayTime(isRendered ? 0 : startTime);
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
  const rtl = isArabicText(activeTranscriptLine?.text || title);

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
          <div className="flex items-center gap-1 rounded-lg border border-slate-800 bg-slate-900 p-1">
            <button
              type="button"
              disabled={!activeHighlight.renderedVideoUrl}
              onClick={() => setPreviewMode('rendered')}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap disabled:opacity-40 ${
                previewMode === 'rendered'
                  ? 'bg-slate-800 text-slate-50'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Rendered 1080×1920 MP4
            </button>
            <button
              type="button"
              onClick={() => setPreviewMode('source')}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                previewMode === 'source'
                  ? 'bg-slate-800 text-slate-50'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Live Source Preview
            </button>
          </div>

          <div className="relative w-full max-w-[320px] aspect-[9/16] overflow-hidden rounded-2xl border border-slate-700 bg-black">
            {previewMode === 'rendered' && activeHighlight.renderedVideoUrl ? (
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
                  key={project.sourceUrl}
                  ref={sourceVideoRef}
                  src={project.sourceUrl}
                  preload="metadata"
                  controls
                  playsInline
                  onLoadedMetadata={(e) => {
                    setVideoError(null);
                    setVideoBuffering(false);
                    if (Math.abs(e.currentTarget.currentTime - startTime) > 0.25) {
                      e.currentTarget.currentTime = startTime;
                    }
                    setCurrentPlayTime(startTime);
                  }}
                  onCanPlay={() => setVideoBuffering(false)}
                  onWaiting={() => setVideoBuffering(true)}
                  onPlay={(e) => {
                    if (
                      e.currentTarget.currentTime < startTime - 0.5 ||
                      e.currentTarget.currentTime >= endTime - 0.15
                    ) {
                      e.currentTarget.currentTime = startTime;
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
                    if (t >= endTime) {
                      e.currentTarget.pause();
                      e.currentTarget.currentTime = startTime;
                      setIsPlaying(false);
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
                {/* Interactive Live Caption Overlay on Source Preview */}
                {activeTranscriptLine && (
                  <div className="pointer-events-none absolute inset-x-4 bottom-16 text-center">
                    <span
                      dir={rtl ? 'rtl' : 'ltr'}
                      className={`inline-block rounded px-2.5 py-1 text-sm leading-snug text-white bg-black/65 ${
                        subtitleStyle === 'bold-highlight' || subtitleStyle === 'karaoke-pop'
                          ? 'font-bold'
                          : 'font-medium'
                      }`}
                    >
                      {activeTranscriptLine.text.split(/\s+/).slice(0, 8).map((word, idx) => {
                        const isKw = activeHighlight.keywords.some((k) =>
                          word.toLowerCase().includes(k.toLowerCase())
                        );
                        return (
                          <span
                            key={idx}
                            style={
                              isKw && subtitleStyle !== 'minimal-caption'
                                ? { color: highlightColor }
                                : undefined
                            }
                          >
                            {word}{' '}
                          </span>
                        );
                      })}
                    </span>
                  </div>
                )}
              </>
            )}

            {videoBuffering && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/45">
                <Loader2 className="h-7 w-7 animate-spin text-blue-400" />
              </div>
            )}
          </div>

          {/* Segment Playback Controls */}
          {!(project.hasLocalVideoFile === false && project.youtubeVideoId && previewMode === 'source') && (
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
            {previewMode === 'rendered' && activeHighlight.renderedVideoUrl
              ? 'Playing actual FFmpeg-rendered 1080×1920 H.264/AAC clip with burned-in subtitles.'
              : project.hasLocalVideoFile === false && project.youtubeVideoId
              ? 'Previewing YouTube segment directly. Attach local MP4 or download with cookies below to unlock FFmpeg 9:16 rendering.'
              : 'Previewing source range. Click "Render 9:16 MP4" to burn subtitles, apply crop, and normalize audio.'}
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
                Description
                <textarea
                  rows={2}
                  dir={rtl ? 'rtl' : 'ltr'}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-blue-500 focus:outline-none"
                />
              </label>

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
