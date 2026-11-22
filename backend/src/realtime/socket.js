const { Server } = require('socket.io'); const cookie = require('cookie');
const cfg = require('../config/environment'); const log = require('../config/logger'); const { query } = require('../config/database');
const { hashToken, COOKIE } = require('../middleware/authenticate'); const ev = require('./events');
// Every connection is authenticated from the session cookie, and joins only rooms it is authorised for.
// Clients can only listen: there are no client-to-server queue events.
function init(server) {
  const io = new Server(server, { cors: { origin: cfg.frontendUrl, credentials: true } });
  io.use(async (socket, next) => {
    try {
      const token = cookie.parse(socket.handshake.headers.cookie || '')[COOKIE]; if (!token) return next(new Error('unauthorized'));
      const r = await query(`SELECT u.id FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND u.account_status='active'`, [hashToken(token)]);
      if (!r.rowCount) return next(new Error('unauthorized')); socket.data.userId = r.rows[0].id; next();
    } catch (e) { log.error({ err: e.message }, 'socket auth error'); next(new Error('unauthorized')); }
  });
  io.on('connection', async (socket) => {
    socket.join(`user:${socket.data.userId}`);
    const m = await query(`SELECT clinic_id FROM clinic_memberships WHERE user_id=$1 AND membership_status='active'`, [socket.data.userId]);
    m.rows.forEach((x) => socket.join(`clinic:${x.clinic_id}`));
    socket.emit('READY', { rooms: m.rowCount + 1 }); // on (re)connect clients must refetch state from the REST API
  });
  ev.setIo(io); return io;
}
module.exports = { init };
