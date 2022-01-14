module.exports = {
    root: true,
    plugins: [
        "@typescript-eslint"
    ],

    parserOptions: {
        parser: "@typescript-eslint/parser",
        project: "./tsconfig.json",
        sourceType: "module",
        ecmaVersion: 2020
    },

    extends: [
        "eslint:recommended",
        "plugin:@typescript-eslint/recommended-requiring-type-checking"
    ],

    env: {
        node: true
    },

    rules: {
        "indent": ["error", 4],
        "quotes": [2, "double", { "avoidEscape": true }],
        "space-before-function-paren": [2, "never"],
        "comma-dangle": ["error", "never"],
        "semi": ["error", "always"],
        "@typescript-eslint/no-unsafe-member-access": 0,
        "@typescript-eslint/no-unsafe-assignment": 0,
        "@typescript-eslint/restrict-template-expressions": 0,
        "@typescript-eslint/explicit-module-boundary-types": 0,
        "eol-last": ["error", "always"],
        "no-multiple-empty-lines": ["error", {"max": 1, "maxEOF": 1}],
        "no-unused-vars": 0,
        "@typescript-eslint/no-unsafe-call": 0,
        "@typescript-eslint/no-unsafe-return": 0,
        "@typescript-eslint/no-misused-promises": 0,
        "@typescript-eslint/prefer-regexp-exec": 0
    }
};
