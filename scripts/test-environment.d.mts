export function isolatedTestEnvironment(
  root: string,
  options?: { nodeEnv?: 'test' | 'production' }
): Record<string, string>;
