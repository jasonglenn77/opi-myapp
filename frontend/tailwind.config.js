/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{html,js}", "./*.html", "./*.js"],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#fff7ed",
          100: "#ffedd5",
          200: "#fed7aa",
          300: "#fdba74",
          400: "#fb923c",
          500: "#f97316", // primary accent (orange)
          600: "#ea580c",
          700: "#c2410c",
          800: "#9a3412",
          900: "#7c2d12",
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
