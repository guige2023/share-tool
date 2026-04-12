
const WebSocket = require('ws');

const token = process.argv[2];
const wsUrl = process.argv[3] || 'wss://localhost:18793/ws';

console.log('WS URL:', wsUrl);
console.log('Token:', token ? token.slice(0,8)+'...' : 'MISSING');

const ws = new WebSocket(`${wsUrl}?token=${encodeURIComponent(token)}`, {
  rejectUnauthorized: false
});

const timeout = setTimeout(() => {
  console.log('TIMEOUT');
  process.exit(1);
}, 12000);

ws.on('open', () => console.log('WS open. Sending register...'));
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  console.log('Msg type:', msg.type);
  if (msg.type === 'register_ack') {
    console.log('SUCCESS: files=', msg.files ? msg.files.length : 0);
    clearTimeout(timeout);
    ws.close();
    process.exit(0);
  }
});
ws.on('error', (err) => { console.log('WS error:', err.message); clearTimeout(timeout); process.exit(1); });
