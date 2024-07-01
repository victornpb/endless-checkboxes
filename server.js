const http = require('http');
const fs = require('fs');
const WebSocket = require('ws');
const path = require('path');

// Create an HTTP server
const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/') {
        fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
            if (err) {
                res.writeHead(500);
                res.end('Error loading index.html');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data);
        });
    } else {
        res.writeHead(404);
        res.end('Not Found');
    }
});

// Create a WebSocket server
const wss = new WebSocket.Server({ server });

let grid = {}; // Store the grid state
let clientViewports = new Map(); // Store the viewports of connected clients

wss.on('connection', (socket) => {
    console.log('New client connected');

    socket.on('message', (message) => {
        const data = JSON.parse(message);
        if (data.type === 'requestGrid') {
            clientViewports.set(socket, data.viewPort);
            const viewPort = getViewPort(data.viewPort);
            socket.send(JSON.stringify(viewPort));
        } else if (data.type === 'toggleBox') {
            const key = `${data.x},${data.y}`;
            grid[key] = !grid[key];
            broadcastGridUpdate(key, grid[key]);
        }
    });

    socket.on('close', () => {
        console.log('Client disconnected');
        clientViewports.delete(socket);
    });
});

function getViewPort(viewPort) {
    const { startX, startY, endX, endY } = viewPort;
    const result = {};
    for (let y = startY; y <= endY; y++) {
        for (let x = startX; x <= endX; x++) {
            const key = `${x},${y}`;
            result[key] = grid[key] || false;
        }
    }
    return result;
}

function broadcastGridUpdate(key, value) {
    const [x, y] = key.split(',').map(Number);
    
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            const viewport = clientViewports.get(client);
            if (viewport && isInViewport(x, y, viewport)) {
                client.send(JSON.stringify({ [key]: value }));
            }
        }
    });
}

function isInViewport(x, y, viewport) {
    const { startX, startY, endX, endY } = viewport;
    return x >= startX && x <= endX && y >= startY && y <= endY;
}

// Start the server
const port = 8080;
server.listen(port, () => {
    console.log(`Server is listening on http://localhost:${port}`);
});
