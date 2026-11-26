import { CheckCircle2, FileVideo, Layers, Link2, Loader2, Play, Plus, RefreshCw, Upload, Wand2, X } from 'lucide-react';
import React, { useRef, useState } from 'react';
import type { ProjectRecord } from '../types/studio';
import { formatBytes } from '../utils/format';
import {
  stageVideoInChunks,
  uploadVideoInChunks,
  type StagedUploadFile,
  type UploadProgressStats,
} from '../utils/uploadVideo';
import type { StudioPage } from '../components/Sidebar';

interface SamplePresetInfo {
  id: 'business_podcast_en' | 'tech_tutorial_fr' | 'motivation_ar';
  title: string;
  languageLabel: string;
  categoryHint: string;
}

interface NewVideoPageProps {
  samplePresets: SamplePresetInfo[];
  activeProject: ProjectRecord | null;
  onProjectCreated: (project: ProjectRecord) => void;
  onRetryProject: (id: string) => Promise<void>;
  onNavigate: (page: StudioPage) => void;
  onError: (msg: string) => void;
}

const PIPELINE_STEPS: Array<{ key: ProjectRecord['currentStage']; label: string; detail: string }> = [
  {
    key: 'ingesting',
    label: '1. Video Ingestion Agent',
    detail: 'FFprobe stream validation, FFmpeg audio extraction, and scene keyframe capture.',
  },
  {
    key: 'transcribing',
    label: '2. Transcription Agent',
    detail: 'Timestamped speech recognition (EN / FR / AR) with sentence boundary and speaker detection.',
  },
  {
    key: 'analyzing',
    label: '3. Content Understanding & Category Agents',
    detail: 'Multi-label classification, topic extraction, audience profiling, and editing profile selection.',
  },
  {
    key: 'extracting_highlights',
    label: '4. Category Highlight & Scoring Engine',
    detail: 'Evaluates hook strength, standalone context, informational value, and sentence completeness.',
  },
];

