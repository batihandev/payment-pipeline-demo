import { ConfigService } from '@nestjs/config';
import { createApp } from './bootstrap';
import type { ApiConfig } from './common/api-config';

async function bootstrap(): Promise<void> {
  const app = await createApp();
  app.enableShutdownHooks();
  const config = app.get<ConfigService<ApiConfig, true>>(ConfigService);
  await app.listen(
    config.get('API_PORT', { infer: true }),
    config.get('API_HOST', { infer: true }),
  );
}

bootstrap().catch((error: unknown) => {
  if (error instanceof Error) console.error(error.message);
  process.exitCode = 1;
});
