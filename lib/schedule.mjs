/**
 * When the update job is supposed to run, and what counts as stale.
 *
 * The cadence is not uniform, because the day is not uniform. Games tip off in
 * the European evening and their results land in the league calendars the same
 * night, so the hours that matter are 16:00 through the small hours. Nothing
 * happens between breakfast and mid-afternoon, and a run then re-reads pages
 * that have not changed since the one before it.
 *
 * Times below are Israel local (UTC+3 through the preseason window; the season
 * ends before the October switch to UTC+2, so the offset is constant here).
 *
 *   03:00  the quiet slot — also the daily archive crawl and browser render
 *   07:00  overnight results, in place before the morning
 *   16:00  first of the evening; the day's fixtures are up by now
 *   19:00  early tip-offs are under way
 *   22:00  most games are final
 *   00:00  the rest are final
 *
 * Freshness cannot be a flat number of hours against this. The gap from 07:00
 * to 16:00 is nine hours by design, and a flat five-hour alarm would fire
 * through the middle of every single day. So staleness is measured against the
 * schedule itself: find the most recent slot whose run has had time to finish,
 * and ask whether the published data is at least that new. A missed 16:00 run
 * is reported by 17:30 rather than swallowed until 03:00.
 */

// The cron minute. Seventeen past, not on the hour: GitHub's shared scheduler
// is busiest at :00 and delays runs queued there the most.
export const MINUTE = 17;

// The hours the job fires, in UTC, ascending. These must match the cron entries
// in .github/workflows/update.yml exactly.
export const SLOTS_UTC = [0, 4, 13, 16, 19, 21];

// How long after a slot before its absence counts as a failure.
//
// GitHub's shared scheduler does not start these runs on time and never has:
// measured over the last four days of history the delay ran 24 to 102 minutes,
// median 43, with midnight UTC by far the worst because every repo on the
// platform asks for it. A run then takes up to its 45-minute ceiling. Three
// hours covers the observed worst case with room to spare — and an alarm that
// cries wolf once gets muted, after which it may as well not exist.
export const GRACE_HOURS = 3;

/**
 * The most recent scheduled run that should already have published, or null
 * when none has yet had the time.
 */
export function lastDueSlot(now = Date.now()) {
  const t = new Date(now);
  // Walk back over two days of slots so the first hours of a new UTC day still
  // see yesterday's 21:17.
  for (let day = 0; day <= 1; day++) {
    for (const hour of [...SLOTS_UTC].reverse()) {
      const slot = Date.UTC(
        t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() - day, hour, MINUTE);
      if (slot + GRACE_HOURS * 36e5 <= now) return slot;
    }
  }
  return null;
}

/**
 * Is `updated` (an ISO timestamp) older than the last run that owed us data?
 * Returns { stale, hours, due } — `due` is null when nothing is owed yet.
 */
export function freshness(updated, now = Date.now()) {
  const at = Date.parse(updated);
  const hours = (now - at) / 36e5;
  const due = lastDueSlot(now);
  return { stale: due !== null && at < due, hours, due: due && new Date(due).toISOString() };
}
