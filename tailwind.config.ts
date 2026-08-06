import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        paper: "#EDEAE2",
        ink: "#1F2937",
        blueprint: "#2C5F8A",
        blueprintDark: "#1B3A5C",
        gridline: "#C9C2B3",
        available: "#4F7942",
        booked: "#B0413E",
        selected: "#C9982B",
      },
      fontFamily: {
        mono: ["var(--font-plex-mono)", "monospace"],
        sans: ["var(--font-inter)", "sans-serif"],
      },
      backgroundImage: {
        graphpaper:
          "linear-gradient(#C9C2B3 1px, transparent 1px), linear-gradient(90deg, #C9C2B3 1px, transparent 1px)",
      },
      backgroundSize: {
        graphpaper: "24px 24px",
      },
    },
  },
  plugins: [],
};
export default config;
