const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const os = require('os');
const net = require('net');
const { app, BrowserWindow, ipcMain, powerSaveBlocker } = require('electron');
const https = require('https');
const mqtt = require('mqtt');
const WebSocket = require('ws'); // Rensad Mirror-ström

// --- SUPABASE KEYS ---
const SUPABASE_URL = 'https://pyozlvgcaozpcydmxolv.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB5b3psdmdjYW96cGN5ZG14b2x2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU5MzEyMjYsImV4cCI6MjA5MTUwNzIyNn0.GzeERLcJ3n0o0UAtJ4oPMHiNTVoFdOC8bwYqvRtbZLg';

async function syncTunnelToCloud(url) {
    const data = JSON.stringify({ key: 'remote_tunnel', data: { url: url } });
    const options = {
        hostname: 'pyozlvgcaozpcydmxolv.supabase.co',
        path: '/rest/v1/jarvis_settings?on_conflict=key',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
            'Prefer': 'resolution=merge-duplicates'
        }
    };

    const req = https.request(options, (res) => {
        console.log(`[CLOUD-SYNC] Tunnel-adress synkroniserad till Supabase (${res.statusCode})`);
    });
    req.on('error', (e) => console.error("Cloud Sync Fail:", e));
    req.write(data);
    req.end();
}

// Globalt fångstnät för att förhindra krascher vid nätverksfel (t.ex. LocalTunnel)

process.on('uncaughtException', (error) => {
    console.error('⚠️ Obehandlat fel fångat:', error);
});

/* ⚠️ SYSTEM ARKITEKTUR VARNING (RIDDAR-PROTOKOLLET)
   Frigate äger ögonen (kamerorna). JARVIS/Travis ska vara BLIND och DÖV i viloläge.
   Lyssna ALDRIG på 'frigate/events' - det skapar brus och falska signaler.
   Inga modifieringar av denna arkitektur utan föregående plan och godkännande.
   Se SYSTEM_RULES.md för mer information. */


const INCIDENT_DIR = path.join(__dirname, 'incidents');
const PROFILE_DIR = path.join(__dirname, 'profiles');
const VEHICLE_DIR = path.join(PROFILE_DIR, 'Vehicles');

if (!fs.existsSync(INCIDENT_DIR)) fs.mkdirSync(INCIDENT_DIR);
if (!fs.existsSync(PROFILE_DIR)) fs.mkdirSync(PROFILE_DIR);
if (!fs.existsSync(VEHICLE_DIR)) fs.mkdirSync(VEHICLE_DIR, { recursive: true });

let mainWindow;
let wss; // WebSocket Server för Remote
const REMOTE_PORT = 9998;
let originalBounds = { width: 1200, height: 800 }; // Standardstorlek
let frigateConnected = false; // Status-tracker för UI

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
    // TILLÅT MOBIL-APPEN PÅ VERCEL ATT KOMMUNICERA MED DATORN (CORS)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
    }

    const url = req.url;

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
    if (url === '/api/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
            server: 'online',
            frigate: frigateConnected ? 'online' : 'offline',
            cameras: {} // Expanderbar om vi vill ha specifik kamerastatus
        }));
    }

    res.writeHead(404); res.end("Not Found");
});

server.listen(9999, '0.0.0.0', async () => {
    console.log("JARVIS SERVER REDO: 0.0.0.0:9999");
    try {
        const localtunnel = require('localtunnel');
        // VIKTIGT: Fast subdomain så att länken i mobilen aldrig ändras
        const tunnel = await localtunnel({ port: 9999, subdomain: 'jarvis-vakt-41990' });
        
        tunnel.on('error', (err) => {
            console.error("📱 Tunnel-fel under körning:", err);
        });

        console.log(`📱 JARVIS MOBILÅTKOMST (HTTPS): ${tunnel.url}`);
        syncTunnelToCloud(tunnel.url);
    } catch (e) {
        console.error("📱 Kunde inte starta tunnel:", e);
    }
});

