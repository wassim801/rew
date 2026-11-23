import { CheckCircle2, FileVideo, Link2, Loader2, Play, RefreshCw, Upload, Wand2 } from 'lucide-react';
import React, { useRef, useState } from 'react';
import type { ProjectRecord } from '../types/studio';
import { formatBytes } from '../utils/format';
import { uploadVideoInChunks, type UploadProgressStats } from '../utils/uploadVideo';
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

  // Local file state
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [customTitle, setCustomTitle] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadPercent, setUploadPercent] = useState(0);
  const [uploadStats, setUploadStats] = useState<UploadProgressStats | null>(null);

  // YouTube import state
  const [ytUrl, setYtUrl] = useState('');
  const [ytTitle, setYtTitle] = useState('');
  const [ytCookie, setYtCookie] = useState('');
  const [showYtCookie, setShowYtCookie] = useState(false);
  const [importingYt, setImportingYt] = useState(false);

  // Sample synthesizer state
  const [synthesizingId, setSynthesizingId] = useState<string | null>(null);

  const handleFileChosen = (file: File | null) => {
    if (!file) return;
    const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
    if (!['mp4', 'mov', 'mkv'].includes(ext)) {
      onError('Unsupported file format. Please select an MP4, MOV, or MKV video.');
      return;
    }
    setSelectedFile(file);
    if (!customTitle) {
      setCustomTitle(file.name.replace(/\.[^/.]+$/, ''));
    }
  };

  const handleUploadSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedFile) return;

    setUploading(true);
    setUploadPercent(0);
    setUploadStats(null);

    try {
      const project = await uploadVideoInChunks({
        file: selectedFile,
        title: customTitle.trim() || selectedFile.name,
        onProgress: (pct, stats) => {
          setUploadPercent(pct);
          if (stats) setUploadStats(stats);
        },
      });

      setSelectedFile(null);
      setCustomTitle('');
      onProjectCreated(project);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
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
          cookie: ytCookie.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to import YouTube video');
      }
      setYtUrl('');
      setYtTitle('');
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
          Import Long-Form Video
        </h2>
        <p className="mt-1 text-sm text-slate-400">
          Import local MP4, MOV, or MKV files—or paste a YouTube video link. No manual category selection required.
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
                  handleFileChosen(e.dataTransfer.files?.[0] ?? null);
                }}
                onClick={() => fileInputRef.current?.click()}
                className={`cursor-pointer rounded-xl border border-dashed p-10 text-center transition-colors ${
                  isDragging
                    ? 'border-blue-500 bg-blue-500/10'
                    : 'border-slate-700 bg-slate-900/50 hover:border-slate-600'
                }`}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".mp4,.mov,.mkv,video/mp4,video/quicktime,video/x-matroska"
                  className="hidden"
                  onChange={(e) => handleFileChosen(e.target.files?.[0] ?? null)}
                />
                <Upload className="mx-auto h-9 w-9 text-slate-400" />
                <p className="mt-3 text-sm font-medium text-slate-100">
                  {selectedFile
                    ? selectedFile.name
                    : 'Drop MP4, MOV, or MKV video here, or click to browse'}
                </p>
                <p className="mt-1 text-xs text-slate-400">
                  {selectedFile
                    ? `${formatBytes(selectedFile.size)} · Ready for FFprobe validation`
                    : 'Supports large local multi-hour video files up to 10 GB'}
                </p>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300">
                  Project Title
                  <input
                    type="text"
                    value={customTitle}
                    onChange={(e) => setCustomTitle(e.target.value)}
                    placeholder="e.g., Episode 42 — Scaling Product Teams"
                    className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-900 px-3.5 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-blue-500 focus:outline-none"
                  />
                </label>
              </div>

              {selectedFile && selectedFile.size > 1.5 * 1024 * 1024 * 1024 && (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3.5 py-2.5 text-xs text-amber-200 leading-relaxed">
                  Large multi-hour file ({formatBytes(selectedFile.size)}). Uploads run across 4 parallel resumable streams; if your upload bandwidth is slow and the cloud preview pauses mid-way, shrinking a 3-hour file to 480p/720p (~500–800 MB) locally uploads several times faster without hurting audio transcription.
                </div>
              )}

              {uploading && (
                <div className="space-y-1.5">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-300">
                    <span>
                      Uploading{' '}
                      {uploadStats
                        ? `${formatBytes(uploadStats.uploadedBytes)} / ${formatBytes(uploadStats.totalBytes)}`
                        : 'to local workspace...'}
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
                  Automatic language detection: English · French · Arabic
                </span>
                <button
                  type="submit"
                  disabled={!selectedFile || uploading}
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
                      <span>Ingest & Analyze</span>
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
