import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import jsxA11y from "eslint-plugin-jsx-a11y";

const { plugins: _jsxA11yPlugins, ...jsxA11yStrict } = jsxA11y.flatConfigs.strict;

const next15HooksRules = {
  "react-hooks/rules-of-hooks": "error",
  "react-hooks/exhaustive-deps": "warn",
  "react-hooks/static-components": "off",
  "react-hooks/use-memo": "off",
  "react-hooks/preserve-manual-memoization": "off",
  "react-hooks/incompatible-library": "off",
  "react-hooks/immutability": "off",
  "react-hooks/globals": "off",
  "react-hooks/refs": "off",
  "react-hooks/set-state-in-effect": "off",
  "react-hooks/error-boundaries": "off",
  "react-hooks/purity": "off",
  "react-hooks/set-state-in-render": "off",
  "react-hooks/unsupported-syntax": "off",
  "react-hooks/config": "off",
  "react-hooks/gating": "off",
};

const config = [
  {
    ignores: [".next/**", "out/**", "node_modules/**"],
  },
  {
    linterOptions: {
      reportUnusedDisableDirectives: "off",
    },
  },
  ...nextCoreWebVitals,
  {
    rules: next15HooksRules,
  },
  jsxA11yStrict,
];

export default config;