app.on('ready', () => {
    mainWindow = new BrowserWindow({ 
        width: originalBounds.width, 
        height: originalBounds.height, 
        backgroundColor: '#05080a', 
        frame: true, // Återställt: Tillåt användaren att flytta/stänga fönstret
        webPreferences: { 
            nodeIntegration: true, 
            contextIsolation: false, 
            webSecurity: false,
            backgroundThrottling: false
        } 
    });
    mainWindow.loadURL('http://localhost:9999');

    // --- MIRROR GUARD: WebSocket Server (Delar port 9999 med webbservern) ---
    wss = new WebSocket.Server({ server: server }); 
    logToWindow(`[REMOTE] Mirror-server aktiv via System-Link`, 'info');

    wss.on('connection', (ws) => {
        logToWindow('[REMOTE] Mobil-enhet ansluten till Mirror-länken', 'warn');
        remoteConnected = true;

        // Strömma fönstret (Bilder)
        let streamInterval = setInterval(async () => {
            if (ws.readyState === WebSocket.OPEN && mainWindow && !mainWindow.isDestroyed()) {
                const image = await mainWindow.webContents.capturePage();
                ws.send(JSON.stringify({ type: 'frame', data: image.toDataURL() }));
            }
        }, 100); 

        // Hantera fjärrstyrning (Input)
        ws.on('message', (message) => {
            try {
                const msg = JSON.parse(message);
                const bounds = mainWindow.getBounds();

                if (msg.type === 'input' && mainWindow) {
                    mainWindow.webContents.sendInputEvent({
                        type: msg.input.type,
                        x: Math.floor(msg.input.x * bounds.width),
                        y: Math.floor(msg.input.y * bounds.height),
                        button: 'left',
                        clickCount: 1
                    });
                } else if (msg.type === 'key' && mainWindow) {
                    mainWindow.webContents.sendInputEvent({
                        type: 'keyDown',
                        keyCode: msg.key
                    });
                }
            } catch (e) {}
        });

        ws.on('close', () => {
            logToWindow('[REMOTE] Mobil-enhet kopplade ifrån', 'info');
            clearInterval(streamInterval);
            remoteConnected = false;
        });
    });
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

ipcMain.handle('update-frigate-lpr', async (event, { name, plate }) => {
    const frigateConfigPath = 'C:/Users/perss/Desktop/Frigate/config/config.yml';
    try {
        if (!fs.existsSync(frigateConfigPath)) return { success: false, error: 'Frigate config saknas' };
        
        let content = fs.readFileSync(frigateConfigPath, 'utf8');
        const cleanPlate = plate.toUpperCase().replace(/\s/g, '');
        const spacedPlate = cleanPlate.replace(/([A-Z]{3})(\d{3})/, '$1 $2'); // Ex: ABC123 -> ABC 123

        // Sök efter known_plates sektionen
        const lprRegex = /known_plates:\s*([\s\S]*?)(?=\n\S|$)/;
        const match = content.match(lprRegex);

        if (match) {
            let knownPlatesContent = match[1];
            
            // Kolla om plåten redan finns
            if (knownPlatesContent.includes(cleanPlate)) {
                return { success: true, message: 'Plåten redan registrerad.' };
            }

            // Kolla om ägaren redan finns
            const ownerRegex = new RegExp(`${name}:\\s*([\\s\\S]*?)(?=\\n\\s{4}\\S|\\n\\S|$)`, 'i');
            const ownerMatch = knownPlatesContent.match(ownerRegex);

            if (ownerMatch) {
                // Lägg till i befintlig ägare
                const updatedOwner = ownerMatch[0].trimEnd() + `\n      - ${cleanPlate}\n      - ${spacedPlate}`;
                content = content.replace(ownerMatch[0], updatedOwner);
            } else {
                // Skapa ny ägare
                const newEntry = `    ${name}:\n      - ${cleanPlate}\n      - ${spacedPlate}\n`;
                content = content.replace('known_plates:', `known_plates:\n${newEntry}`);
            }

            fs.writeFileSync(frigateConfigPath, content, 'utf8');
            logToWindow(`[FRIGATE-LPR] Tillagt: ${name} (${cleanPlate}) i config.yml`, 'info');
            return { success: true };
        } else {
            return { success: false, error: 'Kunde inte hitta known_plates i config.yml' };
        }
    } catch (e) {
        console.error("Frigate-LPR update failed:", e);
        return { success: false, error: e.message };
    }
});

ipcMain.handle('update-double-take-alias', async (event, { name, match }) => {
    const yamlPath = 'c:/Users/perss/Desktop/Frigate/config.yml';
    return { success: true }; // Placeholder since logic was moved to Frigate config
});

// --- MQTT BRYGGA FÖR FRIGATE ---

const mqttHost = 'localhost';
const mqttClient = mqtt.connect(`mqtt://${mqttHost}:1883`);
const processedEvents = new Map();

// --- HJÄLPFUNKTION: IDENTITETS-TOLK (HITTAS I EN FIL) ---
// --- HJÄLPFUNKTION: HÄMTA SENASTE SUB-LABEL FRÅN FRIGATE ---
function fetchLatestSubLabel(eventId, callback) {
    const url = `http://localhost:5050/api/events/${eventId}`;
    http.get(url, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
            try {
                const event = JSON.parse(data);
                callback(event?.sub_label || null);
            } catch (e) { callback(null); }
        });
    }).on('error', () => callback(null));
}

