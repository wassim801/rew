import { Check, Copy, Download, FileJson, FolderOpen } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { ExportRecord } from '../types/studio';
import { formatBytes, formatDuration, isArabicText } from '../utils/format';

interface ExportLibraryPageProps {
  exportsList: ExportRecord[];
}

export function ExportLibraryPage({ exportsList }: ExportLibraryPageProps) {
  const [projectFilter, setProjectFilter] = useState('all');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [platformTab, setPlatformTab] = useState<Record<string, 'tiktok' | 'reels' | 'shorts'>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const projectOptions = useMemo(() => {
    const map = new Map<string, string>();
    exportsList.forEach((e) => map.set(e.projectId, e.projectTitle));
    return Array.from(map.entries());
  }, [exportsList]);

  const categoryOptions = useMemo(() => {
    const map = new Map<string, string>();
    exportsList.forEach((e) => map.set(e.categoryId, e.categoryName));
    return Array.from(map.entries());
  }, [exportsList]);

  const filtered = exportsList.filter((exp) => {
    if (projectFilter !== 'all' && exp.projectId !== projectFilter) return false;
    if (categoryFilter !== 'all' && exp.categoryId !== categoryFilter) return false;
    return true;
  });

  const handleCopy = async (key: string, text: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedId(key);
    setTimeout(() => setCopiedId(null), 1800);
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6 lg:p-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight text-slate-50">
            Export Library
          </h2>
          <p className="mt-1 text-sm text-slate-400">
            Local H.264 MP4 + AAC exports organized by project and category, paired with TikTok, Instagram Reels, and YouTube Shorts copy.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <select
            value={projectFilter}
            onChange={(e) => setProjectFilter(e.target.value)}
            className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs text-slate-100 focus:border-blue-500 focus:outline-none"
          >
            <option value="all">All Projects</option>
            {projectOptions.map(([id, title]) => (
              <option key={id} value={id}>
                {title}
              </option>
            ))}
          </select>

          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs text-slate-100 focus:border-blue-500 focus:outline-none"
          >
            <option value="all">All Categories</option>
            {categoryOptions.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-xl border border-slate-800 bg-[#111827] px-6 py-16 text-center">
          <FolderOpen className="mx-auto h-10 w-10 text-slate-600" />
          <h3 className="mt-4 text-base font-medium text-slate-200">No Exported Clips Yet</h3>
          <p className="mt-1 text-sm text-slate-400">
            Approve and export highlights from AI Highlights or Clip Preview & Editor to build your local export library.
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {filtered.map((exp) => {
            const activeTab = platformTab[exp.id] ?? 'tiktok';
            const copyObj = exp.platforms[activeTab];
            const fullSocialText = `${copyObj.title}\n\n${copyObj.description}\n\n${copyObj.hashtags.join(' ')}`;
            const rtl = isArabicText(copyObj.title) || isArabicText(copyObj.description);

            return (
              <article
                key={exp.id}
                className="grid gap-6 rounded-xl border border-slate-800 bg-[#111827] p-6 lg:grid-cols-12"
              >
                <div className="lg:col-span-3 flex justify-center">
                  <div className="w-44 aspect-[9/16] overflow-hidden rounded-xl border border-slate-700 bg-black">
                    <video
                      src={exp.videoUrl}
                      preload="metadata"
                      controls
                      playsInline
                      className="h-full w-full object-cover"
                    />
                  </div>
                </div>

                <div className="lg:col-span-9 flex flex-col justify-between space-y-5">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <p className="text-xs text-slate-400">
                        <span className="text-blue-400 font-medium">{exp.categoryName}</span>
                        {' · '}
                        <span>{exp.projectTitle}</span>
                        {' · '}
                        <span>{exp.editingProfile}</span>
                      </p>
                      <h3 className="mt-1 text-lg font-semibold text-slate-50">{exp.clipTitle}</h3>
                      <p className="mt-1 font-mono text-xs tabular-nums text-slate-400">
                        {exp.resolution} · {formatDuration(exp.duration)} · {formatBytes(exp.fileSize)} ·{' '}
                        {exp.outputDir}
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 shrink-0">
                      <a
                        href={`${exp.videoUrl}?download=1`}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-2 text-xs font-medium text-white hover:bg-blue-500 whitespace-nowrap"
                      >
                        <Download className="h-3.5 w-3.5" />
                        <span>Download MP4</span>
                      </a>
                      <a
                        href={`${exp.metadataJsonUrl}?download=1`}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-3.5 py-2 text-xs font-medium text-slate-200 hover:bg-slate-800 whitespace-nowrap"
                      >
                        <FileJson className="h-3.5 w-3.5" />
                        <span>Metadata JSON</span>
                      </a>
                    </div>
                  </div>

                  {/* Platform Social Copy */}
                  <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-4 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="inline-flex items-center gap-1 rounded-md bg-slate-900 p-0.5 border border-slate-800">
                        {(
                          [
                            ['tiktok', 'TikTok'],
                            ['reels', 'Instagram Reels'],
                            ['shorts', 'YouTube Shorts'],
                          ] as const
                        ).map(([key, label]) => (
                          <button
                            key={key}
                            type="button"
                            onClick={() =>
                              setPlatformTab((prev) => ({ ...prev, [exp.id]: key }))
                            }
                            className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                              activeTab === key
                                ? 'bg-slate-800 text-slate-50'
                                : 'text-slate-400 hover:text-slate-200'
                            }`}
                          >
                            {label}
                          </button>
                        ))}
                      </div>

                      <button
                        type="button"
                        onClick={() => handleCopy(`${exp.id}_${activeTab}`, fullSocialText)}
                        className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-400 hover:text-blue-300"
                      >
                        {copiedId === `${exp.id}_${activeTab}` ? (
                          <>
                            <Check className="h-3.5 w-3.5" />
                            <span>Copied</span>
                          </>
                        ) : (
                          <>
                            <Copy className="h-3.5 w-3.5" />
                            <span>Copy Caption & Tags</span>
                          </>
                        )}
                      </button>
                    </div>

                    <div dir={rtl ? 'rtl' : 'ltr'} className="space-y-1.5 text-sm">
                      <p className="font-semibold text-slate-100">{copyObj.title}</p>
                      <p className="text-xs leading-relaxed text-slate-300">{copyObj.description}</p>
                      <p className="text-xs text-blue-400">{copyObj.hashtags.join(' ')}</p>
                    </div>
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
