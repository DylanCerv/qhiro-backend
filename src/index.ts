import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { env } from './config/env.js';
import { apiRoutes } from './routes/api.js';
import { adminRoutes, parcelRoutes } from './routes/parcels-admin.js';
import { userRoutes } from './routes/users.js';
import { initFirebase, seedAdminUser } from './services/firebase.js';
import { startFlightScheduler, stopFlightScheduler } from './services/flight-scheduler.js';
import { initMqtt, shutdownMqtt } from './services/mqtt.js';

const app = new Hono();

app.use('*', logger());
app.use(
  '*',
  cors({
    origin: env.corsOrigin,
    allowHeaders: ['Authorization', 'Content-Type'],
  }),
);

app.route('/api/users', userRoutes);
app.route('/api/parcels', parcelRoutes);
app.route('/api/admin', adminRoutes);
app.route('/api', apiRoutes);

initFirebase();
initMqtt();
startFlightScheduler();

seedAdminUser().catch((error) => {
  console.error('[Seed] Failed to seed admin user:', error);
});

console.log(`[Qhiro Backend] Starting on port ${env.port}`);

const server = serve({ fetch: app.fetch, port: env.port });

let isShuttingDown = false;

function shutdown(signal: string): void {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`[Qhiro Backend] ${signal} received, shutting down...`);
  stopFlightScheduler();
  shutdownMqtt();

  server.close((error) => {
    if (error) {
      console.error('[Qhiro Backend] Error during shutdown:', error);
      process.exit(1);
    }
    process.exit(0);
  });

  setTimeout(() => {
    console.error('[Qhiro Backend] Forced shutdown after timeout');
    process.exit(1);
  }, 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