function resolveIdentity(rawId) {
    if (!rawId || rawId === "unknown" || rawId === "Okänd") return "Okänd";
    return rawId; // Returera originalet - JARVIS litar nu blint på AI:ns identifiering.
}

mqttClient.on('connect', () => {
    frigateConnected = true;
    logToWindow("❤️ SYSTEM-LINK: SAMMANKOPPLING AKTIV", 'info');
    logToWindow("❤️ RIDDAR-PROTOKOLLET: JARVIS ÄR NU GENUINT BLIND", 'info');
    mqttClient.subscribe('frigate/reviews');
});

mqttClient.on('offline', () => {
    frigateConnected = false;
    logToWindow("📡 MQTT-STATUS: Offline. Försöker återansluta...", 'warn');
});

mqttClient.on('close', () => {
    frigateConnected = false;
});

mqttClient.on('message', (topic, message) => {
    if (topic === 'frigate/reviews') {
        try {
            const review = JSON.parse(message.toString());
            const data = review.after || review; 
            const objId = data.id;
            const cam = data.camera;
            const eventKey = `${cam}_${objId}`;
            
            if (!processedEvents.has(eventKey)) {
                processedEvents.set(eventKey, true);
                setTimeout(() => processedEvents.delete(eventKey), 300000); 

                const eventId = data.data?.detections?.[0] || objId; 
                const label = data.data?.objects?.[0] || 'rörelse';

                // --- ÅTERSTÄLLD VÄNTELOGIK (1.5s + 5x1s loop) ---
                console.log(`[JARVIS-SYNC] Person upptäckt. Väntar 1.5s innan namn-loop startar...`);
                
                setTimeout(() => {
                    let attempts = 0;
                    const maxAttempts = 5;

                    const retryLoop = setInterval(() => {
                        attempts++;
                        fetchLatestSubLabel(objId, (currentSubLabel) => {
                            const identity = resolveIdentity(currentSubLabel || "Okänd");
                            console.log(`[JARVIS-SYNC] Försök ${attempts}/${maxAttempts}: Identitet = ${identity}`);

                            if (identity !== "Okänd" || attempts >= maxAttempts) {
                                clearInterval(retryLoop);
                                
                                const alarmText = identity === "Okänd" ? `En ${label} har upptäckts` : `${identity} (${label}) har setts`;
                                logToWindow(`[FRIGATE] ${alarmText} vid ${cam}`, 'info');

                                if (mainWindow && !mainWindow.isDestroyed()) {
                                    mainWindow.webContents.send('frigate-event', {
                                        id: eventId, 
                                        camera: cam,
                                        identity: identity,
                                        label: label,
                                        raw: review,
                                        alarmText: alarmText
                                    });
                                }
                            }
                        });
                    }, 1000);
                }, 1500);
            }
        } catch (e) {
            console.error("MQTT: Fel vid parsing av Frigate-review:", e);
        }
    }
});