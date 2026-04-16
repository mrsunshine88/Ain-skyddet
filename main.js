const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const os = require('os');
const net = require('net');
const { app, BrowserWindow, ipcMain, powerSaveBlocker } = require('electron');
const mqtt = require('mqtt');
const WebSocket = require('ws'); // Rensad Mirror-ström

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

        // Spara nuvarande storlek och anpassa till mobil (Adaptive Mirroring)
        originalBounds = mainWindow.getBounds();
        mainWindow.setSize(400, 850); 

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
                if (msg.type === 'input' && mainWindow) {
                    mainWindow.webContents.sendInputEvent({
                        type: msg.input.type,
                        x: Math.floor(msg.input.x),
                        y: Math.floor(msg.input.y),
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
            // Återställ fönstret (Auto-Restore)
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.setSize(originalBounds.width, originalBounds.height);
            }
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

ipcMain.handle('update-double-take-alias', async (event, { name, match }) => {
    const yamlPath = 'c:/Users/perss/Desktop/Frigate/config.yml';
    try {
        if (!fs.existsSync(yamlPath)) return { success: false, error: 'Double-Take config saknas' };
        
        // --- VIKTIGT: För bilar använder vi nu JARVIS egna 'brain.json' som master ---
        // Men för ansikten (Faces) kan vi fortfarande lägga till alias i Double-Take om det behövs
        let content = fs.readFileSync(yamlPath, 'utf8');
        const aliasEntry = `  - name: ${name}\n    match: ${match}`;
        
        if (content.includes(`match: ${match}`)) {
            return { success: true, message: 'Redan registrerad i Double-Take' };
        }

        // Lägg till alias i Double-Take config om det finns en alias-sektion
        if (content.includes('aliases:')) {
            content = content.replace('aliases:', `aliases:\n${aliasEntry}`);
            fs.writeFileSync(yamlPath, content, 'utf8');
        }

        logToWindow(`[BRIDGE] System-synk slutförd för ${name} (${match})`, 'info');
        return { success: true };
    } catch (e) {
        console.error("Brygga-fel:", e);
        return { success: false, error: e.message };
    }
});

// --- MQTT BRYGGA FÖR FRIGATE ---
const mqttHost = 'localhost';
const mqttClient = mqtt.connect(`mqtt://${mqttHost}:1883`);
const processedEvents = new Map();

// --- HJÄLPFUNKTION: IDENTITETS-TOLK (HITTAS I EN FIL) ---
function resolveIdentity(rawId) {
    if (!rawId || rawId === "unknown" || rawId === "Okänd") return "Okänd";
    
    try {
        const brainPath = path.join(__dirname, 'brain.json');
        if (fs.existsSync(brainPath)) {
            const brainData = JSON.parse(fs.readFileSync(brainPath, 'utf8'));
            const cleanId = rawId.toUpperCase().replace(/\s/g, '');
            
            // Kolla om det är en känd bil i registret
            if (brainData.vehicles) {
                for (const plate in brainData.vehicles) {
                    if (plate.toUpperCase().replace(/\s/g, '') === cleanId) {
                        const owner = brainData.vehicles[plate].owner || "Okänd";
                        return `${owner}s bil`;
                    }
                }
            }
        }
    } catch (e) {
        console.error("Kunde inte slå upp identitet i brain.json:", e);
    }
    
    return rawId; // Returera originalet om ingen match hittas
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
                // --- KORREKT ID FÖR FRIGATE 0.17 (Detection ID) ---
                const eventId = data.data?.detections?.[0] || objId; 
                const label = data.data?.objects?.[0] || 'rörelse';
                const subLabel = data.data?.sub_labels?.[0]; 
                
                const identity = resolveIdentity(subLabel || "Okänd");
                
                // --- LOGIK-FÖRBÄTTRING (Vem vs Vad) ---
                const alarmText = identity === "Okänd" ? `En ${label} har upptäckts` : `${identity} (${label}) har setts`;
                logToWindow(`[FRIGATE] ${alarmText} vid ${cam} (Event ID: ${eventId})`, 'info');
                
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

                processedEvents.set(eventKey, true);
                setTimeout(() => processedEvents.delete(eventKey), 300000); 
            }
        } catch (e) {
            console.error("MQTT: Fel vid parsing av Frigate-review:", e);
        }
    }
});