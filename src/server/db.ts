import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import type {
  ContentAnalysis,
  ExportRecord,
  HighlightRecord,
  PipelineStage,
  ProjectRecord,
  SceneKeyframe,
  StudioSettings,
  TranscriptSegment,
  VideoMetadata,
} from '../types/studio';
import { DEFAULT_STUDIO_SETTINGS } from './categories';

export const DATA_ROOT = path.resolve(process.cwd(), 'data');
export const UPLOADS_DIR = path.join(DATA_ROOT, 'uploads');
export const PROJECTS_DIR = path.join(DATA_ROOT, 'projects');
export const EXPORTS_DIR = path.join(DATA_ROOT, 'exports');

for (const dir of [DATA_ROOT, UPLOADS_DIR, PROJECTS_DIR, EXPORTS_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Ensures resolved file paths stay strictly inside an intended base directory.
 */
export function resolveSafePath(baseDir: string, ...segments: string[]): string {
  const resolvedBase = path.resolve(baseDir);
  const candidate = path.resolve(resolvedBase, ...segments);
  if (candidate !== resolvedBase && !candidate.startsWith(resolvedBase + path.sep)) {
    throw new Error('Unsafe path outside permitted workspace directory');
  }
  return candidate;
}

export function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9\u0600-\u06FF]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'clip'
  );
}

