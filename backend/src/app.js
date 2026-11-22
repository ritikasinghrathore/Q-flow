const express = require('express'); const helmet = require('helmet'); const cors = require('cors'); const cookieParser = require('cookie-parser'); const pinoHttp = require('pino-http');
const cfg = require('./config/environment'); const log = require('./config/logger'); const { query } = require('./config/database'); const limits = require('./middleware/rateLimit'); const errorHandler = require('./middleware/errorHandler');
const app = express();
app.set('trust proxy', 1); // Render / Netlify proxy
app.use(helmet()); app.use(cors({ origin: cfg.frontendUrl, credentials: true })); app.use(cookieParser()); app.use(express.json({ limit: '50kb' }));
app.use(pinoHttp({ logger: log, autoLogging: { ignore: (r) => r.url === '/health' } }));
app.get('/health', async (_req, res) => { try { await query('SELECT 1'); res.json({ status: 'ok' }); } catch (e) { res.status(503).json({ status: 'database_unavailable' }); } });
app.use('/api', limits.general);
app.use('/api/auth', require('./routes/auth.routes')); app.use('/api/clinics', require('./routes/clinic.routes'));
app.use('/api/notifications', require('./routes/notification.routes')); app.use('/api/public', require('./routes/public.routes')); app.use('/api', require('./routes/token.routes'));
app.use((_req, res) => res.status(404).json({ error: { code: 'not_found', message: 'Unknown endpoint' } }));
app.use(errorHandler);
module.exports = app;
