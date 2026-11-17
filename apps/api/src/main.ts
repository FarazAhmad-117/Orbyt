import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { AppModule } from "./app.module";
import { configureApp, createAdapter } from "./http";

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    createAdapter(),
    { rawBody: true }, // Stripe webhook signatures are computed over the exact bytes
  );
  configureApp(app);
  app.enableShutdownHooks(); // closes the DB pool on SIGTERM (docker stop)
  // Loopback by default; the container sets HOST=0.0.0.0.
  await app.listen(
    Number(process.env.PORT ?? 3001),
    process.env.HOST ?? "127.0.0.1",
  );
}

void bootstrap();
