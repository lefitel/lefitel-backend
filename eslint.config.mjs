import js from "@eslint/js";
import globals from "globals";
import pluginTs from "@typescript-eslint/eslint-plugin";
import parserTs from "@typescript-eslint/parser";

export default [
    {
        files: ["**/*.ts"],
        ignores: ["dist/**"],
        languageOptions: {
            globals: globals.node,
            parser: parserTs,
            parserOptions: {
                project: "./tsconfig.json",
                ecmaVersion: "latest",
                sourceType: "module",
            },
        },
        plugins: {
            "@typescript-eslint": pluginTs,
        },
        rules: {
            ...js.configs.recommended.rules,
            ...pluginTs.configs.recommended.rules,
            "no-undef": "off",
            "no-unused-vars": "off",
            "@typescript-eslint/no-unused-vars": [
                "error",
                { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
            ],
            "@typescript-eslint/no-explicit-any": "error",
        },
    },
];
