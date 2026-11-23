import { Menu, Plus } from 'lucide-react';
import type { ProjectRecord } from '../types/studio';
import type { StudioPage } from './Sidebar';

interface TopBarProps {
  activePage: StudioPage;
  projects: ProjectRecord[];
  activeProjectId: string | null;
  onSelectProject: (id: string) => void;
  onNewVideo: () => void;
  onOpenMobileNav: () => void;
}

const PAGE_TITLES: Record<StudioPage, string> = {
  dashboard: 'Studio / Dashboard',
  'new-video': 'Studio / New Video',
  analysis: 'Studio / AI Content Analysis',
  highlights: 'Studio / AI Highlights',
  editor: 'Studio / Clip Preview & Editor',
  exports: 'Studio / Export Library',
  settings: 'Studio / Settings',
};

export function TopBar({
  activePage,
  projects,
  activeProjectId,
  onSelectProject,
  onNewVideo,
  onOpenMobileNav,
}: TopBarProps) {
  return (
    <header className="flex h-16 shrink-0 items-center justify-between gap-8 border-b border-slate-800 bg-[#0F172A] px-6">
      <div className="flex items-center gap-3 min-w-0">
        <button
          type="button"
          onClick={onOpenMobileNav}
          className="rounded-lg p-2 text-slate-300 hover:bg-slate-800 lg:hidden"
          aria-label="Open navigation"
        >
          <Menu className="h-5 w-5" />
        </button>
        <h1 className="truncate text-sm font-medium text-slate-200 whitespace-nowrap">
          {PAGE_TITLES[activePage]}
        </h1>
      </div>

      <div className="hidden md:flex items-center gap-3 min-w-0 max-w-md flex-1 justify-end">
        {projects.length > 0 && (
          <label className="flex items-center gap-2 text-xs text-slate-400 min-w-0">
            <span className="whitespace-nowrap shrink-0">Active project</span>
            <select
              value={activeProjectId ?? ''}
              onChange={(e) => onSelectProject(e.target.value)}
              className="max-w-xs truncate rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-100 focus:border-blue-500 focus:outline-none"
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div className="flex items-center shrink-0">
        <button
          type="button"
          onClick={onNewVideo}
          className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500 whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
        >
          <Plus className="h-4 w-4" />
          <span>Import Video</span>
        </button>
      </div>
    </header>
  );
}
