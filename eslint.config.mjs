import tsParser from "@typescript-eslint/parser";

const padding = [
  "error",
  {
    blankLine: "always",
    prev: "*",
    next: [
      "multiline-const",
      "multiline-let",
      "multiline-var",
      "block-like",
      "if",
      "try",
    ],
  },
  {
    blankLine: "always",
    prev: [
      "multiline-const",
      "multiline-let",
      "multiline-var",
      "block-like",
      "if",
      "try",
    ],
    next: "*",
  },
];

export default [
  {
    files: ["src/**/*.ts", "test/**/*.ts"],
    languageOptions: { parser: tsParser },
    rules: { "padding-line-between-statements": padding },
  },
  {
    files: ["scripts/**/*.mjs", "trackers/**/*.mjs"],
    rules: { "padding-line-between-statements": padding },
  },
];
