import { AlertCircle, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Sidebar, type StudioPage } from './components/Sidebar';
import { TopBar } from './components/TopBar';
import { ClipEditorPage } from './pages/ClipEditorPage';
import { ContentAnalysisPage } from './pages/ContentAnalysisPage';
import { DashboardPage } from './pages/DashboardPage';
import { ExportLibraryPage } from './pages/ExportLibraryPage';
import { HighlightsPage } from './pages/HighlightsPage';
import { NewVideoPage } from './pages/NewVideoPage';
import { SettingsPage } from './pages/SettingsPage';
import { uploadVideoInChunks } from './utils/uploadVideo';
import type {
  CategoryConfig,
  EditingProfileId,
  EditingProfileSpec,
  ExportRecord,
  HighlightRecord,
  ProjectRecord,
  StudioSettings,
} from './types/studio';

interface SamplePresetInfo {
  id: 'business_podcast_en' | 'tech_tutorial_fr' | 'motivation_ar';
  title: string;
  languageLabel: string;
  categoryHint: string;
}

async function parseJsonResponse<T = Record<string, unknown>>(
  res: Response,
  fallbackError: string
): Promise<T> {
  const raw = await res.text();
  let parsed: Record<string, unknown> | null = null;
  if (raw) {
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      parsed = null;
    }
  }
  if (!res.ok) {
    const serverErr = parsed && typeof parsed.error === 'string' ? parsed.error : null;
    if (res.status === 504) {
      throw new Error('Request timed out waiting for video processing. Please try again or render shorter segments.');
    }
    throw new Error(serverErr || `${fallbackError} (HTTP ${res.status})`);
  }
  if (!parsed) {
    throw new Error('Invalid server response.');
  }
  return parsed as T;
}

