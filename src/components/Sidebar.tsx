import {
  BrainCircuit,
  FolderOutput,
  LayoutDashboard,
  PlusSquare,
  Scissors,
  Settings,
  Sparkles,
  X,
} from 'lucide-react';
import React from 'react';

export type StudioPage =
  | 'dashboard'
  | 'new-video'
  | 'analysis'
  | 'highlights'
  | 'editor'
  | 'exports'
  | 'settings';

interface SidebarProps {
  activePage: StudioPage;
  onNavigate: (page: StudioPage) => void;
  counts: {
    projects: number;
    highlights: number;
    exports: number;
  };
  mobileOpen: boolean;
  onCloseMobile: () => void;
}

const NAV_ITEMS: Array<{
  id: StudioPage;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'new-video', label: 'New Video', icon: PlusSquare },
  { id: 'analysis', label: 'AI Content Analysis', icon: BrainCircuit },
  { id: 'highlights', label: 'AI Highlights', icon: Sparkles },
  { id: 'editor', label: 'Clip Preview & Editor', icon: Scissors },
  { id: 'exports', label: 'Export Library', icon: FolderOutput },
  { id: 'settings', label: 'Settings', icon: Settings },
];

export function Sidebar({
  activePage,
  onNavigate,
  counts,
  mobileOpen,
  onCloseMobile,
}: SidebarProps) {
  const getCount = (id: StudioPage): number | null => {
    if (id === 'dashboard') return counts.projects;
    if (id === 'highlights') return counts.highlights;
    if (id === 'exports') return counts.exports;
    return null;
  };

  return (
    <>
      {mobileOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/60 lg:hidden"
          onClick={onCloseMobile}
          aria-hidden="true"
        />
      )}

      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r border-slate-800 bg-[#0F172A] transition-transform duration-200 lg:static lg:translate-x-0 ${
          mobileOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex h-16 items-center justify-between border-b border-slate-800 px-5">
          <button
            type="button"
            onClick={() => {
              onNavigate('dashboard');
              onCloseMobile();
            }}
            className="text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded"
          >
            <span className="font-semibold tracking-tight text-slate-50 text-lg whitespace-nowrap">
              ClipForge Studio
            </span>
          </button>
          <button
            type="button"
            onClick={onCloseMobile}
            className="rounded p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-100 lg:hidden"
            aria-label="Close navigation"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-4" aria-label="Studio navigation">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = activePage === item.id;
            const count = getCount(item.id);
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  onNavigate(item.id);
                  onCloseMobile();
                }}
                className={`flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-sm font-medium transition-colors whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                  active
                    ? 'bg-blue-600/15 text-blue-400'
                    : 'text-slate-300 hover:bg-slate-800/70 hover:text-slate-50'
                }`}
              >
                <span className="flex items-center gap-3 min-w-0">
                  <Icon className={`h-4 w-4 shrink-0 ${active ? 'text-blue-400' : 'text-slate-400'}`} />
                  <span className="truncate">{item.label}</span>
                </span>
                {count !== null && (
                  <span className="font-mono text-xs tabular-nums text-slate-400">{count}</span>
                )}
              </button>
            );
          })}
        </nav>

        <div className="border-t border-slate-800 px-5 py-4 text-xs text-slate-400">
          <p className="font-medium text-slate-300">Local-First Workspace</p>
          <p className="mt-0.5 text-slate-400">SQLite · FFmpeg 9:16 · H.264/AAC</p>
        </div>
      </aside>
    </>
  );
}
