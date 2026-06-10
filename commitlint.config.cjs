// Why: enforces Conventional Commits per docs/04-Implementation/4.2 §3.2.
// Project-specific scopes prevent commit messages from drifting over time.

/** @type {import('@commitlint/types').UserConfig} */
module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      [
        'feat',
        'fix',
        'refactor',
        'test',
        'docs',
        'chore',
        'perf',
        'style',
        'build',
        'ci',
        'revert',
      ],
    ],
    'scope-enum': [
      2,
      'always',
      [
        'backend',
        'desktop-main',
        'desktop-renderer',
        'shared',
        'db',
        'auth',
        'license',
        'extract',
        'parser',
        'pdf',
        'ipc',
        'ci',
        'docs',
        'deps',
        'release',
      ],
    ],
    'subject-min-length': [2, 'always', 10],
    'subject-max-length': [2, 'always', 100],
    'subject-case': [2, 'never', ['upper-case']],
    'body-max-line-length': [1, 'always', 200],
  },
};
