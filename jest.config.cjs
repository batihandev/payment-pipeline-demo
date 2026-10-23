module.exports = {
  testEnvironment: 'node',
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  roots: ['<rootDir>/apps', '<rootDir>/libs'],
  testMatch: ['**/*.spec.ts'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.spec.json' }] },
  collectCoverageFrom: [
    'apps/**/*.ts',
    'libs/**/*.ts',
    '!**/*.spec.ts',
    '!libs/db/generated/**',
    '!**/testing/**',
  ],
};
