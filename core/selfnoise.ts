/**
 * Self-noise gate.
 *
 * Live evidence: while developing this plugin, every failed Edit/Read of its
 * own files became an antibody about the plugin's own source tree — rules no
 * future session can use, occupying the injection budget of every session
 * start.
 *
 * The principle generalises: an agent tool should not learn "pitfalls" from
 * operating on itself. If the failure trace references the plugin's own install
 * or storage paths, the episode is bookkeeping, not a lesson.
 */

/**
 * True when `trace` references one of `markers` (the host's own paths).
 * Case-insensitive, because Windows paths arrive in mixed casing.
 */
export function isSelfEpisode(trace: string, markers: string[]): boolean {
  const lower = trace.toLowerCase();
  return markers.some((m) => {
    const marker = m.trim().toLowerCase();
    return marker.length > 0 && lower.includes(marker);
  });
}
