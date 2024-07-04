const fs = require('fs').promises;
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

// Constants
const PORT = 8080;

const CHUNK_SIZE = 256;
const MAX_VIEWPORT_SIZE = CHUNK_SIZE * 4;

const SAVE_INTERVAL = 1000 * 30; // 30 seconds

const RATE_LIMIT_TIME_WINDOW = 2000;
const MAX_REQUESTS_PER_WINDOW = 10;
const INITIAL_COOLDOWN_PERIOD = 3000; // cooldown
const COOLDOWN_INCREMENT_FACTOR = 2; // Cooldown period will double each time
const COOLDOWN_RESET_FACTOR = 2; // User cooldown increments will be forgiven after the last cooldown duration time this factor. (e.g. for 2, user has to wait 6s after receiving a 3s cooldown, otherwise it will keep going up)

const DATA_DIR = path.join(__dirname, 'data');
const MAP_DIR = path.join(DATA_DIR, 'map');
const STATS_FILE = path.join(DATA_DIR, 'stats.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

const MAX_SAFE_INT = Number.MAX_SAFE_INTEGER;
const MIN_SAFE_INT = Number.MIN_SAFE_INTEGER;



let grid = {}; // Store the grid state in chunks
let dirtyChunk = new Set(); // Keep track of modified chunks and only save modified chunks
let clientViewports = new Map(); // Store the viewports of connected clients
let users = {};
let activeConnections = 0;
let connectionIdInc = 0;
let stats = {
    globalClickCount: 0,
    totalChunks: 0,
    uniqueUsers: 0,
};


async function main() {

    // Create the data directory if it doesn't exist
    fs.mkdir(DATA_DIR, { recursive: true });

    // Create the map directory if it doesn't exist
    fs.mkdir(MAP_DIR, { recursive: true });

    // Load stuff from disk
    await loadStats();
    await discoverChunks();
    await loadUsers();
    console.log('Loaded stats from disk', stats);

    // Start the server
    server.listen(PORT, () => {
        console.log(`Server is listening on http://localhost:${PORT}`);
    });
    
    // Send stats to clients periodically
    broadcastStats();
    // Save chunks to disk periodically
    setInterval(saveChunksToDisk, SAVE_INTERVAL);
    // Save stats to disk periodically
    setInterval(saveStats, SAVE_INTERVAL);
    // Save clients to disk periodically
    setInterval(saveClients, SAVE_INTERVAL);
    // Unload unused chunks periodically
    setInterval(garbageCollectChunks, SAVE_INTERVAL);
}

// Load statistics from file
async function loadStats() {
    try {
        const data = await fs.readFile(STATS_FILE);
        Object.assign(stats, JSON.parse(data));
    } catch (error) {
        await fs.writeFile(STATS_FILE, JSON.stringify(stats));
    }
}

// Load users from file
async function loadUsers() {
    try {
        const data = await fs.readFile(USERS_FILE);
        users = JSON.parse(data);
        const count = Object.keys(users).length;
        stats.uniqueUsers = count;
        console.log(`Loaded ${count} users on disk`);
    } catch (error) {
        await fs.writeFile(USERS_FILE, JSON.stringify(users));
    }
}

// Discover existing chunks
async function discoverChunks() {
    try {
        const files = await fs.readdir(MAP_DIR);
        const count = files.filter(file => file.endsWith('.chunk')).length;
        stats.totalChunks = count;
        console.log(`Discovered ${count} chunks on disk`);
    } catch (error) {
        console.error("Error discovering chunks!", error);
    }
}

// Create an HTTP server
const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/') {
        try {
            const data = await fs.readFile(path.join(__dirname, 'index.html'));
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data);
        } catch (error) {
            res.writeHead(500);
            res.end('Error loading index.html');
        }
    } else {
        res.writeHead(404);
        res.end('Not Found');
    }
});

