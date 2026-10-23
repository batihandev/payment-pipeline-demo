import { ConfigService } from '@nestjs/config';
import { createApp } from './bootstrap';
import type { ApiConfig } from './common/api-config';

async function bootstrap(): Promise<void> {
  const app = await createApp();
  app.enableShutdownHooks();
  const port = app
    .get<ConfigService<ApiConfig, true>>(ConfigService)
    .get('API_PORT', { infer: true });
  await app.listen(port, '127.0.0.1');
}

bootstrap().catch((error: unknown) => {
  if (error instanceof Error) console.error(error.message);
  process.exitCode = 1;
});