export default function App() {
  const [activePage, setActivePage] = useState<StudioPage>('dashboard');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [highlights, setHighlights] = useState<HighlightRecord[]>([]);
  const [exportsList, setExportsList] = useState<ExportRecord[]>([]);
  const [settings, setSettings] = useState<StudioSettings | null>(null);
  const [builtinCategories, setBuiltinCategories] = useState<CategoryConfig[]>([]);
  const [editingProfiles, setEditingProfiles] = useState<EditingProfileSpec[]>([]);
  const [samplePresets, setSamplePresets] = useState<SamplePresetInfo[]>([]);

  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [selectedHighlightId, setSelectedHighlightId] = useState<string | null>(null);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchBootstrap = useCallback(async () => {
    try {
      const res = await fetch('/api/bootstrap');
      if (!res.ok) throw new Error('Failed to load studio workspace');
      const data = await res.json();
      setProjects(data.projects ?? []);
      setHighlights(data.highlights ?? []);
      setExportsList(data.exports ?? []);
      setSettings(data.settings ?? null);
      setBuiltinCategories(data.builtinCategories ?? []);
      setEditingProfiles(data.editingProfiles ?? []);
      setSamplePresets(data.samplePresets ?? []);

      setActiveProjectId((prev) => {
        if (prev && (data.projects ?? []).some((p: ProjectRecord) => p.id === prev)) {
          return prev;
        }
        return data.projects?.[0]?.id ?? null;
      });
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Unable to reach studio server');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchBootstrap();
  }, [fetchBootstrap]);

  // Poll while any project is processing
  const hasProcessing = projects.some((p) => p.status === 'processing');
  useEffect(() => {
    if (!hasProcessing) return;
    const timer = setInterval(() => {
      void fetchBootstrap();
    }, 1800);
    return () => clearInterval(timer);
  }, [hasProcessing, fetchBootstrap]);

  const activeProject = useMemo(
    () => projects.find((p) => p.id === activeProjectId) ?? projects[0] ?? null,
    [projects, activeProjectId]
  );

  const allCategories = useMemo(
    () => [...builtinCategories, ...(settings?.customCategories ?? [])],
    [builtinCategories, settings?.customCategories]
  );

  const handleProjectCreated = (project: ProjectRecord) => {
    setProjects((prev) => [project, ...prev]);
    setActiveProjectId(project.id);
    setErrorBanner(null);
  };

  const handleDeleteProject = async (id: string) => {
    const res = await fetch(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!res.ok) {
      setErrorBanner('Failed to delete project');
      return;
    }
    setProjects((prev) => prev.filter((p) => p.id !== id));
    setHighlights((prev) => prev.filter((h) => h.projectId !== id));
    setExportsList((prev) => prev.filter((e) => e.projectId !== id));
    if (activeProjectId === id) {
      setActiveProjectId(null);
    }
  };

  const handleOverrideAnalysis = async (
    projectId: string,
    primaryCategoryId: string,
    recommendedProfile: EditingProfileId,
    brief?: string
  ) => {
    const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/analysis`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ primaryCategoryId, recommendedProfile, brief }),
    });
    const data = await res.json();
    if (!res.ok) {
      setErrorBanner(data.error || 'Failed to update category');
      return;
    }
    setProjects((prev) =>
      prev.map((p) =>
        p.id === projectId
          ? {
              ...p,
              analysis: data.analysis,
              brief: data.brief !== undefined ? data.brief : p.brief,
            }
          : p
      )
    );
  };

  const handleReanalyzeHighlights = async (projectId: string) => {
    const res = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/reanalyze-highlights`,
      { method: 'POST' }
    );
    const data = await res.json();
    if (!res.ok) {
      setErrorBanner(data.error || 'Failed to re-score highlights');
      return;
    }
    setHighlights((prev) => [
      ...prev.filter((h) => h.projectId !== projectId),
      ...(data.highlights ?? []),
    ]);
  };

  const handleRetryProject = async (projectId: string) => {
    const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/retry`, {
      method: 'POST',
    });
    const data = await res.json();
    if (!res.ok) {
      setErrorBanner(data.error || 'Failed to retry pipeline');
      return;
    }
    if (data.project) {
      setProjects((prev) => prev.map((p) => (p.id === projectId ? data.project : p)));
    }
  };

  const handleSaveHighlight = async (
    id: string,
    patch: Partial<HighlightRecord>
  ): Promise<HighlightRecord> => {
    const res = await fetch(`/api/highlights/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const data = await res.json();
    if (!res.ok) {
      const msg = data.error || 'Failed to save highlight edits';
      setErrorBanner(msg);
      throw new Error(msg);
    }
    setHighlights((prev) => prev.map((h) => (h.id === id ? data.highlight : h)));
    return data.highlight;
  };

  const handleUpdateHighlightStatus = async (
    id: string,
    status: HighlightRecord['status']
  ) => {
    await handleSaveHighlight(id, { status });
  };

  const handleRegenerateThumbnail = async (
    id: string,
    overrides?: Partial<HighlightRecord>
  ): Promise<HighlightRecord> => {
    setErrorBanner(null);
    const res = await fetch(`/api/highlights/${encodeURIComponent(id)}/regenerate-thumbnail`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(overrides ?? {}),
    });
    const data = await parseJsonResponse<{ highlight: HighlightRecord }>(
      res,
      'Failed to regenerate highlight thumbnail'
    );
    setHighlights((prev) => prev.map((h) => (h.id === id ? data.highlight : h)));
    return data.highlight;
  };

  const handleRenderClip = async (id: string) => {
    setErrorBanner(null);
    try {
      const res = await fetch(`/api/highlights/${encodeURIComponent(id)}/render`, {
        method: 'POST',
      });
      const data = await parseJsonResponse<{ highlight: HighlightRecord }>(
        res,
        'Failed to render clip'
      );
      setHighlights((prev) => prev.map((h) => (h.id === id ? data.highlight : h)));
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to render clip';
      setErrorBanner(msg);
      throw err;
    }
  };

  const handleAutoHealClip = async (id: string) => {
    setErrorBanner(null);
    try {
      const res = await fetch(`/api/highlights/${encodeURIComponent(id)}/auto-heal`, {
        method: 'POST',
      });
      const data = await parseJsonResponse<{ highlight: HighlightRecord }>(
        res,
        'Failed to auto-regenerate clip'
      );
      setHighlights((prev) => prev.map((h) => (h.id === id ? data.highlight : h)));
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to auto-regenerate clip';
      setErrorBanner(msg);
      throw err;
    }
  };

  const handleExportClip = async (id: string) => {
    setErrorBanner(null);
    try {
      const res = await fetch(`/api/highlights/${encodeURIComponent(id)}/export`, {
        method: 'POST',
      });
      const data = await parseJsonResponse<{
        highlight?: HighlightRecord;
        exportRecord?: ExportRecord;
      }>(res, 'Failed to export clip');
      if (data.highlight) {
        setHighlights((prev) => prev.map((h) => (h.id === id ? data.highlight! : h)));
      }
      if (data.exportRecord) {
        setExportsList((prev) => [data.exportRecord!, ...prev]);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to export clip';
      setErrorBanner(msg);
      throw err;
    }
  };

  const handleBatchExport = async (highlightIds: string[]) => {
    setErrorBanner(null);
    try {
      const res = await fetch('/api/exports/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ highlightIds }),
      });
      await parseJsonResponse(res, 'Batch export failed');
      await fetchBootstrap();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Batch export failed';
      setErrorBanner(msg);
      throw err;
    }
  };

  const handleSaveSettings = async (next: StudioSettings) => {
    const res = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(next),
    });
    const data = await res.json();
    if (!res.ok) {
      setErrorBanner(data.error || 'Failed to save settings');
      return;
    }
    setSettings(data.settings);
  };

  const handleAttachLocalVideo = async (projectId: string, file: File) => {
    try {
      const project = await uploadVideoInChunks({
        file,
        attachProjectId: projectId,
      });
      setProjects((prev) => prev.map((p) => (p.id === projectId ? project : p)));
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Failed to attach video');
    }
  };

  const handleRetryYouTubeDownload = async (projectId: string, cookie: string) => {
    const res = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/retry-youtube-download`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cookie }),
      }
    );
    const data = await res.json();
    if (!res.ok) {
      setErrorBanner(data.error || 'Failed to download YouTube MP4');
      return;
    }
    if (data.project) {
      setProjects((prev) => prev.map((p) => (p.id === projectId ? data.project : p)));
    }
  };

  return (
    <div className="flex min-h-screen bg-[#0B1120] text-slate-100">
      <Sidebar
        activePage={activePage}
        onNavigate={setActivePage}
        counts={{
          projects: projects.length,
          highlights: highlights.length,
          exports: exportsList.length,
        }}
        mobileOpen={mobileNavOpen}
        onCloseMobile={() => setMobileNavOpen(false)}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar
          activePage={activePage}
          projects={projects}
          activeProjectId={activeProject?.id ?? null}
          onSelectProject={(id) => {
            setActiveProjectId(id);
            setSelectedHighlightId(null);
          }}
          onNewVideo={() => setActivePage('new-video')}
          onOpenMobileNav={() => setMobileNavOpen(true)}
        />

        {errorBanner && (
          <div className="flex items-center justify-between gap-4 border-b border-rose-500/30 bg-rose-500/10 px-6 py-3 text-xs text-rose-200">
            <div className="flex items-center gap-2">
              <AlertCircle className="h-4 w-4 shrink-0 text-rose-400" />
              <span>{errorBanner}</span>
            </div>
            <button
              type="button"
              onClick={() => setErrorBanner(null)}
              className="rounded p-1 text-rose-300 hover:bg-rose-500/20"
              aria-label="Dismiss error"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        <main className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="mx-auto max-w-6xl p-8 space-y-4">
              <div className="h-8 w-64 animate-pulse rounded bg-slate-800" />
              <div className="grid grid-cols-4 gap-4">
                {[1, 2, 3, 4].map((i) => (
                  <div key={i} className="h-24 animate-pulse rounded-xl bg-slate-800/60" />
                ))}
              </div>
            </div>
          ) : (
            <>
              {activePage === 'dashboard' && (
                <DashboardPage
                  projects={projects}
                  highlights={highlights}
                  exportsList={exportsList}
                  onSelectProject={(id) => {
                    setActiveProjectId(id);
                    setSelectedHighlightId(null);
                  }}
                  onNavigate={setActivePage}
                  onRetryProject={handleRetryProject}
                  onDeleteProject={handleDeleteProject}
                />
              )}

              {activePage === 'new-video' && (
                <NewVideoPage
                  samplePresets={samplePresets}
                  activeProject={activeProject}
                  onProjectCreated={handleProjectCreated}
                  onRetryProject={handleRetryProject}
                  onNavigate={setActivePage}
                  onError={setErrorBanner}
                />
              )}

              {activePage === 'analysis' && (
                <ContentAnalysisPage
                  project={activeProject}
                  categories={allCategories}
                  editingProfiles={editingProfiles}
                  onOverrideAnalysis={handleOverrideAnalysis}
                  onReanalyzeHighlights={handleReanalyzeHighlights}
                  onRetryProject={handleRetryProject}
                  onNavigate={setActivePage}
                />
              )}

              {activePage === 'highlights' && (
                <HighlightsPage
                  project={activeProject}
                  highlights={highlights}
                  onUpdateHighlightStatus={handleUpdateHighlightStatus}
                  onRegenerateThumbnail={handleRegenerateThumbnail}
                  onOpenInEditor={(id) => {
                    setSelectedHighlightId(id);
                    setActivePage('editor');
                  }}
                  onBatchExport={handleBatchExport}
                  onNavigate={setActivePage}
                />
              )}

              {activePage === 'editor' && (
                <ClipEditorPage
                  project={activeProject}
                  highlights={highlights}
                  selectedHighlightId={selectedHighlightId}
                  editingProfiles={editingProfiles}
                  onSelectHighlight={setSelectedHighlightId}
                  onSaveHighlight={handleSaveHighlight}
                  onRegenerateThumbnail={handleRegenerateThumbnail}
                  onRenderClip={handleRenderClip}
                  onAutoHealClip={handleAutoHealClip}
                  onExportClip={handleExportClip}
                  onAttachLocalVideo={handleAttachLocalVideo}
                  onRetryYouTubeDownload={handleRetryYouTubeDownload}
                  onNavigate={setActivePage}
                />
              )}

              {activePage === 'exports' && (
                <ExportLibraryPage exportsList={exportsList} />
              )}

              {activePage === 'settings' && settings && (
                <SettingsPage
                  settings={settings}
                  builtinCategories={builtinCategories}
                  editingProfiles={editingProfiles}
                  onSaveSettings={handleSaveSettings}
                />
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
