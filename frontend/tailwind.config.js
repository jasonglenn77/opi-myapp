/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{html,js}", "./*.html", "./*.js"],
  safelist: [
    "min-w-[160px]",
    "min-w-[980px]",
    "whitespace-nowrap",
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
      },
      boxShadow: {
        soft: "0 10px 30px rgba(0,0,0,.12)",
      },
    },
  },
  plugins: [],
};
