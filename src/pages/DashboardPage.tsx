import { ArrowRight, Film, FolderOutput, RefreshCw, Sparkles, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { ExportRecord, HighlightRecord, ProjectRecord } from '../types/studio';
import { formatBytes, formatDuration } from '../utils/format';
import type { StudioPage } from '../components/Sidebar';

interface DashboardPageProps {
  projects: ProjectRecord[];
  highlights: HighlightRecord[];
  exportsList: ExportRecord[];
  onSelectProject: (id: string) => void;
  onNavigate: (page: StudioPage) => void;
  onRetryProject: (id: string) => Promise<void>;
  onDeleteProject: (id: string) => Promise<void>;
}

export function DashboardPage({
  projects,
  highlights,
  exportsList,
  onSelectProject,
  onNavigate,
  onRetryProject,
  onDeleteProject,
}: DashboardPageProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const readyProjects = projects.filter((p) => p.status === 'ready').length;
  const selectedHighlights = highlights.filter(
    (h) => h.status === 'selected' || h.status === 'rendered' || h.status === 'exported'
  ).length;
  const processingProjects = projects.filter((p) => p.status === 'processing');

  const filteredProjects = projects.filter((p) => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return true;
    return (
      p.title.toLowerCase().includes(q) ||
      p.sourceFilename.toLowerCase().includes(q) ||
      (p.analysis?.primaryCategoryName.toLowerCase().includes(q) ?? false)
    );
  });

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    try {
      await onDeleteProject(id);
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-8 p-6 lg:p-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight text-slate-50">
            Personal Video Clipping Studio
          </h2>
          <p className="mt-1 text-sm text-slate-400">
            Local-first ingestion, automatic content understanding, category-aware highlight scoring, and 9:16 H.264 rendering.
          </p>
        </div>
        <button
          type="button"
          onClick={() => onNavigate('new-video')}
          className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-500 whitespace-nowrap shrink-0"
        >
          <span>Add Long-Form Video</span>
          <ArrowRight className="h-4 w-4" />
        </button>
      </div>

      {/* KPI Strip */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <div className="rounded-xl border border-slate-800 bg-[#111827] p-5">
          <p className="text-xs font-medium text-slate-400">Source Videos</p>
          <p className="mt-2 font-mono text-2xl font-semibold tabular-nums text-slate-50">
            {projects.length}
          </p>
          <p className="mt-1 text-xs text-slate-400">
            <span className="font-mono tabular-nums">{readyProjects}</span> analyzed locally
          </p>
        </div>

        <div className="rounded-xl border border-slate-800 bg-[#111827] p-5">
          <p className="text-xs font-medium text-slate-400">Candidate Highlights</p>
          <p className="mt-2 font-mono text-2xl font-semibold tabular-nums text-slate-50">
            {highlights.length}
          </p>
          <p className="mt-1 text-xs text-slate-400">
            <span className="font-mono tabular-nums">{selectedHighlights}</span> approved for export
          </p>
        </div>

        <div className="rounded-xl border border-slate-800 bg-[#111827] p-5">
          <p className="text-xs font-medium text-slate-400">Exported 9:16 Clips</p>
          <p className="mt-2 font-mono text-2xl font-semibold tabular-nums text-slate-50">
            {exportsList.length}
          </p>
          <p className="mt-1 text-xs text-slate-400">1080×1920 H.264 + AAC</p>
        </div>

        <div className="rounded-xl border border-slate-800 bg-[#111827] p-5">
          <p className="text-xs font-medium text-slate-400">Supported Languages</p>
          <p className="mt-2 text-lg font-semibold text-slate-50">EN · FR · AR</p>
          <p className="mt-1 text-xs text-slate-400">Auto-detected per video</p>
        </div>
      </div>

      {/* Active Background Jobs */}
      {processingProjects.length > 0 && (
        <section className="rounded-xl border border-blue-500/30 bg-[#111827] p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-100">Active Pipeline Processing</h3>
            <span className="font-mono text-xs tabular-nums text-blue-400">
              {processingProjects.length} active
            </span>
          </div>
          <div className="divide-y divide-slate-800">
            {processingProjects.map((proj) => (
              <div key={proj.id} className="py-3 first:pt-0 last:pb-0 space-y-2">
                <div className="flex items-center justify-between gap-4 text-sm">
                  <span className="font-medium text-slate-100 truncate">{proj.title}</span>
                  <span className="font-mono text-xs tabular-nums text-blue-400 shrink-0">
                    {proj.stageProgress}%
                  </span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
                  <div
                    className="h-full bg-blue-500 transition-all duration-300"
                    style={{ width: `${proj.stageProgress}%` }}
                  />
                </div>
                <p className="text-xs text-slate-400">{proj.stageMessage}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Projects Table */}
      <section className="rounded-xl border border-slate-800 bg-[#111827]">
        <div className="flex flex-col gap-3 border-b border-slate-800 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="text-base font-semibold text-slate-100">Project Library</h3>
            <p className="text-xs text-slate-400">
              Select a project to inspect its AI category analysis, scored highlights, or vertical renders.
            </p>
          </div>
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Filter by title or category..."
            className="w-full sm:w-64 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-blue-500 focus:outline-none"
          />
        </div>

        {filteredProjects.length === 0 ? (
          <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
            <Film className="h-10 w-10 text-slate-600" />
            <h4 className="mt-4 text-base font-medium text-slate-200">
              {projects.length === 0 ? 'No long-form videos imported yet' : 'No matching projects'}
            </h4>
            <p className="mt-1 max-w-md text-sm text-slate-400">
              {projects.length === 0
                ? 'Import an MP4, MOV, or MKV file—or synthesize a real local test video in English, French, or Arabic—to run the full clipping pipeline.'
                : 'Adjust your search query to locate a project.'}
            </p>
            {projects.length === 0 && (
              <button
                type="button"
                onClick={() => onNavigate('new-video')}
                className="mt-5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500"
              >
                Import First Video
              </button>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-800 text-xs font-medium text-slate-400">
                  <th className="px-5 py-3">Video Project</th>
                  <th className="px-4 py-3">Detected Category</th>
                  <th className="px-4 py-3">Profile & Language</th>
                  <th className="px-4 py-3 text-right">Duration</th>
                  <th className="px-4 py-3 text-right">Clips</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-5 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/80">
                {filteredProjects.map((proj) => {
                  const projHighlights = highlights.filter((h) => h.projectId === proj.id);
                  const statusLabel =
                    proj.status === 'ready'
                      ? 'Ready'
                      : proj.status === 'error'
                      ? 'Error'
                      : `${proj.stageProgress}%`;
                  const statusColor =
                    proj.status === 'ready'
                      ? 'text-emerald-400'
                      : proj.status === 'error'
                      ? 'text-rose-400'
                      : 'text-amber-400';

                  return (
                    <tr
                      key={proj.id}
                      className="transition-colors hover:bg-slate-800/30"
                    >
                      <td className="px-5 py-3.5">
                        <div className="font-medium text-slate-100">{proj.title}</div>
                        <div className="mt-0.5 text-xs text-slate-400">
                          {proj.sourceFilename}
                          {proj.metadata ? (
                            <>
                              {' · '}
                              <span className="font-mono tabular-nums">
                                {proj.metadata.width}×{proj.metadata.height}
                              </span>
                              {' · '}
                              <span className="font-mono tabular-nums">
                                {formatBytes(proj.metadata.fileSize)}
                              </span>
                            </>
                          ) : null}
                        </div>
                      </td>
                      <td className="px-4 py-3.5 text-slate-200">
                        {proj.analysis ? (
                          <div>
                            <div>{proj.analysis.primaryCategoryName}</div>
                            {proj.analysis.secondaryCategories.length > 0 && (
                              <div className="mt-0.5 text-xs text-slate-400">
                                + {proj.analysis.secondaryCategories.map((c) => c.categoryName).join(', ')}
                              </div>
                            )}
                          </div>
                        ) : (
                          <span className="text-xs text-slate-500">Pending analysis</span>
                        )}
                      </td>
                      <td className="px-4 py-3.5 text-xs text-slate-300">
                        {proj.analysis ? (
                          <span>
                            {proj.analysis.recommendedProfile} · {proj.analysis.detectedLanguage}
                          </span>
                        ) : (
                          <span className="text-slate-500">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3.5 text-right font-mono text-xs tabular-nums text-slate-300">
                        {proj.metadata ? formatDuration(proj.metadata.duration) : '—'}
                      </td>
                      <td className="px-4 py-3.5 text-right font-mono text-xs tabular-nums text-slate-300">
                        {projHighlights.length}
                      </td>
                      <td className={`px-4 py-3.5 text-xs font-medium ${statusColor}`}>
                        {statusLabel}
                      </td>
                      <td className="px-5 py-3.5 text-right">
                        <div className="inline-flex items-center gap-2">
                          {proj.status === 'error' && (
                            <button
                              type="button"
                              onClick={() => void onRetryProject(proj.id)}
                              className="inline-flex items-center gap-1 rounded-md bg-blue-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-500 whitespace-nowrap"
                            >
                              <RefreshCw className="h-3 w-3" />
                              <span>Retry</span>
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => {
                              onSelectProject(proj.id);
                              onNavigate('analysis');
                            }}
                            className="rounded-md border border-slate-700 px-2.5 py-1 text-xs font-medium text-slate-200 hover:bg-slate-800 whitespace-nowrap"
                          >
                            Analysis
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              onSelectProject(proj.id);
                              onNavigate('highlights');
                            }}
                            className="inline-flex items-center gap-1 rounded-md bg-slate-800 px-2.5 py-1 text-xs font-medium text-blue-400 hover:bg-slate-700 whitespace-nowrap"
                          >
                            <Sparkles className="h-3.5 w-3.5" />
                            <span>Highlights</span>
                          </button>
                          <button
                            type="button"
                            disabled={deletingId === proj.id}
                            onClick={() => handleDelete(proj.id)}
                            className="rounded-md p-1.5 text-slate-400 hover:bg-slate-800 hover:text-rose-400 disabled:opacity-50"
                            title="Delete project"
                            aria-label={`Delete ${proj.title}`}
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Quick Links */}
      <div className="grid gap-4 md:grid-cols-2">
        <button
          type="button"
          onClick={() => onNavigate('editor')}
          className="flex items-center justify-between rounded-xl border border-slate-800 bg-[#111827] p-5 text-left transition-colors hover:border-slate-700 hover:bg-slate-900"
        >
          <div>
            <p className="text-sm font-semibold text-slate-100">Clip Preview & Adaptive Editor</p>
            <p className="mt-1 text-xs text-slate-400">
              Fine-tune trim boundaries, switch 8 editing profiles, inspect Quality Control checks, and render 1080×1920 MP4s.
            </p>
          </div>
          <ArrowRight className="h-5 w-5 shrink-0 text-slate-400" />
        </button>

        <button
          type="button"
          onClick={() => onNavigate('exports')}
          className="flex items-center justify-between rounded-xl border border-slate-800 bg-[#111827] p-5 text-left transition-colors hover:border-slate-700 hover:bg-slate-900"
        >
          <div>
            <p className="text-sm font-semibold text-slate-100">Export Library & Platform Copy</p>
            <p className="mt-1 text-xs text-slate-400">
              Browse clips organized by project and category with TikTok, Reels, and Shorts metadata JSON.
            </p>
          </div>
          <FolderOutput className="h-5 w-5 shrink-0 text-slate-400" />
        </button>
      </div>
    </div>
  );
}
