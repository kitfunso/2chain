import 'dotenv/config';
import { buildServer } from '../src/server/index.js';

const port = Number(process.env.PORT || 3030);
const host = process.env.HOST || '127.0.0.1';

const app = await buildServer();
await app.listen({ port, host });
console.log(`2chain api listening on http://${host}:${port}`);
