import { ArrowRight, RefreshCw, Save } from 'lucide-react';
import { useEffect, useState } from 'react';
import type {
  CategoryConfig,
  EditingProfileId,
  EditingProfileSpec,
  ProjectRecord,
} from '../types/studio';
import { formatBytes, formatDuration, formatTimecode, isArabicText } from '../utils/format';
import type { StudioPage } from '../components/Sidebar';

interface ContentAnalysisPageProps {
  project: ProjectRecord | null;
  categories: CategoryConfig[];
  editingProfiles: EditingProfileSpec[];
  onOverrideAnalysis: (
    projectId: string,
    primaryCategoryId: string,
    recommendedProfile: EditingProfileId
  ) => Promise<void>;
  onReanalyzeHighlights: (projectId: string) => Promise<void>;
  onRetryProject: (projectId: string) => Promise<void>;
  onNavigate: (page: StudioPage) => void;
}

export function ContentAnalysisPage({
  project,
  categories,
  editingProfiles,
  onOverrideAnalysis,
  onReanalyzeHighlights,
  onRetryProject,
  onNavigate,
}: ContentAnalysisPageProps) {
  const [selectedCategoryId, setSelectedCategoryId] = useState('');
  const [selectedProfile, setSelectedProfile] = useState<EditingProfileId>('Minimal');
  const [saving, setSaving] = useState(false);
  const [rescoring, setRescoring] = useState(false);

  useEffect(() => {
    if (project?.analysis) {
      setSelectedCategoryId(project.analysis.primaryCategoryId);
      setSelectedProfile(project.analysis.recommendedProfile);
    }
  }, [project?.id, project?.analysis?.primaryCategoryId, project?.analysis?.recommendedProfile]);

  if (!project) {
    return (
      <div className="mx-auto max-w-4xl p-8 text-center">
        <h2 className="text-xl font-semibold text-slate-100">No Active Project Selected</h2>
        <p className="mt-2 text-sm text-slate-400">
          Import or select a video project to review its AI content understanding and transcript.
        </p>
        <button
          type="button"
          onClick={() => onNavigate('new-video')}
          className="mt-5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500"
        >
          Go to New Video
        </button>
      </div>
    );
  }

  if (project.status === 'processing' || !project.analysis) {
    return (
      <div className="mx-auto max-w-4xl p-8">
        <div className="rounded-xl border border-slate-800 bg-[#111827] p-6 space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-slate-100">{project.title}</h2>
              <p className={`mt-1 text-sm ${project.status === 'error' ? 'text-rose-300' : 'text-slate-400'}`}>
                {project.status === 'error'
                  ? `Pipeline error: ${project.errorMessage}`
                  : project.stageMessage || 'Analyzing video content...'}
              </p>
            </div>
            {project.status === 'error' && (
              <button
                type="button"
                onClick={() => onRetryProject(project.id)}
                className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-2 text-xs font-medium text-white hover:bg-blue-500 whitespace-nowrap shrink-0"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                <span>Retry Pipeline</span>
              </button>
            )}
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
            <div
              className={`h-full transition-all ${project.status === 'error' ? 'bg-rose-500' : 'bg-blue-500'}`}
              style={{ width: `${project.stageProgress}%` }}
            />
          </div>
        </div>
      </div>
    );
  }

  const { analysis, metadata, scenes, transcript } = project;

  const handleSaveOverride = async () => {
    setSaving(true);
    try {
      await onOverrideAnalysis(project.id, selectedCategoryId, selectedProfile);
    } finally {
      setSaving(false);
    }
  };

  const handleRescore = async () => {
    setRescoring(true);
    try {
      await onOverrideAnalysis(project.id, selectedCategoryId, selectedProfile);
      await onReanalyzeHighlights(project.id);
      onNavigate('highlights');
    } finally {
      setRescoring(false);
    }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-8 p-6 lg:p-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-medium text-blue-400">
            {analysis.detectedLanguage} · {analysis.videoFormat}
            {analysis.isMixedContent ? ' · Mixed-Category Content' : ''}
            {analysis.userOverriddenCategory ? ' · Manually Verified' : ''}
          </p>
          <h2 className="mt-1 text-2xl font-semibold tracking-tight text-slate-50">
            {project.title}
          </h2>
        </div>

        <button
          type="button"
          onClick={() => onNavigate('highlights')}
          className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 whitespace-nowrap shrink-0"
        >
          <span>Review AI Highlights</span>
          <ArrowRight className="h-4 w-4" />
        </button>
      </div>

      {/* Classification & Technical Specs */}
      <div className="grid gap-6 lg:grid-cols-12">
        <div className="lg:col-span-7 rounded-xl border border-slate-800 bg-[#111827] p-6 space-y-5">
          <div>
            <h3 className="text-base font-semibold text-slate-100">
              Automatic Category Detection
            </h3>
            <p className="mt-1 text-xs text-slate-400">
              Multi-label classification across transcript, speaker dynamics, and visual keyframes.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <span className="text-xs text-slate-400">Primary Category</span>
              <p className="mt-1 text-sm font-semibold text-slate-100">
                {analysis.primaryCategoryName}
              </p>
            </div>
            <div>
              <span className="text-xs text-slate-400">Recommended Editing Profile</span>
              <p className="mt-1 text-sm font-semibold text-blue-400">
                {analysis.recommendedProfile}
              </p>
            </div>
            <div>
              <span className="text-xs text-slate-400">Target Audience</span>
              <p className="mt-1 text-sm text-slate-200">{analysis.targetAudience}</p>
            </div>
            <div>
              <span className="text-xs text-slate-400">Emotional & Structural Arc</span>
              <p className="mt-1 text-sm text-slate-200">{analysis.emotionalArc}</p>
            </div>
          </div>

          {analysis.secondaryCategories.length > 0 && (
            <div className="border-t border-slate-800 pt-4 space-y-2.5">
              <h4 className="text-xs font-medium text-slate-300">
                Secondary & Overlapping Categories
              </h4>
              <div className="divide-y divide-slate-800/80">
                {analysis.secondaryCategories.map((sc) => (
                  <div key={sc.categoryId} className="py-2 first:pt-0 last:pb-0">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-medium text-slate-200">{sc.categoryName}</span>
                      <span className="font-mono tabular-nums text-slate-400">
                        {sc.confidence}% match
                      </span>
                    </div>
                    {sc.rationale && (
                      <p className="mt-0.5 text-xs text-slate-400">{sc.rationale}</p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="border-t border-slate-800 pt-4 space-y-2">
            <div className="text-xs text-slate-400">
              Main Topics: <span className="text-slate-200">{analysis.mainTopics.join(' · ') || 'General'}</span>
            </div>
            <div className="text-xs text-slate-400">
              Structure & Confidence Notes:{' '}
              <span className="text-slate-300">{analysis.uncertaintyNotes}</span>
            </div>
          </div>
        </div>

        {/* Manual Override & Re-Scoring Controls */}
        <div className="lg:col-span-5 rounded-xl border border-slate-800 bg-[#111827] p-6 space-y-5">
          <div>
            <h3 className="text-base font-semibold text-slate-100">
              Review or Override Classification
            </h3>
            <p className="mt-1 text-xs text-slate-400">
              Correct the detected category or editing profile and optionally re-score highlights with the new rubric.
            </p>
          </div>

          <div className="space-y-4">
            <label className="block text-xs font-medium text-slate-300">
              Primary Category
              <select
                value={selectedCategoryId}
                onChange={(e) => setSelectedCategoryId(e.target.value)}
                className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-blue-500 focus:outline-none"
              >
                {categories.map((cat) => (
                  <option key={cat.id} value={cat.id}>
                    {cat.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="block text-xs font-medium text-slate-300">
              Default Editing Profile
              <select
                value={selectedProfile}
                onChange={(e) => setSelectedProfile(e.target.value as EditingProfileId)}
                className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-blue-500 focus:outline-none"
              >
                {editingProfiles.map((prof) => (
                  <option key={prof.id} value={prof.id}>
                    {prof.label} — {prof.description.slice(0, 48)}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-3 pt-1">
            <button
              type="button"
              disabled={saving}
              onClick={handleSaveOverride}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-3.5 py-2 text-xs font-medium text-slate-100 hover:bg-slate-800 disabled:opacity-50"
            >
              <Save className="h-3.5 w-3.5" />
              <span>{saving ? 'Saving...' : 'Save Override'}</span>
            </button>

            <button
              type="button"
              disabled={rescoring}
              onClick={handleRescore}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-2 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${rescoring ? 'animate-spin' : ''}`} />
              <span>{rescoring ? 'Re-scoring...' : 'Apply & Re-score Highlights'}</span>
            </button>
          </div>

          {metadata && (
            <div className="border-t border-slate-800 pt-4 text-xs text-slate-400 space-y-1">
              <p className="font-medium text-slate-300">FFprobe Source Stream Spec</p>
              <p className="font-mono tabular-nums">
                {metadata.width}×{metadata.height} · {metadata.fps} fps · {metadata.videoCodec.toUpperCase()} /{' '}
                {metadata.audioCodec?.toUpperCase() || 'No Audio'}
              </p>
              <p className="font-mono tabular-nums">
                Duration {formatDuration(metadata.duration)} · {formatBytes(metadata.fileSize)}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Extracted Scene Keyframes */}
      {scenes.length > 0 && (
        <section className="rounded-xl border border-slate-800 bg-[#111827] p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-semibold text-slate-100">Extracted Scene Keyframes</h3>
            <span className="font-mono text-xs tabular-nums text-slate-400">
              {scenes.length} frames
            </span>
          </div>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
            {scenes.map((scene, idx) => (
              <div key={idx} className="overflow-hidden rounded-lg border border-slate-800 bg-slate-900">
                <img
                  src={scene.thumbnailUrl}
                  alt={`Scene frame at ${formatTimecode(scene.timestamp)}`}
                  referrerPolicy="no-referrer"
                  className="aspect-video w-full object-cover"
                />
                <div className="px-2.5 py-1.5 font-mono text-xs tabular-nums text-slate-300">
                  {formatTimecode(scene.timestamp)}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Timestamped Transcript */}
      <section className="rounded-xl border border-slate-800 bg-[#111827] p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-base font-semibold text-slate-100">Timestamped Transcript</h3>
            <p className="text-xs text-slate-400">
              Sentence-aligned segments preserved locally with speaker attribution.
            </p>
          </div>
          <span className="font-mono text-xs tabular-nums text-slate-400">
            {transcript.length} segments
          </span>
        </div>

        {transcript.length === 0 ? (
          <p className="text-sm text-slate-400 py-6 text-center">
            No spoken transcript segments detected for this media file.
          </p>
        ) : (
          <div className="max-h-96 overflow-y-auto divide-y divide-slate-800/70 pr-2">
            {transcript.map((seg) => {
              const rtl = isArabicText(seg.text);
              return (
                <div key={seg.id} className="flex flex-col gap-1.5 py-3 sm:flex-row sm:gap-5">
                  <div className="w-40 shrink-0 font-mono text-xs tabular-nums text-slate-400">
                    <span>{formatTimecode(seg.start)}</span>
                    <span className="mx-1">→</span>
                    <span>{formatTimecode(seg.end)}</span>
                    <div className="mt-0.5 font-sans text-blue-400">{seg.speaker}</div>
                  </div>
                  <p
                    dir={rtl ? 'rtl' : 'ltr'}
                    className="flex-1 text-sm leading-relaxed text-slate-200"
                  >
                    {seg.text}
                  </p>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
