import eslint from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      ".claude/**",
      "**/dist/**",
      "**/node_modules/**",
      "**/out/**",
      "**/coverage/**",
      "**/.astro/**",
      "convex/_generated/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-misused-promises": ["error", {
        checksVoidReturn: { attributes: false },
      }],
    },
  },
  {
    files: ["**/*.{js,mjs}"],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ["**/*.{js,mjs,ts,tsx}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
    },
    rules: {
      eqeqeq: ["error", "always"],
      "no-warning-comments": ["warn", { terms: ["fixme"], location: "start" }],
      "@typescript-eslint/no-base-to-string": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/only-throw-error": "off",
      "@typescript-eslint/require-await": "off",
    },
  },
  {
    files: ["**/*.test.ts", "**/*.test.tsx"],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["scripts/**/*.{js,mjs}", "apps/docs/*.mjs", "apps/desktop/src/{main,preload}/**/*.ts", "apps/server/{src,scripts}/**/*.{ts,mjs}"],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["apps/desktop/src/preload/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        paths: ["pg", "@leaflogue/remote", "@leaflogue/storage"],
        patterns: ["node:*"],
      }],
    },
  },
  {
    files: ["apps/desktop/src/main/index.ts"],
    rules: {
      "no-restricted-syntax": ["error", {
        selector: "CallExpression[callee.object.name='ipcMain'][callee.property.name='handle']",
        message: "Register IPC through registerTrustedHandler so sender validation cannot be skipped.",
      }],
    },
  },
  {
    files: ["apps/desktop/src/renderer/**/*.{ts,tsx}", "apps/web/src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    languageOptions: { globals: globals.browser },
    rules: {
      ...reactHooks.configs.flat.recommended.rules,
      "react-hooks/set-state-in-effect": "off",
      "no-restricted-imports": ["error", {
        paths: ["electron", "pg", "@leaflogue/remote", "@leaflogue/storage"],
        patterns: ["node:*"],
      }],
    },
  },
  {
    files: ["packages/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", {
        paths: ["electron", "next"],
      }],
    },
  },
  {
    files: ["apps/desktop/src/renderer/**/*.{ts,tsx}", "apps/web/src/**/*.{ts,tsx}", "apps/docs/src/components/**/*.tsx", "packages/ui/src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": ["error",
        { selector: 'JSXOpeningElement[name.name=/^(select|datalist)$/]', message: "Use the shared Select, ComboBox, or MultiSelect from @leaflogue/ui." },
        { selector: 'JSXOpeningElement[name.name="input"] JSXAttribute[name.name="type"][value.value=/^(date|time|datetime-local|month|week|color)$/]', message: "Use a shared custom picker instead of an operating-system popup." },
      ],
    },
  },

);
