module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/infrastructure/test'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': 'ts-jest'
  },
  coverageReporters: [
    'text',
    'lcov'
  ],
  collectCoverageFrom: [
    'infrastructure/lib/**/*.ts',
    '!infrastructure/lib/**/*.d.ts',
  ],
  setupFilesAfterEnv: ['<rootDir>/infrastructure/test/setup.ts']
};
