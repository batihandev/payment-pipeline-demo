module.exports = {
  testEnvironment: 'node',
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^@app/([^/]+)$': '<rootDir>/libs/$1/src',
    '^@app/([^/]+)/(.+)$': '<rootDir>/libs/$1/src/$2',
    '^@testing/([^/]+)/(.+)$': '<rootDir>/libs/$1/testing/$2',
  },
  roots: ['<rootDir>/apps', '<rootDir>/libs'],
  testMatch: ['**/*.spec.ts'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  collectCoverageFrom: [
    'apps/**/*.ts',
    'libs/**/*.ts',
    '!**/*.spec.ts',
    '!libs/db/generated/**',
    '!**/testing/**',
  ],
};
