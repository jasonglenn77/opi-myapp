import { api } from "../api.js";

let cache = null;

export async function loadTeams() {
  if (cache) return cache;

  const [pms, crews] = await Promise.all([
    api("/project-managers"),
    api("/work-crews"),
  ]);

  const pmByName = new Map();
  pms.forEach(pm => {
    const name = `${pm.first_name || ""} ${pm.last_name || ""}`.trim();
    if (name) pmByName.set(name.toLowerCase(), pm.color || null);
  });

  const crewByName = new Map();
  crews.forEach(c => {
    if (c.name) crewByName.set(c.name.toLowerCase(), c.color || null);
  });

  cache = { pms, crews, pmByName, crewByName };
  return cache;
}

export function bestTextColor(bg) {
  if (!bg || !bg.startsWith("#") || bg.length !== 7) return "#111827";
  const r = parseInt(bg.slice(1,3), 16);
  const g = parseInt(bg.slice(3,5), 16);
  const b = parseInt(bg.slice(5,7), 16);
  const lum = (0.299*r + 0.587*g + 0.114*b) / 255;
  return lum > 0.6 ? "#111827" : "#ffffff";
}

export function pill(label, color) {
  if (!label) label = "—";
  if (!color) {
    return `<span class="inline-flex rounded-full px-2 py-0.5 text-xs font-semibold bg-black/5 text-ink-900">${label}</span>`;
  }

  const text = bestTextColor(color);

  // NEW: soften background slightly (looks more “SaaS”)
  // Uses a faint overlay behind the chosen color.
  return `
    <span
      class="inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-black/10"
      style="background: color-mix(in srgb, ${color} 18%, white); color:${text}"
      title="${color}"
    >${label}</span>
  `;
}