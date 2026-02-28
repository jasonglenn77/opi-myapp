/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{html,js}", "./*.html", "./*.js"],
  safelist: [
    "min-w-[160px]",
    "min-w-[980px]",
    "whitespace-nowrap",

    // KPI color classes (because we build them dynamically)
    "bg-kpi-attention-bg",
    "border-kpi-attention-bd",
    "text-kpi-attention-text",
    "text-kpi-attention-num",

    "bg-kpi-notStarted-bg",
    "border-kpi-notStarted-bd",
    "text-kpi-notStarted-text",
    "text-kpi-notStarted-num",

    "bg-kpi-inProgress-bg",
    "border-kpi-inProgress-bd",
    "text-kpi-inProgress-text",
    "text-kpi-inProgress-num",

    "bg-kpi-completed-bg",
    "border-kpi-completed-bd",
    "text-kpi-completed-text",
    "text-kpi-completed-num",

    "bg-kpi-total-bg",
    "border-kpi-total-bd",
    "text-kpi-total-text",
    "text-kpi-total-num",

    "bg-kpi-showing-bg",
    "border-kpi-showing-bd",
    "text-kpi-showing-text",
    "text-kpi-showing-num",
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          50:  "#f4f7f5",
          100: "#e0ebe4",
          200: "#c1d6c8",
          300: "#97bca3",
          400: "#6fa07f",
          500: "#4f7f61", // forest green
          600: "#3e654e",
          700: "#325241",
          800: "#2a4236",
          900: "#22362d",
        },
        ink: {
          900: "#0b0f14",
          800: "#111827",
          700: "#1f2937",
        },

        // NEW: subtle, polished KPI palette
        kpi: {
          attention: {
            bg: "#fff1f2",               // soft rose tint
            bd: "rgba(244,63,94,.18)",   // subtle rose border
            text: "#9f1239",             // label
            num: "#881337",              // number
          },
          notStarted: {
            bg: "#f8fafc",               // slate tint
            bd: "rgba(15,23,42,.10)",
            text: "#475569",
            num: "#0f172a",
          },
          inProgress: {
            bg: "#eff6ff",               // blue tint
            bd: "rgba(59,130,246,.18)",
            text: "#1d4ed8",
            num: "#1e3a8a",
          },
          completed: {
            bg: "#f4f7f5",               // your brand.50
            bd: "rgba(79,127,97,.20)",   // derived from brand.500
            text: "#3e654e",             // brand.600
            num: "#325241",              // brand.700
          },
          total: {
            bg: "rgba(17,24,39,.04)",
            bd: "rgba(17,24,39,.10)",
            text: "rgba(17,24,39,.65)",
            num: "#111827",              // ink.800
          },
          showing: {
            bg: "#f5f3ff",               // violet tint
            bd: "rgba(139,92,246,.18)",
            text: "#6d28d9",
            num: "#4c1d95",
          },
        },
      },
      boxShadow: {
        soft: "0 10px 30px rgba(0,0,0,.12)",
      },
    },
  },
  plugins: [],
};
