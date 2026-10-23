import { ConfigModule } from '@nestjs/config';

/**
 * Serves a configuration that the app's entry point has already validated. It never reads
 * `process.env`, so every value has the type its schema parsed it to.
 */
export function appConfig(config: object) {
  return ConfigModule.forRoot({
    isGlobal: true,
    ignoreEnvFile: true,
    skipProcessEnv: true,
    load: [() => ({ ...config })],
  });
}
