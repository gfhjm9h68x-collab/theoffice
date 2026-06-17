import js from "@eslint/js";
import tseslint from "typescript-eslint";

// Stock recommended config for the TypeScript engine sources. Not gated in CI yet (kept advisory so a
// large pre-existing surface doesn't block builds); run locally with `npm run lint`.
export default tseslint.config(
  { ignores: ["dist/", "node_modules/", "web-ui/", "coverage/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { rules: { "@typescript-eslint/no-explicit-any": "warn" } },
);
