import { Check, Download, Image as ImageIcon, Loader2, RefreshCw, Scissors, X } from 'lucide-react';
import { useState } from 'react';
import type { HighlightRecord, ProjectRecord } from '../types/studio';
import { formatTimecode, isArabicText } from '../utils/format';
import type { StudioPage } from '../components/Sidebar';

interface HighlightsPageProps {
  project: ProjectRecord | null;
  highlights: HighlightRecord[];
  onUpdateHighlightStatus: (
    id: string,
    status: HighlightRecord['status']
  ) => Promise<void>;
  onRegenerateThumbnail: (id: string) => Promise<HighlightRecord>;
  onOpenInEditor: (highlightId: string) => void;
  onBatchExport: (highlightIds: string[]) => Promise<void>;
  onNavigate: (page: StudioPage) => void;
}

export function HighlightsPage({
  project,
  highlights,
  onUpdateHighlightStatus,
  onRegenerateThumbnail,
  onOpenInEditor,
  onBatchExport,
  onNavigate,
}: HighlightsPageProps) {
  const [filter, setFilter] = useState<'all' | 'selected' | 'candidate' | 'rejected'>('all');
  const [batchExporting, setBatchExporting] = useState(false);
  const [regeneratingThumbId, setRegeneratingThumbId] = useState<string | null>(null);

  const projectHighlights = project
    ? highlights.filter((h) => h.projectId === project.id)
    : highlights;

  const filtered = projectHighlights.filter((h) => {
    if (filter === 'all') return true;
    if (filter === 'selected') {
      return h.status === 'selected' || h.status === 'rendered' || h.status === 'exported';
    }
    return h.status === filter;
  });

  const exportableIds = projectHighlights
    .filter((h) => h.status === 'selected' || h.status === 'rendered')
    .map((h) => h.id);

  const handleBatch = async () => {
    if (exportableIds.length === 0) return;
    setBatchExporting(true);
    try {
      await onBatchExport(exportableIds);
      onNavigate('exports');
    } catch {
      // Stay on Highlights page; error banner handled in App
    } finally {
      setBatchExporting(false);
    }
  };

  const handleRegenThumb = async (id: string) => {
    setRegeneratingThumbId(id);
    try {
      await onRegenerateThumbnail(id);
    } finally {
      setRegeneratingThumbId(null);
    }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6 lg:p-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight text-slate-50">
            AI Highlights {project ? `— ${project.title}` : ''}
          </h2>
          <p className="mt-1 text-sm text-slate-400">
            Scored candidate moments evaluated for hook strength, standalone context, completeness, and custom cover thumbnails.
          </p>
        </div>

        <button
          type="button"
          disabled={exportableIds.length === 0 || batchExporting}
          onClick={handleBatch}
          className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50 whitespace-nowrap shrink-0"
        >
          {batchExporting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Rendering & Exporting ({exportableIds.length})...</span>
            </>
          ) : (
            <>
              <Download className="h-4 w-4" />
              <span>Batch Export Selected ({exportableIds.length})</span>
            </>
          )}
        </button>
      </div>

      {/* Filter Bar */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-4">
        <div className="inline-flex items-center gap-1 rounded-lg bg-slate-900 p-1 border border-slate-800">
          {(['all', 'selected', 'candidate', 'rejected'] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setFilter(tab)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium capitalize transition-colors whitespace-nowrap ${
                filter === tab
                  ? 'bg-slate-800 text-slate-50'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {tab === 'selected' ? 'Approved' : tab}
            </button>
          ))}
        </div>

        <span className="font-mono text-xs tabular-nums text-slate-400">
          Showing {filtered.length} of {projectHighlights.length} clips
        </span>
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-xl border border-slate-800 bg-[#111827] px-6 py-16 text-center">
          <p className="text-base font-medium text-slate-200">No highlights in this view</p>
          <p className="mt-1 text-sm text-slate-400">
            Import a video or switch filters to inspect scored highlight segments.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {filtered.map((hl) => {
            const rtl = isArabicText(hl.title) || isArabicText(hl.description);
            const isApproved =
              hl.status === 'selected' || hl.status === 'rendered' || hl.status === 'exported';
            const isRegenBusy = regeneratingThumbId === hl.id;
            const thumbDownloadHref = hl.thumbnailUrl
              ? hl.thumbnailUrl.includes('?')
                ? `${hl.thumbnailUrl}&download=1`
                : `${hl.thumbnailUrl}?download=1`
              : null;

            return (
              <article
                key={hl.id}
                className="rounded-xl border border-slate-800 bg-[#111827] p-6 space-y-5"
              >
                <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
                  {/* 9:16 Highlight Thumbnail Cover */}
                  <div className="w-36 sm:w-40 shrink-0 space-y-2 mx-auto sm:mx-0">
                    <div className="group relative aspect-[9/16] w-full overflow-hidden rounded-xl border border-slate-700 bg-slate-950">
                      {hl.thumbnailUrl ? (
                        <button
                          type="button"
                          onClick={() => onOpenInEditor(hl.id)}
                          className="block h-full w-full text-left focus:outline-none"
                          title="Open clip & cover editor"
                        >
                          <img
                            src={hl.thumbnailUrl}
                            alt={`Cover thumbnail for ${hl.title}`}
                            className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.03]"
                          />
                        </button>
                      ) : (
                        <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-3 text-center">
                          <ImageIcon className="h-6 w-6 text-slate-600" />
                          <button
                            type="button"
                            disabled={isRegenBusy}
                            onClick={() => handleRegenThumb(hl.id)}
                            className="rounded-lg bg-slate-800 px-2.5 py-1.5 text-[11px] font-medium text-slate-200 hover:bg-slate-700 disabled:opacity-50"
                          >
                            {isRegenBusy ? 'Designing...' : 'Generate Cover'}
                          </button>
                        </div>
                      )}
                    </div>

                    <div className="flex items-center justify-between gap-2 text-[11px] text-slate-400">
                      <button
                        type="button"
                        disabled={isRegenBusy}
                        onClick={() => handleRegenThumb(hl.id)}
                        className="inline-flex items-center gap-1 hover:text-slate-200 disabled:opacity-50"
                        title="Regenerate cover thumbnail"
                      >
                        <RefreshCw className={`h-3 w-3 ${isRegenBusy ? 'animate-spin' : ''}`} />
                        <span>{isRegenBusy ? 'Updating...' : 'Redesign'}</span>
                      </button>

                      {thumbDownloadHref && (
                        <a
                          href={thumbDownloadHref}
                          className="inline-flex items-center gap-1 text-blue-400 hover:text-blue-300"
                          title="Download 9:16 Cover JPG"
                        >
                          <Download className="h-3 w-3" />
                          <span>JPG</span>
                        </a>
                      )}
                    </div>
                  </div>

                  {/* Highlight Details & Actions */}
                  <div className="flex-1 min-w-0 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div className="space-y-1.5 min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
                        <span className="font-medium text-blue-400">{hl.categoryName}</span>
                        {hl.secondaryCategoryName && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span>{hl.secondaryCategoryName}</span>
                          </>
                        )}
                        <span aria-hidden="true">·</span>
                        <span className="font-mono tabular-nums text-slate-300">
                          {hl.editSegments && hl.editSegments.length > 0
                            ? `${hl.editSegments.length} cuts (${hl.duration.toFixed(1)}s)`
                            : `${formatTimecode(hl.startTime)} – ${formatTimecode(hl.endTime)} (${hl.duration.toFixed(1)}s)`}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>
                          {hl.editingProfile} / {hl.subtitleStyle}
                          {hl.transitionStyle && hl.transitionStyle !== 'auto' ? ` · ${hl.transitionStyle}` : ''}
                          {hl.bgmVibe && hl.bgmVibe !== 'auto' ? ` · music: ${hl.bgmVibe}` : ''}
                          {hl.sfxMode && hl.sfxMode !== 'auto' ? ` · sfx: ${hl.sfxMode}` : ''}
                          {hl.thumbnailStyle && hl.thumbnailStyle !== 'auto'
                            ? ` · cover: ${hl.thumbnailStyle}`
                            : ''}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span
                          className={
                            hl.status === 'exported' || hl.status === 'rendered'
                              ? 'text-emerald-400 font-medium'
                              : hl.status === 'selected'
                              ? 'text-blue-400 font-medium'
                              : hl.status === 'rejected'
                              ? 'text-rose-400'
                              : 'text-slate-300'
                          }
                        >
                          {hl.status === 'selected'
                            ? 'Approved'
                            : hl.status.charAt(0).toUpperCase() + hl.status.slice(1)}
                        </span>
                      </div>

                      <h3
                        dir={rtl ? 'rtl' : 'ltr'}
                        className="text-lg font-semibold text-slate-50"
                      >
                        {hl.title}
                      </h3>
                      {(hl.hookHeadline || hl.thumbnailText) && (
                        <p className="text-xs font-medium text-blue-300">
                          {hl.thumbnailText ? (
                            <>
                              Cover Hook:{' '}
                              <span className="text-slate-100">
                                “{hl.thumbnailText}” {hl.thumbnailEmojis?.join(' ')}
                              </span>
                            </>
                          ) : (
                            <>
                              Opening Hook Banner: <span className="text-slate-100">“{hl.hookHeadline}”</span>
                            </>
                          )}
                        </p>
                      )}
                      <p
                        dir={rtl ? 'rtl' : 'ltr'}
                        className="text-sm text-slate-300 leading-relaxed"
                      >
                        {hl.description}
                      </p>
                      {hl.editSegments && hl.editSegments.length > 0 && (
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1 font-mono text-[11px] text-slate-400">
                          {hl.editSegments.map((seg, sIdx) => (
                            <span key={seg.id || sIdx} className="inline-flex items-center gap-1">
                              <span className="uppercase text-blue-400">{seg.role}</span>
                              <span>·</span>
                              <span className="text-slate-300">Clip #{seg.sourceIndex + 1}</span>
                              <span>
                                {formatTimecode(seg.startTime)}–{formatTimecode(seg.endTime)}
                              </span>
                              {seg.sfxCue && seg.sfxCue !== 'none' && (
                                <>
                                  <span>·</span>
                                  <span className="text-amber-300">{seg.sfxCue}</span>
                                </>
                              )}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>

                    <div className="flex items-center gap-4 shrink-0">
                      <div className="text-right">
                        <div className="text-xs text-slate-400">Overall Score</div>
                        <div className="font-mono text-2xl font-semibold tabular-nums text-slate-50">
                          {hl.criteriaBreakdown.totalScore}
                          <span className="text-sm text-slate-500">/100</span>
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() =>
                            onUpdateHighlightStatus(hl.id, isApproved ? 'candidate' : 'selected')
                          }
                          className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium transition-colors whitespace-nowrap ${
                            isApproved
                              ? 'border border-emerald-500/40 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20'
                              : 'border border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-800'
                          }`}
                        >
                          <Check className="h-3.5 w-3.5" />
                          <span>{isApproved ? 'Approved' : 'Approve'}</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => onUpdateHighlightStatus(hl.id, 'rejected')}
                          className={`rounded-lg border p-2 transition-colors ${
                            hl.status === 'rejected'
                              ? 'border-rose-500/40 bg-rose-500/10 text-rose-400'
                              : 'border-slate-700 bg-slate-900 text-slate-400 hover:text-rose-400'
                          }`}
                          title="Reject highlight"
                          aria-label="Reject highlight"
                        >
                          <X className="h-4 w-4" />
                        </button>

                        <button
                          type="button"
                          onClick={() => onOpenInEditor(hl.id)}
                          className="inline-flex items-center gap-1.5 rounded-lg bg-slate-800 px-3.5 py-2 text-xs font-medium text-slate-100 hover:bg-slate-700 whitespace-nowrap"
                        >
                          <Scissors className="h-3.5 w-3.5" />
                          <span>Preview & Edit</span>
                        </button>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Selection Explanation + 6-Criteria Breakdown */}
                <div className="grid gap-4 border-t border-slate-800 pt-4 lg:grid-cols-12">
                  <div className="lg:col-span-5 space-y-1.5">
                    <p className="text-xs font-medium text-slate-300">Selection Rationale</p>
                    <p className="text-xs leading-relaxed text-slate-400">
                      {hl.selectionExplanation}
                    </p>
                    {hl.keywords.length > 0 && (
                      <p className="pt-1 text-xs text-slate-400">
                        Keywords:{' '}
                        <span className="text-slate-200">{hl.keywords.join(' · ')}</span>
                      </p>
                    )}
                  </div>

                  <div className="lg:col-span-7 grid grid-cols-2 gap-x-6 gap-y-2.5 sm:grid-cols-3">
                    {[
                      ['Hook Strength', hl.criteriaBreakdown.hookStrength],
                      ['Standalone Context', hl.criteriaBreakdown.standaloneContext],
                      ['Audience Interest', hl.criteriaBreakdown.audienceInterest],
                      ['Emotional / Info Value', hl.criteriaBreakdown.emotionalOrInfoValue],
                      ['Completeness', hl.criteriaBreakdown.contentCompleteness],
                      ['A/V Quality', hl.criteriaBreakdown.audioVisualQuality],
                    ].map(([label, score]) => (
                      <div key={String(label)} className="space-y-1">
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-slate-400">{label}</span>
                          <span className="font-mono tabular-nums text-slate-200">{score}</span>
                        </div>
                        <div className="h-1 w-full overflow-hidden rounded-full bg-slate-800">
                          <div
                            className="h-full bg-blue-500/80"
                            style={{ width: `${Number(score)}%` }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
