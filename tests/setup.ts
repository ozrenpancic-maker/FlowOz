/**
 * Jest setup.
 *
 * The domain, video, storage and report layers are deliberately free of native
 * dependencies, so most of the suite runs as plain TypeScript. Only the report
 * renderer touches an Expo module, and that one is stubbed here.
 */
jest.mock('expo-print', () => ({
  printToFileAsync: jest.fn(async () => ({ uri: 'file:///tmp/report.pdf' })),
}));
