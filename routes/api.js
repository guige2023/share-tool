/**
 * routes/api.js - minimal system APIs
 */

module.exports = async function handleApiRoutes(req, res, pathname, query, ctx) {
  const { db, sendJson, authRequired, VERSION } = ctx;
  const { method } = req;

  if (pathname === '/api/health' && method === 'GET') {
    const uptime = Math.floor(process.uptime());
    const mem = process.memoryUsage();
    sendJson(res, {
      status: 'ok',
      version: VERSION,
      uptime,
      memory: {
        rss: Math.round(mem.rss / 1024 / 1024),
        heapUsed: Math.round(mem.heapUsed / 1024 / 1024)
      }
    });
    return true;
  }

  if (pathname === '/api/storage' && method === 'GET') {
    const auth = authRequired(req, res);
    if (!auth) return true;

    const count = db.getFileCount();
    const totalSize = db.getTotalStorageSize();
    sendJson(res, { count, totalSize, maxSize: 10 * 1024 * 1024 * 1024 });
    return true;
  }

  return false;
};
