import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Warm charcoal ("potato skin" dark) ramp, replacing Tailwind's cool
        // neutral so the whole UI reads warm without touching each component.
        neutral: {
          50: "#faf6ee",
          100: "#f1e9d8",
          200: "#ded4bd",
          300: "#c0b499",
          400: "#9a8e75",
          500: "#7b7058",
          600: "#5b5140",
          700: "#3c3426",
          800: "#2a2318",
          900: "#191309",
          950: "#100c06",
        },
        // Golden-tan accent (muted, not neon yellow).
        amber: {
          300: "#e7d1a0",
          400: "#dcbd7c",
          500: "#c9a25c",
          600: "#ac8340",
        },
        // Muted forest/sage green.
        green: {
          400: "#8fb488",
          500: "#6d9c64",
          600: "#4f7a4a",
        },
        // Muted terracotta for sells/danger.
        red: {
          400: "#d38b72",
          500: "#b6644a",
        },
      },
      fontFamily: {
        sans: [
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Roboto",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ],
        mono: [
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Monaco",
          "Consolas",
          "Liberation Mono",
          "Courier New",
          "monospace",
        ],
      },
    },
  },
  plugins: [],
};

export default config;
