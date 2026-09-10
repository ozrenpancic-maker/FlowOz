/**
 * The domain, video, storage and report layers carry no native dependencies, so
 * the suite runs them as plain TypeScript on Node — fast, and independent of a
 * device or an emulator. Physical Android behaviour is covered separately by
 * the field checklist in tests/field-checklist.
 */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/**/*.test.ts'],
  setupFiles: ['<rootDir>/tests/setup.ts'],
  transform: {
    '^.+\\.(t|j)sx?$': [
      'babel-jest',
      {
        presets: [
          ['@babel/preset-env', { targets: { node: 'current' } }],
          '@babel/preset-typescript',
        ],
        babelrc: false,
        configFile: false,
      },
    ],
  },
  collectCoverageFrom: ['domain/**/*.ts', 'video/**/*.ts', 'reports/**/*.ts', 'storage/**/*.ts'],
};
