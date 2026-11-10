export class Html {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escape(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

function render(value: unknown): string {
  if (value === null || value === undefined || value === false) return '';
  if (value instanceof Html) return value.value;
  if (Array.isArray(value)) return value.map(render).join('');
  return escape(value);
}

/** Tagged template that escapes every interpolation unless it is already Html. */
export function html(strings: TemplateStringsArray, ...values: unknown[]): Html {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1];
  return new Html(out);
}

export const raw = (s: string) => new Html(s);

export function timeAgo(date: Date | string | null): string {
  if (!date) return '';
  const seconds = Math.round((Date.now() - new Date(date).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const units: [number, string][] = [
    [60, 'minute'],
    [3600, 'hour'],
    [86400, 'day'],
    [2592000, 'month'],
    [31536000, 'year'],
  ];
  let label = '';
  for (let i = units.length - 1; i >= 0; i--) {
    const [size, name] = units[i];
    if (seconds >= size) {
      const n = Math.floor(seconds / size);
      label = `${n} ${name}${n === 1 ? '' : 's'} ago`;
      break;
    }
  }
  return label;
}

export const CSS = `
:root { --ink:#16181d; --muted:#5f6672; --line:#e3e6eb; --bg:#f7f8fa; --card:#fff; --accent:#4f46e5; --danger:#b42318;
  --t1:#6d28d9; --t1bg:#f1e9ff; --t2:#047857; --t2bg:#e3f7ee; --t3:#1d4ed8; --t3bg:#e5edff; --t4:#92400e; --t4bg:#fdf1dc; }
* { box-sizing: border-box; }
body { margin:0; font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif; color:var(--ink); background:var(--bg); }
a { color: var(--accent); text-decoration: none; } a:hover { text-decoration: underline; }
header.top { background:#111318; color:#fff; }
header.top .bar { max-width:1180px; margin:0 auto; display:flex; align-items:center; gap:20px; padding:10px 20px; }
header.top a { color:#d6d9e0; } header.top a.brand { color:#fff; font-weight:700; letter-spacing:.2px; }
header.top nav { display:flex; gap:16px; flex:1; } header.top .who { color:#9aa0ab; font-size:13px; }
header.top form.inline button { background:none; border:0; color:#9aa0ab; cursor:pointer; padding:0; font:inherit; font-size:13px; }
main { max-width:1180px; margin:0 auto; padding:24px 20px 60px; }
h1 { font-size:24px; margin:0 0 4px; } h2 { font-size:17px; margin:0 0 12px; } h3 { font-size:14px; margin:16px 0 8px; color:var(--muted); text-transform:uppercase; letter-spacing:.5px; }
.card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:18px; margin-bottom:16px; }
.grid { display:grid; grid-template-columns: 2fr 1fr; gap:16px; } @media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }
.muted { color:var(--muted); } .small { font-size:13px; }
.badge { display:inline-block; font-size:12px; font-weight:600; padding:1px 8px; border-radius:999px; background:#eef0f3; color:#333; white-space:nowrap; }
.tier-1 { background:var(--t1bg); color:var(--t1); } .tier-2 { background:var(--t2bg); color:var(--t2); }
.tier-3 { background:var(--t3bg); color:var(--t3); } .tier-4 { background:var(--t4bg); color:var(--t4); }
.agent { background:#fff4e5; color:#9a4a00; } .status-open { background:#fff7d6; color:#7a5d00; } .status-approved { background:var(--t2bg); color:var(--t2); }
.status-rejected { background:#fde8e8; color:var(--danger); } .status-withdrawn { background:#eee; color:#666; }
table { width:100%; border-collapse:collapse; } th, td { text-align:left; padding:8px 6px; border-bottom:1px solid var(--line); vertical-align:top; }
th { font-size:12px; color:var(--muted); text-transform:uppercase; letter-spacing:.4px; font-weight:600; }
input[type=text], input[type=email], input[type=url], input[type=password], input[type=search], select, textarea {
  width:100%; padding:8px 10px; border:1px solid #cfd4dc; border-radius:7px; font:inherit; background:#fff; }
textarea { min-height:90px; } label { display:block; font-size:13px; font-weight:600; margin:10px 0 4px; }
button, .button { display:inline-block; background:var(--accent); color:#fff; border:0; border-radius:7px; padding:8px 14px; font:inherit; font-weight:600; cursor:pointer; }
button.secondary, .button.secondary { background:#eef0f4; color:var(--ink); } button.danger { background:var(--danger); }
button.link { background:none; color:var(--accent); padding:0; font-weight:500; }
.row { display:flex; gap:10px; align-items:end; flex-wrap:wrap; } .row > * { flex:1; min-width:140px; } .row > .shrink { flex:0 0 auto; }
.fact { padding:10px 0; border-bottom:1px solid var(--line); } .fact:last-child { border-bottom:0; }
.fact .meta { font-size:12px; color:var(--muted); margin-top:4px; display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
.fact .meta form { display:inline; }
.fact .meta .inline-form { display:inline-flex; gap:6px; align-items:center; }
.inline-form select { width:auto; padding:1px 6px; font-size:12px; border-radius:5px; }
.flash { padding:10px 14px; border-radius:8px; margin-bottom:16px; background:#eef6ff; border:1px solid #cfe2ff; }
.flash.error { background:#fdeeee; border-color:#f5c2c2; }
pre, code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size:13px; } pre { background:#0f1115; color:#e7e9ee; padding:12px; border-radius:8px; overflow:auto; }
.kv { display:grid; grid-template-columns: 140px 1fr; gap:4px 12px; font-size:14px; } .kv dt { color:var(--muted); }
#graph { height:340px; border:1px solid var(--line); border-radius:8px; background:#fcfcfd; }
.diff-old { background:#fde8e8; text-decoration: line-through; padding:0 3px; } .diff-new { background:#e3f7ee; padding:0 3px; }
details summary { cursor:pointer; color:var(--accent); font-weight:600; margin:8px 0; }
.tiers { display:grid; grid-template-columns: repeat(4, 1fr); gap:12px; } @media (max-width: 900px) { .tiers { grid-template-columns: 1fr 1fr; } }
.tiers .card { margin:0; }
.empty { color:var(--muted); font-style: italic; }
`;
