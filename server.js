const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

// Constants
const CHUNK_SIZE = 256;
const SAVE_INTERVAL = 30000; // 30 seconds
const MAP_DIR = path.join(__dirname, 'map');
const STATS_FILE = path.join(__dirname, 'stats.json');

// Create the map directory if it doesn't exist
if (!fs.existsSync(MAP_DIR)) {
    fs.mkdirSync(MAP_DIR);
}

// Load statistics from file
let stats = {
    globalClickCount: 0,
    totalChunks: 0
};

if (fs.existsSync(STATS_FILE)) {
    const data = fs.readFileSync(STATS_FILE);
    Object.assign(stats, JSON.parse(data));
} else {
    fs.writeFileSync(STATS_FILE, JSON.stringify(stats));
}

// Discover existing chunks
function discoverChunks() {
    const files = fs.readdirSync(MAP_DIR);
    stats.totalChunks = files.filter(file => file.endsWith('.chunk')).length;
}

// Initialize chunk discovery
discoverChunks();

console.log(stats);

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
let activeConnections = 0;
let connectionIdInc = 0;
const wss = new WebSocket.Server({ server });

let grid = {}; // Store the grid state in chunks
let clientViewports = new Map(); // Store the viewports of connected clients

wss.on('connection', (socket, req) => {
    connectionIdInc++;
    activeConnections++;
    const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    console.log('New client connected!', connectionIdInc, `'${ip}'`);

    socket.on('message', (message) => {
        const data = JSON.parse(message);
        if (data.type === 'requestGrid') {
            clientViewports.set(socket, data.viewPort);
            const res = sendGridData(data.viewPort);
            socket.send(JSON.stringify(res));
        } else if (data.type === 'toggleBox') {
            const key = `${data.x},${data.y}`;
            toggleGridCell(data.x, data.y);
            broadcastGridUpdate(key, getGridCell(data.x, data.y));
            stats.globalClickCount++;
        }
    });

    socket.on('close', () => {
        activeConnections--;
        console.log('Client disconnected!', connectionIdInc, `'${ip}'`);
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

    const chunkPath = path.join(MAP_DIR, `${chunkKey}.chunk`);
    let chunk;
    if (fs.existsSync(chunkPath)) {
        const buffer = fs.readFileSync(chunkPath);
        chunk = new Uint8Array(buffer);
    } else {
        chunk = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE);
        stats.totalChunks++;
    }
    grid[chunkKey] = chunk;

    console.log(`Chunk loaded: ${chunkKey}. Total: ${Object.keys(grid).length}`);
    return chunk;
}

function saveChunksToDisk() {
    for (const chunkKey in grid) {
        saveChunk(chunkKey);
    }
}

function saveChunk(chunkKey) {
    const chunkPath = path.join(MAP_DIR, `${chunkKey}.chunk`);
    fs.writeFileSync(chunkPath, Buffer.from(grid[chunkKey]));
}

function garbageCollectChunks() {
    const activeChunks = new Set();
    for (const viewport of clientViewports.values()) {
        for (let y = viewport.startY; y <= viewport.endY; y += CHUNK_SIZE) {
            for (let x = viewport.startX; x <= viewport.endX; x += CHUNK_SIZE) {
                activeChunks.add(getChunkKey(x, y));
            }
        }
    }
    console.log(`Loaded chunks: ${activeChunks.size}`);
    let unloadedCount = 0;
    for (const chunkKey in grid) {
        if (!activeChunks.has(chunkKey)) {
            saveChunk(chunkKey); // save before unloading
            delete grid[chunkKey];
            unloadedCount++;
        }
    }
    if (unloadedCount > 0) console.log(`Unloaded ${unloadedCount} chunks`);
}

function toggleGridCell(x, y) {
    const chunkKey = getChunkKey(x, y);
    const chunk = loadChunk(chunkKey);
    const localX = ((x % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    const localY = ((y % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    const index = localY * CHUNK_SIZE + localX;
    chunk[index] = chunk[index] ? 0 : 1;
}

function getGridCell(x, y) {
    const chunkKey = getChunkKey(x, y);
    const chunk = loadChunk(chunkKey);
    const localX = ((x % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    const localY = ((y % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    const index = localY * CHUNK_SIZE + localX;
    return chunk[index];
}

function sendGridData(viewPort) {
    const { startX, startY, endX, endY } = viewPort;
    
    const gridArray = [];
    for (let y = startY; y <= endY; y++) {
        for (let x = startX; x <= endX; x++) {
            gridArray.push(getGridCell(x, y));
        }
    }

    const message = {
        type: 'gridData',
        header: {
            startX,
            startY,
            endX,
            endY,
            width: endX - startX + 1,
            height: endY - startY + 1,
            totalSize: gridArray.length
        },
        data: gridArray
    };
    return message;
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

async function sendStats() {
    const totalCheckboxes = stats.totalChunks * CHUNK_SIZE * CHUNK_SIZE;
    const statsToSend = {
        type: 'stats',
        activeConnections,
        totalChunks: stats.totalChunks,
        totalCheckboxes,
        globalClickCount: stats.globalClickCount
    };

    for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(statsToSend));
        }
    }
    setTimeout(sendStats, 5000);
}

// Persist statistics to file periodically
function saveStats() {
    fs.writeFileSync(STATS_FILE, JSON.stringify(stats));
}

setInterval(saveStats, SAVE_INTERVAL);

// Send stats to clients periodically
sendStats();

// Save chunks to disk periodically
setInterval(saveChunksToDisk, SAVE_INTERVAL);

// Unload unused chunks periodically
setInterval(garbageCollectChunks, SAVE_INTERVAL);

// Start the server
const port = 8080;
server.listen(port, () => {
    console.log(`Server is listening on http://localhost:${port}`);
});

function delay(ms) {
    return new Promise(r => setTimeout(r, ms));
}

/** Random int from to (min and max included) */
function rand(min, max) {
    return Math.floor(Math.random() * (max - min + 1) + min);
}
