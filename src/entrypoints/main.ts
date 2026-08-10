const command = process.argv[2];

switch (command) {
  case 'http':
    await import('./http.ts');
    break;
  case 'mqtt':
    await import('./mqtt.ts');
    break;
  case 'worker':
    await import('./worker.ts');
    break;
  case 'app':
    await import('./app.ts');
    break;
  default:
    console.error(`Usage: bun src/entrypoints/main.ts <http|mqtt|worker|app>`);
    console.error(`  http    Start the HTTP server`);
    console.error(`  mqtt    Start the MQTT subscriber`);
    console.error(`  worker  Start the background worker`);
    console.error(`  app     Start the area map UI`);
    process.exit(1);
}
