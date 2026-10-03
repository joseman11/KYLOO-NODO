/** Conventional Commits en español: los tipos son los de la skill kyle-from-kyloo (sección 11.2); no se inventan otros. */
module.exports = {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "type-enum": [
      2,
      "always",
      ["feat", "fix", "docs", "style", "refactor", "perf", "test", "chore", "ci", "infra", "revert"],
    ],
    "subject-max-length": [2, "always", 100],
    // Los asuntos van en español y empiezan con minúscula, pero admiten nombres propios y siglas
    "subject-case": [0],
  },
};
