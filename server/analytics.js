export const validDay = day => typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(Date.parse(day)) && new Date(day).toISOString().slice(0, 10) === day;
export const shiftDay = (day, by) => new Date(Date.parse(day) + by * 86400000).toISOString().slice(0, 10);
function summarize(clips) {
  const statuses = { pending: 0, approved: 0, changes: 0, posted: 0 };
  for (const c of clips) statuses[c.status]++;
  return { clips: clips.length, bytes: clips.reduce((n, c) => n + c.size, 0), contributors: new Set(clips.map(c => c.user_id)).size, activeDays: new Set(clips.map(c => c.day)).size, ...statuses };
}
export function analytics(clips, members, from, to) {
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
  const previousFrom = shiftDay(from, -days), previousTo = shiftDay(from, -1);
  const current = clips.filter(c => c.day >= from && c.day <= to);
  const previous = clips.filter(c => c.day >= previousFrom && c.day <= previousTo);
  const daily = Array.from({ length: days }, (_, i) => { const day = shiftDay(from, i); return { day, ...summarize(current.filter(c => c.day === day)) }; });
  const totals = summarize(current);
  return {
    from, to, basis: 'assigned_clip_date', totals, allTime: summarize(clips),
    previous: { from: previousFrom, to: previousTo, ...summarize(previous) },
    averagePerDay: totals.clips / days,
    approvalRate: totals.clips ? (totals.approved + totals.posted) / totals.clips * 100 : null,
    daily,
    members: members.map(m => { const own = current.filter(c => c.user_id === m.id); return { id: m.id, name: m.name, role: m.role, active: Boolean(m.active), ...summarize(own), latestUpload: own.length ? own.map(c => c.created_at).sort().at(-1) : null }; }).sort((a, b) => b.clips - a.clips || a.name.localeCompare(b.name)),
  };
}
