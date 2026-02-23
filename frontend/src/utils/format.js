export function fmtMoney(n) {
  const v = Number(n || 0);
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(v);
}

export function fmtPct(n) {
  if (n === null || typeof n === "undefined") return "—";
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(1)}%`;
}

export function fmtDate(s) {
  if (!s) return "";

  const str = String(s).trim();
  let d;

  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(str)) d = new Date(str.replace(" ", "T") + "Z");
  else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(str)) d = new Date(str + "Z");
  else d = new Date(str);

  if (Number.isNaN(d.getTime())) return str;

  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Denver",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(d);
}