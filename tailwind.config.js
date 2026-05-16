/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./app/**/*.{js,jsx,ts,tsx}",
    "./components/**/*.{js,jsx,ts,tsx}",
  ],
  presets: [require("nativewind/preset")],
  theme: {
    extend: {
      colors: {
        primary: "#6366F1",
        "primary-dark": "#4F46E5",
        coral: "#FF6B6B",
        teal: "#4ECDC4",
        purple: "#A855F7",
        orange: "#F97316",
        blue: "#3B82F6",
        green: "#22C55E",
        pink: "#EC4899",
        yellow: "#EAB308",
        "bg-dark": "#0F0F0F",
        "bg-light": "#F8F8F8",
        "card-dark": "#1A1A1A",
        "card-light": "#FFFFFF",
        "card-border": "#2A2A2A",
        success: "#22C55E",
        warning: "#F59E0B",
        error: "#EF4444",
      },
      fontFamily: {
        sans: ["System"],
      },
    },
  },
  plugins: [],
};