// Create a WebSocket server
const wss = new WebSocket.Server({ server });
wss.on('connection', (socket, req) => {
    const ip = req.socket.remoteAddress;// || req.headers['x-forwarded-for'];
    socket.ip = ip;

    connectionIdInc++;
    activeConnections++;

    const currentTime = Date.now();
    if (!users[ip]) {
        users[ip] = {
            created: currentTime,
            lastActivity: currentTime,
            sessions: 0,
            messages: 0,
            clicks: 0,
            cooldownUntil: 0,
            cooldownCount: 0,
            lastCooldown: 0,
            requests: []
        };
        stats.uniqueUsers++;
    }
    
    const user = users[ip];
    user.sessions++;

    console.log('New client connected!', connectionIdInc, `'${ip}'`);

    // send stats to user on connection
    const stats = getStats(ip);
    socket.send(JSON.stringify(stats));

    socket.on('message', async (message) => {
        const now = Date.now();
        user.lastActivity = now;
        user.requests.push(now);
        user.messages++;

        // Reset cooldown increase if no cooldown has been hit in a while
        const cooldownDuration = INITIAL_COOLDOWN_PERIOD * Math.pow(COOLDOWN_INCREMENT_FACTOR, user.cooldownCount);
        if (user.lastCooldown && now - user.lastCooldown > cooldownDuration * COOLDOWN_RESET_FACTOR) {
            user.cooldownCount = 0;
        }

        if (user.cooldownUntil && now < user.cooldownUntil) {
            socket.send(JSON.stringify({ type: 'error', message: `You are in cooldown period.\nPlease wait ${Math.round((user.cooldownUntil - now) / 1000)} seconds.`, retry: user.cooldownUntil - now }));
            return;
        }

        // Remove timestamps older than the time window
        while (user.requests.length > 0 && user.requests[0] <= now - RATE_LIMIT_TIME_WINDOW) {
            user.requests.shift();
        }

        if (user.requests.length > MAX_REQUESTS_PER_WINDOW) {
            user.cooldownCount++;
            user.lastCooldown = now;
            user.cooldownUntil = now + cooldownDuration;
            socket.send(JSON.stringify({ type: 'error', message: `Slow down! You exceeded the rate limit.\nWait ${Math.round((user.cooldownUntil - now) / 1000)} seconds.`, retry: user.cooldownUntil - now }));
            return;
        }

        const data = JSON.parse(message);
        if (data.type === 'getGrid') {
            clientViewports.set(socket, data.viewPort);
            const res = await getGridData(data.viewPort);
            socket.send(JSON.stringify(res));
        } else if (data.type === 'toggle') {
            const key = `${data.x},${data.y}`;
            await toggleGridCell(data.x, data.y);
            broadcastGridUpdate(key, await getGridCell(data.x, data.y));
            user.clicks++;
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

async function saveChunksToDisk() {
    const savePromises = Object.keys(grid).map(chunkKey => saveChunk(chunkKey));
    await Promise.all(savePromises);
}

async function saveChunk(chunkKey) {
    if (!dirtyChunk.has(chunkKey)) return; // skip writing unmodified chunks
    const chunkPath = path.join(MAP_DIR, `${chunkKey}.chunk`);
    await fs.writeFile(chunkPath, Buffer.from(grid[chunkKey]));
    dirtyChunk.delete(chunkKey);
}

async function loadChunk(chunkKey) {
    if (grid[chunkKey]) return grid[chunkKey];

    const chunkPath = path.join(MAP_DIR, `${chunkKey}.chunk`);
    let chunk;
    try {
        const buffer = await fs.readFile(chunkPath);
        chunk = new Uint8Array(buffer);
        console.log(`Chunk [${chunkKey}] has been loaded. (Chunks in memory: ${Object.keys(grid).length})`);
    } catch (error) {
        chunk = new Uint8Array(Math.ceil((CHUNK_SIZE * CHUNK_SIZE) / 8)); // Using 1 bit per checkbox
        stats.totalChunks++;
        console.log(`Chunk [${chunkKey}] has been created. (Chunks in memory: ${Object.keys(grid).length})`);
    }
    grid[chunkKey] = chunk;

    return chunk;
}

async function garbageCollectChunks() {
    const activeChunks = new Set();

    // console.log('Starting garbage collection...');
    for (const [client, viewport] of clientViewports.entries()) {
        // console.log(`Processing viewport for client: ${client.ip}`);
        for (let y = Math.floor(viewport.startY / CHUNK_SIZE) * CHUNK_SIZE; y <= viewport.endY; y += CHUNK_SIZE) {
            for (let x = Math.floor(viewport.startX / CHUNK_SIZE) * CHUNK_SIZE; x <= viewport.endX; x += CHUNK_SIZE) {
                const chunkKey = getChunkKey(x, y);
                activeChunks.add(chunkKey);
                // console.log(`Viewport ${JSON.stringify(viewport)} includes chunk ${chunkKey}`);
            }
        }
    }

    let unloadedCount = 0;
    const unloadPromises = [];
    for (const chunkKey in grid) {
        if (!activeChunks.has(chunkKey)) {
            await saveChunk(chunkKey);
            delete grid[chunkKey];
            unloadedCount++;
            console.log(`Chunk [${chunkKey}] has been unloaded. (Chunks in memory: ${Object.keys(grid).length})`);
        }
    }
}


async function toggleGridCell(x, y) {
    const chunkKey = getChunkKey(x, y);
    const chunk = await loadChunk(chunkKey);
    const localX = ((x % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    const localY = ((y % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    const index = localY * CHUNK_SIZE + localX;
    const byteIndex = Math.floor(index / 8);
    const bitIndex = index % 8;
    chunk[byteIndex] ^= (1 << bitIndex); // Toggle the specific bit
    dirtyChunk.add(chunkKey); // flag chunk as modified
}

async function getGridCell(x, y) {
    const chunkKey = getChunkKey(x, y);
    const chunk = await loadChunk(chunkKey);
    const localX = ((x % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    const localY = ((y % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    const index = localY * CHUNK_SIZE + localX;
    const byteIndex = Math.floor(index / 8);
    const bitIndex = index % 8;
    return (chunk[byteIndex] & (1 << bitIndex)) !== 0 ? 1 : 0;
}

async function getGridData(viewPort) {
    const { startX, startY, endX, endY } = viewPort;
    const width = endX - startX + 1;
    const height = endY - startY + 1;

    // Ensure width and height are within allowed limits
    if (width > MAX_VIEWPORT_SIZE || height > MAX_VIEWPORT_SIZE) {
        return {
            type: 'error',
            message: `Viewport size exceeds maximum allowed size of ${MAX_VIEWPORT_SIZE}x${MAX_VIEWPORT_SIZE}`
        };
    }

    // Ensure the values are within JavaScript integer limits and respect CHUNK_SIZE constraints
    if (!Number.isSafeInteger(startX) || !Number.isSafeInteger(startY) ||
        !Number.isSafeInteger(endX) || !Number.isSafeInteger(endY) ||
        startX < MIN_SAFE_INT / CHUNK_SIZE || startY < MIN_SAFE_INT / CHUNK_SIZE ||
        endX > MAX_SAFE_INT / CHUNK_SIZE || endY > MAX_SAFE_INT / CHUNK_SIZE ||
        width < MIN_SAFE_INT / CHUNK_SIZE || height < MIN_SAFE_INT / CHUNK_SIZE ||
        width > MAX_SAFE_INT / CHUNK_SIZE || height > MAX_SAFE_INT / CHUNK_SIZE) {
        return {
            type: 'error',
            message: 'Viewport coordinates exceed allowed limits'
        };
    }

    const gridArray = new Uint8Array(Math.ceil((width * height) / 8));

    for (let y = startY; y <= endY; y++) {
        for (let x = startX; x <= endX; x++) {
            const cellValue = await getGridCell(x, y);
            const localX = x - startX;
            const localY = y - startY;
            const index = localY * width + localX;
            const byteIndex = Math.floor(index / 8);
            const bitIndex = index % 8;
            if (cellValue) {
                gridArray[byteIndex] |= (1 << bitIndex);
            }
        }
    }

    const message = {
        type: 'gridData',
        header: {
            startX,
            startY,
            endX,
            endY,
            width,
            height,
            totalSize: gridArray.length
        },
        data: Buffer.from(gridArray).toString('base64')
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

function getStats(clientIp) {
    const globalStats = {
        type: 'stats',
        totalCheckboxes: stats.totalChunks * CHUNK_SIZE * CHUNK_SIZE,
        totalChunks: stats.totalChunks,
        globalClickCount: stats.globalClickCount,
        activeConnections,
    };

    let userStats = {};
    const user = users[clientIp];
    if (user) userStats = {
        clicks: user.clicks,
    };

    return {
        ...globalStats,
        ...userStats,
    };
}

async function broadcastStats() {
    for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN) {
            const stats = getStats(client.ip);
            client.send(JSON.stringify(stats));
        }
    }
    setTimeout(broadcastStats, 5000);
}

// Persist statistics to file periodically
async function saveStats() {
    await fs.writeFile(STATS_FILE, JSON.stringify(stats));
}

// Persist clients to file periodically
async function saveClients() {
    const clientsString = Object.keys(users).map(key => `"${key}":${JSON.stringify(users[key])}`).join(',\n');
    const formattedClients = `{\n${clientsString}\n}`;
    await fs.writeFile(USERS_FILE, formattedClients);
}

function delay(ms) {
    return new Promise(r => setTimeout(r, ms));
}

/** Random int from to (min and max included) */
function rand(min, max) {
    return Math.floor(Math.random() * (max - min + 1) + min);
}

main();
