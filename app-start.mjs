import { createApp } from './lib/app.mjs';

const port = Number(process.env.APP_PORT ?? 3200);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('APP_PORT 应为 1 到 65535 之间的整数');
}
const app = createApp({ sourceUrl: process.env.SOURCE_URL || 'http://127.0.0.1:3100' });
app.server.listen(port, '127.0.0.1', () => {
  console.log('对账服务已启动 http://127.0.0.1:' + port);
});