export function NewVideoPage({
  samplePresets,
  activeProject,
  onProjectCreated,
  onRetryProject,
  onNavigate,
  onError,
}: NewVideoPageProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [sourceTab, setSourceTab] = useState<'file' | 'youtube'>('file');

  // Local file(s) state (supports single video or multi-video remix queue)
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [customTitle, setCustomTitle] = useState('');
  const [brief, setBrief] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadPercent, setUploadPercent] = useState(0);
  const [uploadStatusLabel, setUploadStatusLabel] = useState('');
  const [uploadStats, setUploadStats] = useState<UploadProgressStats | null>(null);

  // YouTube import state
  const [ytUrl, setYtUrl] = useState('');
  const [ytTitle, setYtTitle] = useState('');
  const [ytCookie, setYtCookie] = useState('');
  const [showYtCookie, setShowYtCookie] = useState(false);
  const [importingYt, setImportingYt] = useState(false);

  // Sample synthesizer state
  const [synthesizingId, setSynthesizingId] = useState<string | null>(null);

  const BRIEF_TEMPLATES: Array<{ label: string; text: string }> = [
    {
      label: 'Brand Campaign Remix (Mix & Match)',
      text: 'NO RAW REPOSTS: Mix & match cuts across all clips into 5+ distinct viral styles. Show the brand/product clearly on screen in EVERY clip, open with a 1-2s hook, keep subject positive/sweet, NEVER alter or speed up voice, and follow required @tags & language in captions.',
    },
    {
      label: 'Viral Hooks & Fast Cuts',
      text: 'Pick the sharpest 20-45s hooks for TikTok/Reels with high-energy dynamic zoom, bold karaoke subtitles, and an attention-grabbing headline.',
    },
    {
      label: 'Podcast & Dual-Speaker',
      text: 'Focus on strong opinions, debates, and memorable stories; use speaker-switching framing, punchy hooks, and bold highlighted subtitles.',
    },
    {
      label: 'Tutorial / Slides',
      text: 'Extract complete step-by-step tips; keep screens and slides uncropped (fit-blur) with clean readable subtitles and no aggressive zoom.',
    },
    {
      label: 'Cinematic / Storytelling',
      text: 'Select emotional or inspiring complete narratives; keep pacing natural with cinematic framing and clean captions.',
    },
  ];

  const handleFilesAdded = (fileList: FileList | File[] | null) => {
    if (!fileList || fileList.length === 0) return;
    const valid: File[] = [];
    for (const file of Array.from(fileList)) {
      const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
      if (!['mp4', 'mov', 'mkv'].includes(ext)) {
        onError(`Unsupported file format (${file.name}). Please select MP4, MOV, or MKV videos.`);
        return;
      }
      valid.push(file);
    }
    setSelectedFiles((prev) => {
      const merged = [...prev];
      for (const f of valid) {
        const dup = merged.some(
          (m) => m.name === f.name && m.size === f.size && m.lastModified === f.lastModified
        );
        if (!dup) merged.push(f);
      }
      if (!customTitle && merged.length > 0) {
        setCustomTitle(
          merged.length === 1
            ? merged[0].name.replace(/\.[^/.]+$/, '')
            : `${merged[0].name.replace(/\.[^/.]+$/, '')} Remix (${merged.length} clips)`
        );
      }
      return merged;
    });
  };

  const handleRemoveFile = (index: number) => {
    setSelectedFiles((prev) => prev.filter((_, idx) => idx !== index));
  };

  const handleUploadSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedFiles.length === 0) return;

    setUploading(true);
    setUploadPercent(0);
    setUploadStats(null);
    setUploadStatusLabel('');

    try {
      if (selectedFiles.length === 1) {
        const file = selectedFiles[0];
        setUploadStatusLabel(`Uploading ${file.name}...`);
        const project = await uploadVideoInChunks({
          file,
          title: customTitle.trim() || file.name,
          brief: brief.trim() || undefined,
          onProgress: (pct, stats) => {
            setUploadPercent(pct);
            if (stats) setUploadStats(stats);
          },
        });
        setSelectedFiles([]);
        setCustomTitle('');
        setBrief('');
        onProjectCreated(project);
        return;
      }

      // Multi-Video Mix-and-Match Remix Upload
      const totalBytesAll = selectedFiles.reduce((acc, f) => acc + f.size, 0) || 1;
      let completedBytes = 0;
      const stagedFiles: StagedUploadFile[] = [];

      for (let i = 0; i < selectedFiles.length; i++) {
        const file = selectedFiles[i];
        setUploadStatusLabel(`Uploading clip ${i + 1}/${selectedFiles.length}: ${file.name}`);
        const staged = await stageVideoInChunks({
          file,
          onProgress: (_pct, stats) => {
            if (stats) {
              const overallUploaded = completedBytes + stats.uploadedBytes;
              const overallPct = Math.min(99, Math.round((overallUploaded / totalBytesAll) * 100));
              setUploadPercent(overallPct);
              setUploadStats({
                ...stats,
                uploadedBytes: overallUploaded,
                totalBytes: totalBytesAll,
                percent: overallPct,
              });
            }
          },
        });
        completedBytes += file.size;
        stagedFiles.push(staged);
      }

      setUploadStatusLabel('Creating Multi-Video Remix project...');
      const res = await fetch('/api/projects/remix', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: customTitle.trim() || `Multi-Clip Remix (${selectedFiles.length} clips)`,
          brief: brief.trim() || undefined,
          stagedFiles,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.project) {
        throw new Error(data.error || 'Failed to create multi-video remix project');
      }

      setUploadPercent(100);
      setSelectedFiles([]);
      setCustomTitle('');
      setBrief('');
      onProjectCreated(data.project);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
      setUploadStatusLabel('');
    }
  };

  const handleYouTubeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ytUrl.trim()) return;

    setImportingYt(true);
    try {
      const res = await fetch('/api/projects/youtube', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: ytUrl.trim(),
          title: ytTitle.trim() || undefined,
          brief: brief.trim() || undefined,
          cookie: ytCookie.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to import YouTube video');
      }
      setYtUrl('');
      setYtTitle('');
      setBrief('');
      onProjectCreated(data.project);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'YouTube import failed');
    } finally {
      setImportingYt(false);
    }
  };

  const handleSynthesizeSample = async (presetId: SamplePresetInfo['id']) => {
    setSynthesizingId(presetId);
    try {
      const res = await fetch('/api/projects/sample', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ presetId }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to generate test video');
      }
      onProjectCreated(data.project);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Sample synthesis failed');
    } finally {
      setSynthesizingId(null);
    }
  };

  const currentStageIndex = activeProject
    ? PIPELINE_STEPS.findIndex((s) => s.key === activeProject.currentStage)
    : -1;

  return (
    <div className="mx-auto max-w-6xl space-y-8 p-6 lg:p-8">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight text-slate-50">
          Import Videos &amp; Campaign Brief
        </h2>
        <p className="mt-1 text-sm text-slate-400">
          Upload a single long-form video OR multiple short raw clips to mix &amp; match into distinct viral edits guided by your Consigne.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-12 items-start">
        {/* Source Importer Card */}
        <div className="lg:col-span-7 rounded-xl border border-slate-800 bg-[#111827] p-6 space-y-5">
          {/* Segmented Source Mode Tabs */}
          <div className="inline-flex items-center gap-1 rounded-lg border border-slate-800 bg-slate-900 p-1">
            <button
              type="button"
              onClick={() => setSourceTab('file')}
              className={`inline-flex items-center gap-2 rounded-md px-3.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                sourceTab === 'file'
                  ? 'bg-slate-800 text-slate-50'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Upload className="h-3.5 w-3.5" />
              <span>Local Video File</span>
            </button>
            <button
              type="button"
              onClick={() => setSourceTab('youtube')}
              className={`inline-flex items-center gap-2 rounded-md px-3.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                sourceTab === 'youtube'
                  ? 'bg-slate-800 text-slate-50'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Link2 className="h-3.5 w-3.5" />
              <span>YouTube Link</span>
            </button>
          </div>

          {sourceTab === 'file' ? (
            <form onSubmit={handleUploadSubmit} className="space-y-5">
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setIsDragging(true);
                }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setIsDragging(false);
                  handleFilesAdded(e.dataTransfer.files);
                }}
                onClick={() => fileInputRef.current?.click()}
                className={`cursor-pointer rounded-xl border border-dashed p-8 text-center transition-colors ${
                  isDragging
                    ? 'border-blue-500 bg-blue-500/10'
                    : 'border-slate-700 bg-slate-900/50 hover:border-slate-600'
                }`}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept=".mp4,.mov,.mkv,video/mp4,video/quicktime,video/x-matroska"
                  className="hidden"
                  onChange={(e) => {
                    handleFilesAdded(e.target.files);
                    e.target.value = '';
                  }}
                />
                <Upload className="mx-auto h-8 w-8 text-slate-400" />
                <p className="mt-3 text-sm font-medium text-slate-100">
                  {selectedFiles.length === 0
                    ? 'Drop 1 long video OR multiple short MP4/MOV clips here'
                    : `${selectedFiles.length} video${selectedFiles.length > 1 ? 's' : ''} queued (${formatBytes(
                        selectedFiles.reduce((acc, f) => acc + f.size, 0)
                      )})`}
                </p>
                <p className="mt-1 text-xs text-slate-400">
                  {selectedFiles.length > 1
                    ? 'Multi-Clip Mix-and-Match Remix active — click to add more clips'
                    : 'Select multiple short clips to mix & match into varied viral styles, or 1 long-form video up to 10 GB'}
                </p>
              </div>

              {selectedFiles.length > 0 && (
                <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-3 space-y-2">
                  <div className="flex items-center justify-between text-xs">
                    <span className="inline-flex items-center gap-1.5 font-medium text-slate-200">
                      <Layers className="h-3.5 w-3.5 text-blue-400" />
                      {selectedFiles.length > 1
                        ? `Multi-Video Remix Pool (${selectedFiles.length} clips)`
                        : 'Selected Video'}
                    </span>
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="inline-flex items-center gap-1 text-blue-400 hover:text-blue-300"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      <span>Add More Clips</span>
                    </button>
                  </div>
                  <div className="max-h-36 overflow-y-auto divide-y divide-slate-800/80">
                    {selectedFiles.map((file, idx) => (
                      <div key={`${file.name}_${file.lastModified}_${idx}`} className="flex items-center justify-between gap-2 py-1.5 text-xs">
                        <div className="min-w-0 flex items-center gap-2">
                          <span className="font-mono text-[11px] text-blue-400 shrink-0">
                            #{idx + 1}
                          </span>
                          <span className="truncate text-slate-200">{file.name}</span>
                          <span className="font-mono text-[11px] text-slate-400 shrink-0">
                            {formatBytes(file.size)}
                          </span>
                        </div>
                        <button
                          type="button"
                          disabled={uploading}
                          onClick={() => handleRemoveFile(idx)}
                          className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-rose-400 disabled:opacity-40"
                          aria-label={`Remove ${file.name}`}
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-slate-300">
                  Project / Campaign Title
                  <input
                    type="text"
                    value={customTitle}
                    onChange={(e) => setCustomTitle(e.target.value)}
                    placeholder="e.g., Kitsch x Nic Vans Holiday Campaign"
                    className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-900 px-3.5 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-blue-500 focus:outline-none"
                  />
                </label>
              </div>

              <div className="space-y-2">
                <label className="block text-xs font-medium text-slate-300">
                  AI Consigne / Campaign Brief (Guides clip selection, rules, edits &amp; social tags)
                  <textarea
                    rows={4}
                    value={brief}
                    onChange={(e) => setBrief(e.target.value)}
                    placeholder="Paste your full campaign brief or editing instructions (e.g., rules, required product visibility, hook ideas, no voice altering, TikTok @tag / IG @tag)..."
                    className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-900 px-3.5 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-blue-500 focus:outline-none"
                  />
                </label>
                <div className="flex flex-wrap gap-1.5">
                  {BRIEF_TEMPLATES.map((tpl) => (
                    <button
                      key={tpl.label}
                      type="button"
                      onClick={() => setBrief(tpl.text)}
                      className="rounded-md border border-slate-700 bg-slate-900 px-2.5 py-1 text-[11px] font-medium text-slate-300 transition-colors hover:border-blue-500/60 hover:text-slate-100"
                    >
                      + {tpl.label}
                    </button>
                  ))}
                </div>
              </div>

              {selectedFiles.reduce((acc, f) => acc + f.size, 0) > 1.5 * 1024 * 1024 * 1024 && (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3.5 py-2.5 text-xs text-amber-200 leading-relaxed">
                  Large total upload size. Uploads run across 4 parallel resumable streams; keep this tab open until completion.
                </div>
              )}

              {uploading && (
                <div className="space-y-1.5">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-300">
                    <span>
                      {uploadStatusLabel || 'Uploading'}{' '}
                      {uploadStats
                        ? `(${formatBytes(uploadStats.uploadedBytes)} / ${formatBytes(uploadStats.totalBytes)})`
                        : ''}
                    </span>
                    <span className="font-mono tabular-nums text-slate-200">
                      {uploadStats && uploadStats.speedBytesPerSec > 0
                        ? `${(uploadStats.speedBytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`
                        : ''}
                      {uploadStats?.etaSeconds !== null && uploadStats?.etaSeconds !== undefined && uploadStats.etaSeconds > 0
                        ? ` · ~${Math.floor(uploadStats.etaSeconds / 60)}m ${uploadStats.etaSeconds % 60}s left · `
                        : ' '}
                      {uploadPercent}%
                    </span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
                    <div
                      className="h-full bg-blue-500 transition-all"
                      style={{ width: `${uploadPercent}%` }}
                    />
                  </div>
                </div>
              )}

              <div className="flex items-center justify-between gap-4 pt-1">
                <span className="text-xs text-slate-400">
                  {selectedFiles.length > 1
                    ? 'AI will mix & match across all clips into 5–7 varied viral edits'
                    : 'Automatic language detection: English · French · Arabic'}
                </span>
                <button
                  type="submit"
                  disabled={selectedFiles.length === 0 || uploading}
                  className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50 whitespace-nowrap shrink-0"
                >
                  {uploading ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      <span>Uploading...</span>
                    </>
                  ) : (
                    <>
                      <FileVideo className="h-4 w-4" />
                      <span>
                        {selectedFiles.length > 1
                          ? `Remix ${selectedFiles.length} Clips & Analyze`
                          : 'Ingest & Analyze'}
                      </span>
                    </>
                  )}
                </button>
              </div>
            </form>
          ) : (
            <form onSubmit={handleYouTubeSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-300">
                  YouTube Video URL
                  <input
                    type="url"
                    required
                    value={ytUrl}
                    onChange={(e) => setYtUrl(e.target.value)}
                    placeholder="https://www.youtube.com/watch?v=... or https://youtu.be/..."
                    className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-900 px-3.5 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-blue-500 focus:outline-none"
                  />
                </label>
                <p className="mt-1.5 text-xs text-slate-400">
                  Downloads MP4 streams directly when permitted, or automatically analyzes the YouTube video via Gemini multimodal URL understanding to extract transcripts, categories, and scored highlights even without cookies.
                </p>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300">
                  Project Title (optional — auto-filled from YouTube)
                  <input
                    type="text"
                    value={ytTitle}
                    onChange={(e) => setYtTitle(e.target.value)}
                    placeholder="Leave blank to use YouTube video title"
                    className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-900 px-3.5 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-blue-500 focus:outline-none"
                  />
                </label>
              </div>

              <div className="space-y-2">
                <label className="block text-xs font-medium text-slate-300">
                  AI Consigne / Creative Brief (Optional — guides how AI selects &amp; edits clips)
                  <textarea
                    rows={3}
                    value={brief}
                    onChange={(e) => setBrief(e.target.value)}
                    placeholder="e.g., Focus on funny reactions or technical breakdowns, keep slides uncropped, clean subtitles..."
                    className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-900 px-3.5 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-blue-500 focus:outline-none"
                  />
                </label>
                <div className="flex flex-wrap gap-1.5">
                  {BRIEF_TEMPLATES.map((tpl) => (
                    <button
                      key={tpl.label}
                      type="button"
                      onClick={() => setBrief(tpl.text)}
                      className="rounded-md border border-slate-700 bg-slate-900 px-2.5 py-1 text-[11px] font-medium text-slate-300 transition-colors hover:border-blue-500/60 hover:text-slate-100"
                    >
                      + {tpl.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="border-t border-slate-800 pt-3">
                <button
                  type="button"
                  onClick={() => setShowYtCookie((v) => !v)}
                  className="text-xs font-medium text-blue-400 hover:text-blue-300"
                >
                  {showYtCookie
                    ? 'Hide Optional YouTube Cookies'
                    : 'Optional: Add YouTube Cookies (if YouTube requests bot verification)'}
                </button>

                {showYtCookie && (
                  <label className="mt-3 block text-xs font-medium text-slate-300">
                    YouTube Cookie Header or Netscape Cookies (used once for this download, not stored)
                    <textarea
                      rows={3}
                      value={ytCookie}
                      onChange={(e) => setYtCookie(e.target.value)}
                      placeholder="Paste Cookie header string from youtube.com if your network triggers bot verification..."
                      className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 font-mono text-xs text-slate-100 placeholder:text-slate-500 focus:border-blue-500 focus:outline-none"
                    />
                  </label>
                )}
              </div>

              <div className="flex items-center justify-between gap-4 pt-2">
                <span className="text-xs text-slate-400">
                  Supports youtube.com, youtu.be, and Shorts URLs
                </span>
                <button
                  type="submit"
                  disabled={!ytUrl.trim() || importingYt}
                  className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50 whitespace-nowrap shrink-0"
                >
                  {importingYt ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      <span>Fetching Video...</span>
                    </>
                  ) : (
                    <>
                      <Link2 className="h-4 w-4" />
                      <span>Fetch & Analyze</span>
                    </>
                  )}
                </button>
              </div>
            </form>
          )}
        </div>

        {/* Local Sample Generator for instant multi-language testing */}
        <div className="lg:col-span-5 rounded-xl border border-slate-800 bg-[#111827] p-6 space-y-4">
          <div className="flex items-start gap-3">
            <Wand2 className="mt-0.5 h-5 w-5 shrink-0 text-blue-400" />
            <div>
              <h3 className="text-sm font-semibold text-slate-100">
                Synthesize Local Test Video
              </h3>
              <p className="mt-1 text-xs text-slate-400">
                Generate a genuine local MP4 video using FFmpeg and spoken audio to test different categories and languages end-to-end.
              </p>
            </div>
          </div>

          <div className="divide-y divide-slate-800">
            {samplePresets.map((preset) => {
              const busy = synthesizingId === preset.id;
              return (
                <div
                  key={preset.id}
                  className="flex items-center justify-between gap-3 py-3.5 first:pt-1 last:pb-1"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-100">{preset.title}</p>
                    <p className="mt-0.5 text-xs text-slate-400">
                      {preset.languageLabel} · {preset.categoryHint}
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={Boolean(synthesizingId)}
                    onClick={() => handleSynthesizeSample(preset.id)}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-100 transition-colors hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap shrink-0"
                  >
                    {busy ? (
                      <>
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        <span>Building MP4...</span>
                      </>
                    ) : (
                      <>
                        <Play className="h-3.5 w-3.5" />
                        <span>Run Test</span>
                      </>
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Live Pipeline Monitor for Active Project */}
      {activeProject && (
        <section className="rounded-xl border border-slate-800 bg-[#111827] p-6 space-y-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-b border-slate-800 pb-4">
            <div>
              <h3 className="text-base font-semibold text-slate-100">
                Orchestrator Status — {activeProject.title}
              </h3>
              <p className="mt-0.5 text-xs text-slate-400">{activeProject.stageMessage}</p>
              {activeProject.brief && (
                <p className="mt-1.5 text-xs text-blue-300/90">
                  Consigne: <span className="text-slate-300">{activeProject.brief}</span>
                </p>
              )}
            </div>
            <div className="flex items-center gap-3">
              <span className="font-mono text-sm tabular-nums text-blue-400">
                {activeProject.stageProgress}%
              </span>
              {activeProject.status === 'error' && (
                <button
                  type="button"
                  onClick={() => void onRetryProject(activeProject.id)}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-blue-500 whitespace-nowrap"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  <span>Retry Pipeline</span>
                </button>
              )}
              {activeProject.status === 'ready' && (
                <button
                  type="button"
                  onClick={() => onNavigate('analysis')}
                  className="rounded-lg bg-blue-600 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-blue-500 whitespace-nowrap"
                >
                  Inspect AI Analysis
                </button>
              )}
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {PIPELINE_STEPS.map((step, idx) => {
              const isCompleted =
                activeProject.currentStage === 'completed' ||
                (currentStageIndex > idx && activeProject.status !== 'error');
              const isCurrent =
                (activeProject.currentStage === step.key ||
                  (idx === 0 && activeProject.currentStage === 'downloading')) &&
                activeProject.status === 'processing';

              return (
                <div
                  key={step.key}
                  className={`rounded-lg border p-4 ${
                    isCurrent
                      ? 'border-blue-500/60 bg-blue-500/5'
                      : isCompleted
                      ? 'border-emerald-500/30 bg-emerald-500/5'
                      : 'border-slate-800 bg-slate-900/40'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-slate-100">{step.label}</span>
                    {isCurrent && <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-400 shrink-0" />}
                    {isCompleted && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400 shrink-0" />}
                  </div>
                  <p className="mt-2 text-xs text-slate-400 leading-relaxed">{step.detail}</p>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
