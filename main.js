const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const os = require('os');
const net = require('net');
const { app, BrowserWindow, ipcMain, powerSaveBlocker } = require('electron');
const mqtt = require('mqtt');

// Globalt fångstnät för att förhindra krascher vid nätverksfel (t.ex. LocalTunnel)
process.on('uncaughtException', (error) => {
    console.error('⚠️ Obehandlat fel fångat:', error);
});


const INCIDENT_DIR = path.join(__dirname, 'incidents');
const PROFILE_DIR = path.join(__dirname, 'profiles');
const VEHICLE_DIR = path.join(PROFILE_DIR, 'Vehicles');

if (!fs.existsSync(INCIDENT_DIR)) fs.mkdirSync(INCIDENT_DIR);
if (!fs.existsSync(PROFILE_DIR)) fs.mkdirSync(PROFILE_DIR);
if (!fs.existsSync(VEHICLE_DIR)) fs.mkdirSync(VEHICLE_DIR, { recursive: true });

let mainWindow;

function logToWindow(msg, type = 'info') {
    console.log(`[${type.toUpperCase()}] ${msg}`);
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
        try {
            mainWindow.webContents.executeJavaScript(`console.log("%c[SERVER-${type.toUpperCase()}] ${msg.replace(/"/g, "'")}", "color: ${type==='err'?'red':'#00ff00'}")`);
        } catch (e) {
            console.error("Kunde inte logga till fönstret:", e);
        }
    }
}

const streams = {}; 
// Kamerasändare raderad för ökad prestanda

const server = http.createServer((req, res) => {
    const url = req.url;
    // --- API & Webbfiler ---
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
    }

    if (url.startsWith('/api/health')) {
        const status = {
            server: 'online',
            frigate: 'offline',
            cameras: {}
        };

        // Snabb-check av Frigate (timeout på 500ms för att inte låsa UI:t)
        let sent = false;
        const sendStatus = () => {
            if (sent) return;
            sent = true;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(status));
        };

        const frigateReq = http.request({ 
            hostname: '127.0.0.1', 
            port: 5050, 
            path: '/api/stats', 
            method: 'GET',
            timeout: 2000 
        }, (fRes) => {
            status.frigate = fRes.statusCode === 200 ? 'online' : 'error';
            sendStatus();
        });

        frigateReq.on('error', () => {
            sendStatus(); // Skicka stats ändå, även om frigate är nere
        });

        frigateReq.on('timeout', () => {
            frigateReq.destroy();
            sendStatus();
        });

        frigateReq.end();
        return;
    }

    if (url === '/' || url === '/index.html') {
        const p = path.join(__dirname, 'index.html');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end(fs.readFileSync(p));
    }

    const allowedFiles = [
        '/mobile.html', '/mobile.js', '/mobile.css', '/manifest.json', '/sw.js',
        '/index.html', '/app.js', '/index.css', '/supabase.client.js',
        '/vision.js', '/app_security.js', '/audio.js', '/brain.js', '/app_logic.js'
    ];

    if (allowedFiles.includes(url) || url.startsWith('/profiles/') || url.startsWith('/incidents/')) {
        const p = path.join(__dirname, url.substring(1));
        if (fs.existsSync(p)) {
            const ext = path.extname(p);
            const mime = { 
                '.html':'text/html', '.js':'text/javascript', '.css':'text/css', 
                '.json':'application/json', '.png':'image/png', '.jpg':'image/jpeg' 
            };
            res.writeHead(200, { 'Content-Type': mime[ext] || 'text/plain' });
            return res.end(fs.readFileSync(p));
        }
    }

    if (url.startsWith('/api/chat')) {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            const oReq = http.request({ hostname: '127.0.0.1', port: 11434, path: '/api/chat', method: 'POST' }, (oRes) => {
                res.writeHead(oRes.statusCode, { 'Content-Type': 'application/json' });
                oRes.pipe(res);
            });
            oReq.on('error', () => { res.writeHead(500); res.end(JSON.stringify({error: "Ollama offline"})); });
            oReq.write(body); oReq.end();
        });
        return;
    }

    res.writeHead(404); res.end("Not Found");
});

server.listen(9999, '0.0.0.0', async () => {
    console.log("JARVIS SERVER REDO: 0.0.0.0:9999");
    try {
        const localtunnel = require('localtunnel');
        const randid = Math.floor(Math.random() * 90000) + 10000;
        const tunnel = await localtunnel({ port: 9999, subdomain: 'jarvis-vakt-' + randid });
        
        tunnel.on('error', (err) => {
            console.error("📱 Tunnel-fel under körning:", err);
        });

        console.log(`📱 JARVIS MOBILÅTKOMST (HTTPS): ${tunnel.url}`);
    } catch (e) {
        console.error("📱 Kunde inte starta tunnel:", e);
    }
});

