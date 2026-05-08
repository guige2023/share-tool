// ShareTool Constants - central config
// All port and default values should reference these, not hardcode

module.exports = {
  DEFAULT_HTTP_PORT:  18790,
  DEFAULT_HTTPS_PORT: 18793,
  DEFAULT_SHARE_PORT: 18790,

  get HTTP_PORT()  { return parseInt(process.env.SHARE_TOOL_PORT || this.DEFAULT_HTTP_PORT, 10); },
  get HTTPS_PORT() { return parseInt(process.env.SHARE_TOOL_HTTPS_PORT || this.DEFAULT_HTTPS_PORT, 10); },

  get LAN_BASE_URL() {
    const crypto = require('crypto');
    // Lazy-load local IP detection
    const os = require('os');
    const ifs = os.networkInterfaces();
    for (const name of Object.keys(ifs)) {
      for (const iface of ifs[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          return `https://${iface.address}:${this.HTTPS_PORT}`;
        }
      }
    }
    return `https://localhost:${this.HTTPS_PORT}`;
  }
};
