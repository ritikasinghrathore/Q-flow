// Only the server emits queue events, and only after the database transaction has committed.
// Payloads carry ids and statuses only: never names or health information.
let io = null;
module.exports = {
  setIo: (x) => { io = x; },
  emitClinic: (clinicId, event, payload) => io && io.to(`clinic:${clinicId}`).emit(event, payload),
  emitUser: (userId, event, payload) => io && io.to(`user:${userId}`).emit(event, payload),
  disconnectUser: (userId) => io && io.in(`user:${userId}`).disconnectSockets(true),
};
