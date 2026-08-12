// Minimal pub/sub used to broadcast real-time events (punch in/out, leave
// requests, regularizations, etc.) to any connected Server-Sent-Events client.
// No external dependencies - just an array of open response streams.
const clients = [];

function addClient(res) {
  clients.push(res);
}

function removeClient(res) {
  const idx = clients.indexOf(res);
  if (idx !== -1) clients.splice(idx, 1);
}

// type: short string e.g. 'punch-in', 'punch-out', 'leave-applied', 'leave-decided'
// payload: any JSON-serializable data describing the event
function broadcast(type, payload) {
  const data = JSON.stringify({ type, payload, time: new Date().toISOString() });
  clients.forEach((res) => {
    try {
      res.write(`data: ${data}\n\n`);
    } catch (e) {
      // Ignore write errors on dead connections; they'll be cleaned up on 'close'
    }
  });
}

module.exports = { addClient, removeClient, broadcast, _clients: clients };
