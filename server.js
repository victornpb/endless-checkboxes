const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

// Constants
const CHUNK_SIZE = 256;
const SAVE_INTERVAL = 30000; // 30 seconds
const MAP_DIR = path.join(__dirname, 'map');

// Create the map directory if it doesn't exist
if (!fs.existsSync(MAP_DIR)) {
    fs.mkdirSync(MAP_DIR);
}

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

let grid = {}; // Store the grid state in chunks
let clientViewports = new Map(); // Store the viewports of connected clients

wss.on('connection', (socket) => {
    console.log('New client connected');

    socket.on('message', (message) => {
        const data = JSON.parse(message);
        if (data.type === 'requestGrid') {
            clientViewports.set(socket, data.viewPort);
            const viewPortData = getViewPortData(data.viewPort);
            socket.send(JSON.stringify(viewPortData));
        } else if (data.type === 'toggleBox') {
            const key = `${data.x},${data.y}`;
            toggleGridCell(data.x, data.y);
            broadcastGridUpdate(key, getGridCell(data.x, data.y));
        }
    });

    socket.on('close', () => {
        console.log('Client disconnected');
        clientViewports.delete(socket);
    });
});

function getChunkKey(x, y) {
    const chunkX = Math.floor(x / CHUNK_SIZE);
    const chunkY = Math.floor(y / CHUNK_SIZE);
    return `${chunkX},${chunkY}`;
}

function loadChunk(chunkKey) {
    if (grid[chunkKey]) return grid[chunkKey];

    const chunkPath = path.join(MAP_DIR, `${chunkKey}.bin`);
    let chunk;
    if (fs.existsSync(chunkPath)) {
        const buffer = fs.readFileSync(chunkPath);
        chunk = new Uint8Array(buffer);
    } else {
        chunk = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE);
    }
    grid[chunkKey] = chunk;
    return chunk;
}

function saveChunksToDisk() {
    for (const chunkKey in grid) {
        const chunkPath = path.join(MAP_DIR, `${chunkKey}.bin`);
        fs.writeFileSync(chunkPath, Buffer.from(grid[chunkKey]));
    }
}

function unloadUnusedChunks() {
    const activeChunks = new Set();
    for (const viewport of clientViewports.values()) {
        for (let y = viewport.startY; y <= viewport.endY; y += CHUNK_SIZE) {
            for (let x = viewport.startX; x <= viewport.endX; x += CHUNK_SIZE) {
                activeChunks.add(getChunkKey(x, y));
            }
        }
    }

    for (const chunkKey in grid) {
        if (!activeChunks.has(chunkKey)) {
            delete grid[chunkKey];
        }
    }
}

function toggleGridCell(x, y) {
    const chunkKey = getChunkKey(x, y);
    const chunk = loadChunk(chunkKey);
    const localX = x % CHUNK_SIZE;
    const localY = y % CHUNK_SIZE;
    const index = localY * CHUNK_SIZE + localX;
    chunk[index] = chunk[index] ? 0 : 1;
}

function getGridCell(x, y) {
    const chunkKey = getChunkKey(x, y);
    const chunk = loadChunk(chunkKey);
    const localX = x % CHUNK_SIZE;
    const localY = y % CHUNK_SIZE;
    const index = localY * CHUNK_SIZE + localX;
    return chunk[index];
}

function getViewPortData(viewPort) {
    const { startX, startY, endX, endY } = viewPort;
    const result = {};
    for (let y = startY; y <= endY; y++) {
        for (let x = startX; x <= endX; x++) {
            const key = `${x},${y}`;
            result[key] = getGridCell(x, y);
        }
    }
    return result;
}

function isInViewport(x, y, viewport) {
    const { startX, startY, endX, endY } = viewport;
    return x >= startX && x <= endX && y >= startY && y <= endY;
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

// Save chunks to disk periodically
setInterval(saveChunksToDisk, SAVE_INTERVAL);

// Unload unused chunks periodically
setInterval(unloadUnusedChunks, SAVE_INTERVAL);

// Start the server
const port = 8080;
server.listen(port, () => {
    console.log(`Server is listening on http://localhost:${port}`);
});
