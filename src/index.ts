import { createApp } from './app.js';

const PORT = parseInt(process.env.PORT || '3000', 10);

const app = createApp();

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`event-platform v1.0.0 on port ${PORT}`);
});

function shutdown(sig: string) {
  console.log(`\n${sig} — shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
