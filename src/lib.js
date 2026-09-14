export const localDay = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
export const dateOf = day => new Date(`${day}T12:00:00`);
export const shiftDay = (day, amount) => { const d = dateOf(day); d.setDate(d.getDate() + amount); return localDay(d); };
export const formatDate = (day, options = { month: 'short', day: 'numeric' }) => dateOf(day).toLocaleDateString('en-US', options);
export const bytes = n => !n ? '0 MB' : n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
export const roleLabels = { owner: 'Owner', team: 'Team', clipper: 'Clipper' };
export const statusLabels = { pending: 'To review', approved: 'Approved', changes: 'Changes needed', posted: 'Posted', not_posting: 'Not posting' };
export async function api(url, options = {}) {
  const res = await fetch(`/api${url}`, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  const data = await res.json();
  if (!res.ok) { const error = new Error(data.error || 'Something went wrong. Try again.'); error.status = res.status; throw error; }
  return data;
}
export function downloadCSV(filename, rows) {
  const cell = value => { let s = String(value ?? ''); if (/^[\s]*[=+@-]/.test(s)) s = `'${s}`; return `"${s.replaceAll('"', '""')}"`; };
  const url = URL.createObjectURL(new Blob(['\uFEFF', rows.map(row => row.map(cell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const postingLabels = { personal: 'Ima post', clip_page: 'Post on Orangie clip page' };
