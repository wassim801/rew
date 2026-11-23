import { Plus, Save, Trash2 } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import type { CategoryConfig, EditingProfileId, EditingProfileSpec, StudioSettings } from '../types/studio';

interface SettingsPageProps {
  settings: StudioSettings;
  builtinCategories: CategoryConfig[];
  editingProfiles: EditingProfileSpec[];
  onSaveSettings: (next: StudioSettings) => Promise<void>;
}

export function SettingsPage({
  settings,
  builtinCategories,
  editingProfiles,
  onSaveSettings,
}: SettingsPageProps) {
  const [form, setForm] = useState<StudioSettings>(settings);
  const [saving, setSaving] = useState(false);
  const [savedNotice, setSavedNotice] = useState(false);

  const [newCatName, setNewCatName] = useState('');
  const [newCatDesc, setNewCatDesc] = useState('');
  const [newCatStrategy, setNewCatStrategy] = useState('');
  const [newCatProfile, setNewCatProfile] = useState<EditingProfileId>('Minimal');

  useEffect(() => {
    setForm(settings);
  }, [settings]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setSavedNotice(false);
    try {
      await onSaveSettings(form);
      setSavedNotice(true);
      setTimeout(() => setSavedNotice(false), 2200);
    } finally {
      setSaving(false);
    }
  };

  const handleAddCategory = () => {
    if (!newCatName.trim()) return;
    const id =
      newCatName
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '') || `custom_${Date.now()}`;

    const newCat: CategoryConfig = {
      id,
      name: newCatName.trim(),
      description: newCatDesc.trim() || 'User-configured custom video category.',
      highlightStrategy:
        newCatStrategy.trim() ||
        'Select clear, self-contained moments with strong hooks and complete context.',
      defaultEditingProfile: newCatProfile,
      avoidEffects: newCatProfile === 'Educational' || newCatProfile === 'Minimal',
      criteriaWeights: {
        hookStrength: 0.2,
        standaloneContext: 0.2,
        audienceInterest: 0.2,
        emotionalOrInfoValue: 0.2,
        contentCompleteness: 0.12,
        audioVisualQuality: 0.08,
      },
      isCustom: true,
    };

    setForm((prev) => ({
      ...prev,
      customCategories: [...prev.customCategories, newCat],
    }));
    setNewCatName('');
    setNewCatDesc('');
    setNewCatStrategy('');
  };

  const handleRemoveCustomCategory = (id: string) => {
    setForm((prev) => ({
      ...prev,
      customCategories: prev.customCategories.filter((c) => c.id !== id),
    }));
  };

  return (
    <div className="mx-auto max-w-5xl space-y-8 p-6 lg:p-8">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight text-slate-50">
          Studio Configuration & Categories
        </h2>
        <p className="mt-1 text-sm text-slate-400">
          Configure clip duration limits, FFmpeg loudness/subtitle defaults, and custom content categories.
        </p>
      </div>

      <form onSubmit={handleSave} className="space-y-8">
        <section className="rounded-xl border border-slate-800 bg-[#111827] p-6 space-y-5">
          <h3 className="text-base font-semibold text-slate-100">
            Rendering, Duration & Audio Defaults
          </h3>

          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            <label className="block text-xs font-medium text-slate-300">
              Minimum Clip Duration (sec)
              <input
                type="number"
                min={5}
                max={120}
                value={form.minClipDuration}
                onChange={(e) =>
                  setForm({ ...form, minClipDuration: Number(e.target.value) || 15 })
                }
                className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 font-mono text-sm text-slate-100 focus:border-blue-500 focus:outline-none"
              />
            </label>

            <label className="block text-xs font-medium text-slate-300">
              Maximum Clip Duration (sec)
              <input
                type="number"
                min={10}
                max={180}
                value={form.maxClipDuration}
                onChange={(e) =>
                  setForm({ ...form, maxClipDuration: Number(e.target.value) || 60 })
                }
                className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 font-mono text-sm text-slate-100 focus:border-blue-500 focus:outline-none"
              />
            </label>

            <label className="block text-xs font-medium text-slate-300">
              Audio Loudness Target (LUFS)
              <input
                type="number"
                min={-24}
                max={-8}
                value={form.audioTargetLufs}
                onChange={(e) =>
                  setForm({ ...form, audioTargetLufs: Number(e.target.value) || -14 })
                }
                className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 font-mono text-sm text-slate-100 focus:border-blue-500 focus:outline-none"
              />
            </label>

            <label className="block text-xs font-medium text-slate-300">
              Subtitle Font Size (px at 1080×1920)
              <input
                type="number"
                min={36}
                max={72}
                value={form.subtitleFontSize}
                onChange={(e) =>
                  setForm({ ...form, subtitleFontSize: Number(e.target.value) || 54 })
                }
                className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 font-mono text-sm text-slate-100 focus:border-blue-500 focus:outline-none"
              />
            </label>

            <label className="block text-xs font-medium text-slate-300">
              Transcription Language Hint
              <select
                value={form.defaultLanguageHint}
                onChange={(e) =>
                  setForm({
                    ...form,
                    defaultLanguageHint: e.target.value as StudioSettings['defaultLanguageHint'],
                  })
                }
                className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-blue-500 focus:outline-none"
              >
                <option value="auto">Auto-detect (EN / FR / AR)</option>
                <option value="en">English</option>
                <option value="fr">Français</option>
                <option value="ar">العربية</option>
              </select>
            </label>

            <label className="block text-xs font-medium text-slate-300">
              Optional Watermark Text
              <input
                type="text"
                value={form.watermarkText}
                onChange={(e) => setForm({ ...form, watermarkText: e.target.value })}
                className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-blue-500 focus:outline-none"
              />
            </label>
          </div>

          <label className="inline-flex items-center gap-2 text-xs text-slate-200 cursor-pointer">
            <input
              type="checkbox"
              checked={form.enableWatermarkByDefault}
              onChange={(e) =>
                setForm({ ...form, enableWatermarkByDefault: e.target.checked })
              }
              className="h-4 w-4 rounded border-slate-600 accent-blue-500"
            />
            <span>Enable watermark overlay on new renders by default</span>
          </label>
        </section>

        {/* Custom Categories Configuration */}
        <section className="rounded-xl border border-slate-800 bg-[#111827] p-6 space-y-5">
          <div>
            <h3 className="text-base font-semibold text-slate-100">
              Configured Content Categories ({builtinCategories.length + form.customCategories.length})
            </h3>
            <p className="mt-1 text-xs text-slate-400">
              Built-in taxonomy plus user-defined categories available to the Content Understanding & Highlight Agents.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {builtinCategories.map((cat) => (
              <div
                key={cat.id}
                className="rounded-lg border border-slate-800 bg-slate-900/50 p-3.5"
              >
                <p className="text-xs font-semibold text-slate-100">{cat.name}</p>
                <p className="mt-1 text-xs text-slate-400">
                  Default profile: {cat.defaultEditingProfile}
                </p>
              </div>
            ))}

            {form.customCategories.map((cat) => (
              <div
                key={cat.id}
                className="flex items-start justify-between gap-2 rounded-lg border border-blue-500/30 bg-blue-500/5 p-3.5"
              >
                <div>
                  <p className="text-xs font-semibold text-blue-300">{cat.name}</p>
                  <p className="mt-1 text-xs text-slate-400">
                    Custom · Profile: {cat.defaultEditingProfile}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => handleRemoveCustomCategory(cat.id)}
                  className="text-slate-400 hover:text-rose-400"
                  aria-label={`Remove ${cat.name}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>

          <div className="border-t border-slate-800 pt-5 space-y-4">
            <h4 className="text-xs font-semibold text-slate-200">Add Custom Category</h4>
            <div className="grid gap-4 sm:grid-cols-2">
              <input
                type="text"
                value={newCatName}
                onChange={(e) => setNewCatName(e.target.value)}
                placeholder="Category name (e.g., Culinary & Recipes)"
                className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-blue-500 focus:outline-none"
              />
              <select
                value={newCatProfile}
                onChange={(e) => setNewCatProfile(e.target.value as EditingProfileId)}
                className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-blue-500 focus:outline-none"
              >
                {editingProfiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    Default Profile: {p.label}
                  </option>
                ))}
              </select>
              <input
                type="text"
                value={newCatDesc}
                onChange={(e) => setNewCatDesc(e.target.value)}
                placeholder="Short category description..."
                className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-blue-500 focus:outline-none sm:col-span-2"
              />
              <input
                type="text"
                value={newCatStrategy}
                onChange={(e) => setNewCatStrategy(e.target.value)}
                placeholder="Highlight selection strategy (what moments should the AI prioritize?)..."
                className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-blue-500 focus:outline-none sm:col-span-2"
              />
            </div>
            <button
              type="button"
              onClick={handleAddCategory}
              disabled={!newCatName.trim()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-3.5 py-2 text-xs font-medium text-slate-100 hover:bg-slate-800 disabled:opacity-50"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>Add Category</span>
            </button>
          </div>
        </section>

        <div className="flex items-center justify-end gap-4">
          {savedNotice && (
            <span className="text-xs font-medium text-emerald-400">
              Configuration saved to SQLite.
            </span>
          )}
          <button
            type="submit"
            disabled={saving}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
          >
            <Save className="h-4 w-4" />
            <span>{saving ? 'Saving...' : 'Save Settings'}</span>
          </button>
        </div>
      </form>
    </div>
  );
}