const DB_PATH = path.join(DATA_ROOT, 'clipper.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    source_filename TEXT NOT NULL,
    source_path TEXT NOT NULL,
    source_url TEXT NOT NULL,
    audio_path TEXT,
    status TEXT NOT NULL DEFAULT 'processing',
    current_stage TEXT NOT NULL DEFAULT 'queued',
    stage_progress INTEGER NOT NULL DEFAULT 0,
    stage_message TEXT NOT NULL DEFAULT '',
    error_message TEXT,
    metadata_json TEXT,
    transcript_json TEXT NOT NULL DEFAULT '[]',
    scenes_json TEXT NOT NULL DEFAULT '[]',
    analysis_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS highlights (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    start_time REAL NOT NULL,
    end_time REAL NOT NULL,
    duration REAL NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    category_id TEXT NOT NULL,
    category_name TEXT NOT NULL,
    secondary_category_name TEXT,
    selection_explanation TEXT NOT NULL,
    keywords_json TEXT NOT NULL DEFAULT '[]',
    criteria_breakdown_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'candidate',
    editing_profile TEXT NOT NULL,
    subtitle_style TEXT NOT NULL,
    highlight_color TEXT NOT NULL,
    crop_mode TEXT NOT NULL,
    dynamic_zoom INTEGER NOT NULL DEFAULT 0,
    normalize_audio INTEGER NOT NULL DEFAULT 1,
    watermark_enabled INTEGER NOT NULL DEFAULT 0,
    rendered_video_path TEXT,
    rendered_video_url TEXT,
    qc_report_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS exports (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    project_title TEXT NOT NULL,
    highlight_id TEXT NOT NULL,
    clip_title TEXT NOT NULL,
    category_id TEXT NOT NULL,
    category_name TEXT NOT NULL,
    editing_profile TEXT NOT NULL,
    video_path TEXT NOT NULL,
    video_url TEXT NOT NULL,
    metadata_json_path TEXT NOT NULL,
    metadata_json_url TEXT NOT NULL,
    output_dir TEXT NOT NULL,
    resolution TEXT NOT NULL,
    duration REAL NOT NULL,
    file_size INTEGER NOT NULL,
    platforms_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (highlight_id) REFERENCES highlights(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

const projectCols = (
  db.prepare(`PRAGMA table_info(projects)`).all() as Array<{ name: string }>
).map((c) => c.name);
if (!projectCols.includes('youtube_video_id')) {
  db.exec(`ALTER TABLE projects ADD COLUMN youtube_video_id TEXT`);
}
if (!projectCols.includes('has_local_video')) {
  db.exec(`ALTER TABLE projects ADD COLUMN has_local_video INTEGER NOT NULL DEFAULT 1`);
}

export interface ProjectRowInternal extends ProjectRecord {
  sourcePath: string;
  audioPath: string | null;
}

export interface HighlightRowInternal extends HighlightRecord {
  renderedVideoPath: string | null;
}

function mapProjectRow(row: Record<string, unknown>): ProjectRowInternal {
  return {
    id: String(row.id),
    title: String(row.title),
    sourceFilename: String(row.source_filename),
    sourcePath: String(row.source_path),
    sourceUrl: String(row.source_url),
    youtubeVideoId: row.youtube_video_id ? String(row.youtube_video_id) : null,
    hasLocalVideoFile: row.has_local_video === undefined ? true : Boolean(row.has_local_video),
    audioPath: row.audio_path ? String(row.audio_path) : null,
    status: row.status as ProjectRecord['status'],
    currentStage: row.current_stage as PipelineStage,
    stageProgress: Number(row.stage_progress ?? 0),
    stageMessage: String(row.stage_message ?? ''),
    errorMessage: row.error_message ? String(row.error_message) : null,
    metadata: row.metadata_json ? (JSON.parse(String(row.metadata_json)) as VideoMetadata) : null,
    transcript: JSON.parse(String(row.transcript_json || '[]')) as TranscriptSegment[],
    scenes: JSON.parse(String(row.scenes_json || '[]')) as SceneKeyframe[],
    analysis: row.analysis_json ? (JSON.parse(String(row.analysis_json)) as ContentAnalysis) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapHighlightRow(row: Record<string, unknown>): HighlightRowInternal {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    startTime: Number(row.start_time),
    endTime: Number(row.end_time),
    duration: Number(row.duration),
    title: String(row.title),
    description: String(row.description),
    categoryId: String(row.category_id),
    categoryName: String(row.category_name),
    secondaryCategoryName: row.secondary_category_name ? String(row.secondary_category_name) : null,
    selectionExplanation: String(row.selection_explanation),
    keywords: JSON.parse(String(row.keywords_json || '[]')),
    criteriaBreakdown: JSON.parse(String(row.criteria_breakdown_json)),
    status: row.status as HighlightRecord['status'],
    editingProfile: row.editing_profile as HighlightRecord['editingProfile'],
    subtitleStyle: row.subtitle_style as HighlightRecord['subtitleStyle'],
    highlightColor: String(row.highlight_color),
    cropMode: row.crop_mode as HighlightRecord['cropMode'],
    dynamicZoom: Boolean(row.dynamic_zoom),
    normalizeAudio: Boolean(row.normalize_audio),
    watermarkEnabled: Boolean(row.watermark_enabled),
    renderedVideoPath: row.rendered_video_path ? String(row.rendered_video_path) : null,
    renderedVideoUrl: row.rendered_video_url ? String(row.rendered_video_url) : null,
    qcReport: row.qc_report_json ? JSON.parse(String(row.qc_report_json)) : null,
  };
}

function mapExportRow(row: Record<string, unknown>): ExportRecord {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    projectTitle: String(row.project_title),
    highlightId: String(row.highlight_id),
    clipTitle: String(row.clip_title),
    categoryId: String(row.category_id),
    categoryName: String(row.category_name),
    editingProfile: row.editing_profile as ExportRecord['editingProfile'],
    videoUrl: String(row.video_url),
    metadataJsonUrl: String(row.metadata_json_url),
    outputDir: String(row.output_dir),
    resolution: String(row.resolution),
    duration: Number(row.duration),
    fileSize: Number(row.file_size),
    platforms: JSON.parse(String(row.platforms_json)),
    createdAt: String(row.created_at),
  };
}

export const store = {
  createProject(params: {
    id: string;
    title: string;
    sourceFilename: string;
    sourcePath: string;
    sourceUrl: string;
    youtubeVideoId?: string | null;
    hasLocalVideoFile?: boolean;
  }): ProjectRowInternal {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO projects (
        id, title, source_filename, source_path, source_url, youtube_video_id, has_local_video,
        status, current_stage, stage_progress, stage_message, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'processing', 'queued', 0, 'Queued for ingestion', ?, ?)`
    ).run(
      params.id,
      params.title,
      params.sourceFilename,
      params.sourcePath,
      params.sourceUrl,
      params.youtubeVideoId ?? null,
      params.hasLocalVideoFile === false ? 0 : 1,
      now,
      now
    );
    return this.getProjectInternal(params.id)!;
  },

  listProjects(): ProjectRecord[] {
    const rows = db.prepare(`SELECT * FROM projects ORDER BY created_at DESC`).all() as Record<
      string,
      unknown
    >[];
    return rows.map((r) => {
      const { sourcePath: _sp, audioPath: _ap, ...pub } = mapProjectRow(r);
      return pub;
    });
  },

  getProject(id: string): ProjectRecord | null {
    const row = this.getProjectInternal(id);
    if (!row) return null;
    const { sourcePath: _sp, audioPath: _ap, ...pub } = row;
    return pub;
  },

  getProjectInternal(id: string): ProjectRowInternal | null {
    const row = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? mapProjectRow(row) : null;
  },

  updateProjectStage(
    id: string,
    stage: PipelineStage,
    progress: number,
    message: string,
    status: ProjectRecord['status'] = 'processing',
    errorMessage: string | null = null
  ): void {
    db.prepare(
      `UPDATE projects SET current_stage = ?, stage_progress = ?, stage_message = ?, status = ?, error_message = ?, updated_at = ? WHERE id = ?`
    ).run(stage, progress, message, status, errorMessage, new Date().toISOString(), id);
  },

  recoverInterruptedProjects(): void {
    const msg = 'Pipeline was interrupted by a server restart. Click Retry to resume.';
    db.prepare(
      `UPDATE projects SET status = 'error', current_stage = 'failed', stage_progress = 0, stage_message = ?, error_message = ?, updated_at = ? WHERE status = 'processing'`
    ).run(msg, msg, new Date().toISOString());
  },

  updateProjectTitle(id: string, title: string): void {
    db.prepare(`UPDATE projects SET title = ?, updated_at = ? WHERE id = ?`).run(
      title,
      new Date().toISOString(),
      id
    );
  },

  updateProjectLocalMedia(
    id: string,
    params: {
      sourceFilename: string;
      sourcePath: string;
      sourceUrl: string;
      hasLocalVideoFile: boolean;
    }
  ): void {
    db.prepare(
      `UPDATE projects SET source_filename = ?, source_path = ?, source_url = ?, has_local_video = ?, updated_at = ? WHERE id = ?`
    ).run(
      params.sourceFilename,
      params.sourcePath,
      params.sourceUrl,
      params.hasLocalVideoFile ? 1 : 0,
      new Date().toISOString(),
      id
    );
  },

  saveIngestionData(
    id: string,
    metadata: VideoMetadata,
    audioPath: string | null,
    scenes: SceneKeyframe[]
  ): void {
    db.prepare(
      `UPDATE projects SET metadata_json = ?, audio_path = ?, scenes_json = ?, updated_at = ? WHERE id = ?`
    ).run(
      JSON.stringify(metadata),
      audioPath,
      JSON.stringify(scenes),
      new Date().toISOString(),
      id
    );
  },

  saveTranscript(id: string, transcript: TranscriptSegment[]): void {
    db.prepare(`UPDATE projects SET transcript_json = ?, updated_at = ? WHERE id = ?`).run(
      JSON.stringify(transcript),
      new Date().toISOString(),
      id
    );
  },

  saveAnalysis(id: string, analysis: ContentAnalysis): void {
    db.prepare(`UPDATE projects SET analysis_json = ?, updated_at = ? WHERE id = ?`).run(
      JSON.stringify(analysis),
      new Date().toISOString(),
      id
    );
  },

  deleteProject(id: string): void {
    db.prepare(`DELETE FROM projects WHERE id = ?`).run(id);
  },

  replaceProjectHighlights(projectId: string, highlights: HighlightRecord[]): void {
    const del = db.prepare(`DELETE FROM highlights WHERE project_id = ?`);
    const ins = db.prepare(
      `INSERT INTO highlights (
        id, project_id, start_time, end_time, duration, title, description,
        category_id, category_name, secondary_category_name, selection_explanation,
        keywords_json, criteria_breakdown_json, status, editing_profile,
        subtitle_style, highlight_color, crop_mode, dynamic_zoom, normalize_audio,
        watermark_enabled, rendered_video_path, rendered_video_url, qc_report_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const now = new Date().toISOString();
    const tx = db.transaction(() => {
      del.run(projectId);
      for (const h of highlights) {
        ins.run(
          h.id,
          projectId,
          h.startTime,
          h.endTime,
          h.duration,
          h.title,
          h.description,
          h.categoryId,
          h.categoryName,
          h.secondaryCategoryName,
          h.selectionExplanation,
          JSON.stringify(h.keywords),
          JSON.stringify(h.criteriaBreakdown),
          h.status,
          h.editingProfile,
          h.subtitleStyle,
          h.highlightColor,
          h.cropMode,
          h.dynamicZoom ? 1 : 0,
          h.normalizeAudio ? 1 : 0,
          h.watermarkEnabled ? 1 : 0,
          null,
          h.renderedVideoUrl,
          h.qcReport ? JSON.stringify(h.qcReport) : null,
          now,
          now
        );
      }
    });
    tx();
  },

  listHighlights(projectId?: string): HighlightRecord[] {
    const rows = projectId
      ? (db
          .prepare(`SELECT * FROM highlights WHERE project_id = ? ORDER BY start_time ASC`)
          .all(projectId) as Record<string, unknown>[])
      : (db.prepare(`SELECT * FROM highlights ORDER BY created_at DESC`).all() as Record<
          string,
          unknown
        >[]);
    return rows.map((r) => {
      const { renderedVideoPath: _rvp, ...pub } = mapHighlightRow(r);
      return pub;
    });
  },

  getHighlightInternal(id: string): HighlightRowInternal | null {
    const row = db.prepare(`SELECT * FROM highlights WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? mapHighlightRow(row) : null;
  },

  updateHighlight(
    id: string,
    patch: Partial<{
      startTime: number;
      endTime: number;
      duration: number;
      title: string;
      description: string;
      status: HighlightRecord['status'];
      editingProfile: HighlightRecord['editingProfile'];
      subtitleStyle: HighlightRecord['subtitleStyle'];
      highlightColor: string;
      cropMode: HighlightRecord['cropMode'];
      dynamicZoom: boolean;
      normalizeAudio: boolean;
      watermarkEnabled: boolean;
      renderedVideoPath: string | null;
      renderedVideoUrl: string | null;
      qcReport: HighlightRecord['qcReport'];
    }>
  ): HighlightRecord | null {
    const existing = this.getHighlightInternal(id);
    if (!existing) return null;

    const startTime = patch.startTime ?? existing.startTime;
    const endTime = patch.endTime ?? existing.endTime;
    const duration = patch.duration ?? Math.max(1, Number((endTime - startTime).toFixed(2)));

    db.prepare(
      `UPDATE highlights SET
        start_time = ?, end_time = ?, duration = ?, title = ?, description = ?,
        status = ?, editing_profile = ?, subtitle_style = ?, highlight_color = ?,
        crop_mode = ?, dynamic_zoom = ?, normalize_audio = ?, watermark_enabled = ?,
        rendered_video_path = ?, rendered_video_url = ?, qc_report_json = ?, updated_at = ?
      WHERE id = ?`
    ).run(
      startTime,
      endTime,
      duration,
      patch.title ?? existing.title,
      patch.description ?? existing.description,
      patch.status ?? existing.status,
      patch.editingProfile ?? existing.editingProfile,
      patch.subtitleStyle ?? existing.subtitleStyle,
      patch.highlightColor ?? existing.highlightColor,
      patch.cropMode ?? existing.cropMode,
      (patch.dynamicZoom ?? existing.dynamicZoom) ? 1 : 0,
      (patch.normalizeAudio ?? existing.normalizeAudio) ? 1 : 0,
      (patch.watermarkEnabled ?? existing.watermarkEnabled) ? 1 : 0,
      patch.renderedVideoPath !== undefined ? patch.renderedVideoPath : existing.renderedVideoPath,
      patch.renderedVideoUrl !== undefined ? patch.renderedVideoUrl : existing.renderedVideoUrl,
      patch.qcReport !== undefined
        ? patch.qcReport
          ? JSON.stringify(patch.qcReport)
          : null
        : existing.qcReport
        ? JSON.stringify(existing.qcReport)
        : null,
      new Date().toISOString(),
      id
    );

    const updated = this.getHighlightInternal(id);
    if (!updated) return null;
    const { renderedVideoPath: _rvp, ...pub } = updated;
    return pub;
  },

  createExport(params: ExportRecord & { videoPath: string; metadataJsonPath: string }): ExportRecord {
    db.prepare(
      `INSERT INTO exports (
        id, project_id, project_title, highlight_id, clip_title, category_id, category_name,
        editing_profile, video_path, video_url, metadata_json_path, metadata_json_url,
        output_dir, resolution, duration, file_size, platforms_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      params.id,
      params.projectId,
      params.projectTitle,
      params.highlightId,
      params.clipTitle,
      params.categoryId,
      params.categoryName,
      params.editingProfile,
      params.videoPath,
      params.videoUrl,
      params.metadataJsonPath,
      params.metadataJsonUrl,
      params.outputDir,
      params.resolution,
      params.duration,
      params.fileSize,
      JSON.stringify(params.platforms),
      params.createdAt
    );
    return params;
  },

  listExports(): ExportRecord[] {
    const rows = db.prepare(`SELECT * FROM exports ORDER BY created_at DESC`).all() as Record<
      string,
      unknown
    >[];
    return rows.map(mapExportRow);
  },

  getSettings(): StudioSettings {
    const row = db
      .prepare(`SELECT value_json FROM settings WHERE key = 'studio_settings'`)
      .get() as { value_json: string } | undefined;
    if (!row) {
      return DEFAULT_STUDIO_SETTINGS;
    }
    try {
      const parsed = JSON.parse(row.value_json) as Partial<StudioSettings>;
      return {
        ...DEFAULT_STUDIO_SETTINGS,
        ...parsed,
        customCategories: Array.isArray(parsed.customCategories) ? parsed.customCategories : [],
      };
    } catch {
      return DEFAULT_STUDIO_SETTINGS;
    }
  },

  saveSettings(settings: StudioSettings): StudioSettings {
    db.prepare(
      `INSERT INTO settings (key, value_json, updated_at) VALUES ('studio_settings', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
    ).run(JSON.stringify(settings), new Date().toISOString());
    return this.getSettings();
  },
};
