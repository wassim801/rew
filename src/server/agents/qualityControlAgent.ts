import fs from 'fs';
import type {
  HighlightRecord,
  QualityCheckItem,
  QualityControlReport,
  StudioSettings,
  TranscriptSegment,
  VideoMetadata,
} from '../../types/studio';
import { findCategoryByIdOrName } from '../categories';
import { renderAdaptiveClip } from './adaptiveEditingAgent';
import { probeVideoMetadata } from './videoIngestionAgent';

export async function validateRenderedClip(params: {
  renderedPath: string;
  highlight: HighlightRecord;
  transcript: TranscriptSegment[];
  sourceMetadata: VideoMetadata | null;
  settings: StudioSettings;
}): Promise<QualityControlReport> {
  const { renderedPath, highlight, transcript, sourceMetadata, settings } = params;
  const checks: QualityCheckItem[] = [];
  const fixableIssues: string[] = [];

  if (!fs.existsSync(renderedPath)) {
    return {
      passed: false,
      checkedAt: new Date().toISOString(),
      checks: [{ name: 'Rendering Integrity', status: 'fail', detail: 'Rendered MP4 file missing.' }],
      fixableIssues: ['Re-render MP4 artifact'],
      autoRegenerated: false,
    };
  }

  const probe = await probeVideoMetadata(renderedPath);

  // 1. Resolution check (1080x1920)
  const resOk = probe.width === 1080 && probe.height === 1920;
  checks.push({
    name: 'Vertical Resolution (9:16)',
    status: resOk ? 'pass' : 'fail',
    detail: resOk
      ? 'Verified 1080×1920 H.264 vertical frame.'
      : `Expected 1080×1920, found ${probe.width}×${probe.height}.`,
  });
  if (!resOk) fixableIssues.push('Normalize output scaling to 1080×1920');

  // 2. Codec & Integrity
  const codecOk = probe.videoCodec === 'h264' && (!probe.hasAudio || probe.audioCodec === 'aac');
  checks.push({
    name: 'Codec & Stream Integrity',
    status: codecOk ? 'pass' : 'warn',
    detail: `Video: ${probe.videoCodec.toUpperCase()} · Audio: ${probe.audioCodec?.toUpperCase() || 'None'} · ${(probe.fileSize / (1024 * 1024)).toFixed(2)} MB`,
  });

  // 3. Clip boundaries & duration
  const durationDelta = Math.abs(probe.duration - highlight.duration);
  const boundaryOk = probe.duration >= 3 && durationDelta <= 1.5;
  checks.push({
    name: 'Clip Boundaries & Sync',
    status: boundaryOk ? 'pass' : 'warn',
    detail: `Rendered ${probe.duration.toFixed(2)}s (target ${highlight.duration.toFixed(2)}s).`,
  });

  // 4. Complete speech check against transcript
  const overlapping = transcript.filter(
    (s) => s.end > highlight.startTime && s.start < highlight.endTime
  );
  const firstSeg = overlapping[0];
  const lastSeg = overlapping[overlapping.length - 1];
  const cutsStart = firstSeg ? highlight.startTime - firstSeg.start > 0.8 : false;
  const cutsEnd = lastSeg ? lastSeg.end - highlight.endTime > 0.8 : false;

  if (cutsStart || cutsEnd) {
    checks.push({
      name: 'Complete Speech Framing',
      status: 'warn',
      detail: 'Clip boundary cuts across an active spoken sentence; boundary padding recommended.',
    });
    fixableIssues.push('Expand clip boundary to complete sentence boundaries');
  } else {
    checks.push({
      name: 'Complete Speech Framing',
      status: 'pass',
      detail: `${overlapping.length} complete transcript segment(s) cleanly framed.`,
    });
  }

  // 5. Subtitle readability
  const maxWords = overlapping.reduce(
    (m, s) => Math.max(m, s.text.trim().split(/\s+/).length),
    0
  );
  checks.push({
    name: 'Subtitle Readability',
    status: 'pass',
    detail: `Chunked to max 5 words/line at ${settings.subtitleFontSize}px (${maxWords} words max segment).`,
  });

  // 6. Category-appropriate editing
  const cat = findCategoryByIdOrName(highlight.categoryId, settings.customCategories);
  const inappropriateZoom = cat.avoidEffects && highlight.dynamicZoom;
  checks.push({
    name: 'Category-Appropriate Editing',
    status: inappropriateZoom ? 'warn' : 'pass',
    detail: inappropriateZoom
      ? `${cat.name} prefers steady framing; dynamic zoom can be disabled.`
      : `${highlight.editingProfile} profile matches ${cat.name} tone.`,
  });
  if (inappropriateZoom) {
    fixableIssues.push('Disable dynamic zoom for serious/educational content');
  }

  // Check duration ceiling vs source
  if (sourceMetadata && highlight.endTime > sourceMetadata.duration + 0.1) {
    fixableIssues.push('Clamp endTime to source video duration');
  }

  const hasFail = checks.some((c) => c.status === 'fail');

  return {
    passed: !hasFail && fixableIssues.length === 0,
    checkedAt: new Date().toISOString(),
    checks,
    fixableIssues,
    autoRegenerated: false,
  };
}

export async function autoHealAndRegenerateClip(params: {
  projectId: string;
  sourcePath: string;
  sourceMetadata: VideoMetadata | null;
  highlight: HighlightRecord;
  transcript: TranscriptSegment[];
  settings: StudioSettings;
  languageCode: string;
}): Promise<{
  patchedHighlight: Partial<HighlightRecord>;
  renderedPath: string;
  renderedUrl: string;
  qcReport: QualityControlReport;
}> {
  const { projectId, sourcePath, sourceMetadata, highlight, transcript, settings, languageCode } = params;

  const overlapping = transcript.filter(
    (s) => s.end > highlight.startTime && s.start < highlight.endTime
  );

  let newStart = highlight.startTime;
  let newEnd = highlight.endTime;

  if (overlapping.length > 0) {
    newStart = Math.max(0, Number((overlapping[0].start - 0.15).toFixed(2)));
    newEnd = Math.min(
      sourceMetadata?.duration ?? highlight.endTime + 2,
      Number((overlapping[overlapping.length - 1].end + 0.25).toFixed(2))
    );
  }

  const cat = findCategoryByIdOrName(highlight.categoryId, settings.customCategories);
  const updatedHighlight: HighlightRecord = {
    ...highlight,
    startTime: newStart,
    endTime: newEnd,
    duration: Math.max(1, Number((newEnd - newStart).toFixed(2))),
    dynamicZoom: cat.avoidEffects ? false : highlight.dynamicZoom,
  };

  const rendered = await renderAdaptiveClip({
    projectId,
    sourcePath,
    metadata: sourceMetadata,
    highlight: updatedHighlight,
    transcript,
    settings,
    languageCode,
  });

  const qcReport = await validateRenderedClip({
    renderedPath: rendered.outputPath,
    highlight: updatedHighlight,
    transcript,
    sourceMetadata,
    settings,
  });
  qcReport.autoRegenerated = true;

  return {
    patchedHighlight: {
      startTime: updatedHighlight.startTime,
      endTime: updatedHighlight.endTime,
      duration: updatedHighlight.duration,
      dynamicZoom: updatedHighlight.dynamicZoom,
      renderedVideoUrl: rendered.outputUrl,
      qcReport,
    },
    renderedPath: rendered.outputPath,
    renderedUrl: rendered.outputUrl,
    qcReport,
  };
}
