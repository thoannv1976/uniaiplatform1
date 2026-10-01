import { createApp } from './app.factory.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const app = await createApp(config);
await app.listen(config.port, '0.0.0.0');
console.log(`${config.serviceName} đang chạy ở cổng ${config.port}`);