app.on('ready', () => {
    mainWindow = new BrowserWindow({ 
        width: 1500, height: 1100, 
        backgroundColor: '#05080a', 
        webPreferences: { 
            nodeIntegration: true, 
            contextIsolation: false, 
            webSecurity: false,
            backgroundThrottling: false
        } 
    });
    mainWindow.loadURL('http://localhost:9999');
    mainWindow.webContents.openDevTools(); // Öppnar diagnostikfönstret automatiskt för felsökning
});

ipcMain.handle('list-profiles', async () => {
    if (!fs.existsSync(PROFILE_DIR)) return [];
    const dirs = fs.readdirSync(PROFILE_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);
    
    const archive = {};
    for (const name of dirs) {
        const p = path.join(PROFILE_DIR, name);
        archive[name] = fs.readdirSync(p).filter(f => f.endsWith('.jpg') || f.endsWith('.png'));
    }
    return archive;
});

ipcMain.handle('read-profile-image', async (event, { name, filename }) => {
    const p = path.join(PROFILE_DIR, name, filename);
    if (!fs.existsSync(p)) return null;
    return fs.readFileSync(p, { encoding: 'base64' });
});

ipcMain.handle('save-face-image', async (event, { name, base64 }) => {
    const dir = path.join(PROFILE_DIR, name);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    
    const filename = `${name}_${Date.now()}.jpg`;
    const p = path.join(dir, filename);
    const data = base64.replace(/^data:image\/\w+;base64,/, "");
    fs.writeFileSync(p, data, { encoding: 'base64' });
    return { success: true, filename };
});

ipcMain.handle('save-snapshot', async (event, { base64, label }) => {
    const fn = `alert_${Date.now()}_${label}.jpg`;
    fs.writeFileSync(path.join(INCIDENT_DIR, fn), base64.replace(/^data:image\/\w+;base64,/, ""), 'base64');
    return fn;
});

ipcMain.handle('save-vehicle-image', async (event, { base64, name }) => {
    const filePath = path.join(VEHICLE_DIR, name);
    fs.writeFileSync(filePath, base64.replace(/^data:image\/\w+;base64,/, ""), 'base64');
    logToWindow(`[VEHICLE-SAVE] Sparat fordonsbevis: ${name}`, 'info');
    return filePath;
});

ipcMain.on('log-identity', (event, { name, camera }) => {
    logToWindow(`[IDENTIFIERING] ${name} detekterad vid ${camera}`, 'info');
});

// --- MQTT BRYGGA FÖR FRIGATE ---
const mqttClient = mqtt.connect('mqtt://localhost:1883');
const processedEvents = new Map(); // objId -> true (Nyligen loggad)

mqttClient.on('connect', () => {
    logToWindow("❤️ SYSTEM-LINK: FRIGATE & JARVIS ÄR NU SAMMANKOPPLADE", 'info');
    logToWindow("❤️ STATUS: PULS AKTIV - SYSTEMET ÄR LIVE", 'info');
    mqttClient.subscribe('frigate/events');
    mqttClient.subscribe('frigate/reviews');
});

mqttClient.on('offline', () => {
    logToWindow("📡 MQTT-STATUS: Tappat kontakten med Frigate. Försöker återansluta lokalt...", 'warn');
});

mqttClient.on('message', (topic, message) => {
    if (topic === 'frigate/events' || topic === 'frigate/reviews') {
        try {
            const event = JSON.parse(message.toString());
            const data = event.after || event; 
            
            // --- FIX: Säkerställ att 'type' finns på objektet för frontend-filtret ---
            if (!event.type) {
                event.type = (event.severity === 'alert' || !event.before) ? 'new' : 'update';
            }
            const type = event.type;
            const objId = data.id;

            // --- SPÄRR MOT SPAMMING ---
            // Logga i UI endast om det är en ny händelse för att inte fylla skärmen
            const shouldLog = type === 'new' && !processedEvents.has(objId);
            
            if (shouldLog) {
                const label = data.label || 'rörelse';
                const cam = data.camera;
                logToWindow(`[FRIGATE] Detekterat ${label} vid ${cam}`, 'info');
                processedEvents.set(objId, true);
                // Rensa cachen efter 10 minuter
                setTimeout(() => processedEvents.delete(objId), 600000);
            }

            // Skicka alltid eventet till frontend (för vakt-logiken), men utan att logga texten i UI
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('frigate-event', event);
            }
        } catch (e) {
            console.error("MQTT: Fel vid parsing av Frigate-event:", e);
        }
    }
});