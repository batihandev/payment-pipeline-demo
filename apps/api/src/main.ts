import { apiSchema, validateConfig } from '../../../libs/config/src';
import { createApi } from './application';
async function bootstrap(): Promise<void> {
  const config = validateConfig(apiSchema, process.env);
  const app = await createApi(config);
  app.enableShutdownHooks();
  await app.listen(config.API_PORT, '127.0.0.1');
}
bootstrap().catch((error: unknown) => {
  if (error instanceof Error) console.error(error.message);
  process.exitCode = 1;
});
