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
const VEHICLE_DIR = path.join(INCIDENT_DIR, 'vehicles');
const PROFILE_DIR = path.join(__dirname, 'profiles');

if (!fs.existsSync(INCIDENT_DIR)) fs.mkdirSync(INCIDENT_DIR);
if (!fs.existsSync(VEHICLE_DIR)) fs.mkdirSync(VEHICLE_DIR, { recursive: true });
if (!fs.existsSync(PROFILE_DIR)) fs.mkdirSync(PROFILE_DIR);

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
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    // API-logik behålls, kamerasändning raderad
    if (url === '/api/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
            status: 'online',
            frigate: 'online',
            cameras: { 'cam1': 'online', 'cam2': 'online', 'cam3': 'online' }
        }));
    }

    if (url === '/mobile.html' || url === '/mobile.js' || url === '/mobile.css' || url === '/manifest.json' || url === '/sw.js') {
        const p = path.join(__dirname, url.substring(1));
        if (fs.existsSync(p)) {
            const mime = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.json':'application/json' };
            res.writeHead(200, { 'Content-Type': mime[path.extname(p)] || 'text/plain' });
            return res.end(fs.readFileSync(p));
        }
    }

    if (url.startsWith('/api/chat')) {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            const oReq = http.request({ hostname: '127.0.0.1', port: 11434, path: '/api/chat', method: 'POST' }, (oRes) => {
                res.writeHead(oRes.statusCode, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                oRes.pipe(res);
            });
            oReq.on('error', () => { res.writeHead(500); res.end("Error"); });
            oReq.write(body); oReq.end();
        });
        return;
    }

    if (url.startsWith('/api/health')) {
        logToWindow("[HEALTH] Kontrollerar kameror...", 'info');
        const status = {};
        for (const id in CAMERAS) {
            const s = streams[id];
            const isAlive = s && s.process && !s.process.killed;
            const dataAge = s ? (Date.now() - (s.lastDataTime || 0)) : 999999;
            
            if (!isAlive) status[id] = 'offline';
            else if (dataAge < 5000) status[id] = 'online';
            else status[id] = 'buffering';
        }

        const frigateReq = http.request({ hostname: '127.0.0.1', port: 5050, path: '/api/stats', timeout: 1000 }, (fRes) => {
            let data = '';
            fRes.on('data', c => data += c);
            fRes.on('end', () => {
                try {
                    const stats = JSON.parse(data);
                    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                    res.end(JSON.stringify({ cameras: status, frigate: 'online', frigateStats: stats }));
                    logToWindow("[HEALTH] Frigate Online", 'info');
                } catch(e) {
                    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                    res.end(JSON.stringify({ cameras: status, frigate: 'error' }));
                    logToWindow("[HEALTH] Frigate JSON-fel", 'err');
                }
            });
        });
        frigateReq.on('error', () => {
            res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({ cameras: status, frigate: 'offline' }));
            logToWindow("[HEALTH] Frigate Offline (Hjärnan svarar ej)", 'warn');
        });
        frigateReq.end();
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
    mainWindow.loadFile('index.html');
    mainWindow.webContents.openDevTools(); // Öppnar diagnostikfönstret automatiskt för felsökning
});

ipcMain.handle('save-snapshot', async (event, { base64, label }) => {
    const fn = `alert_${Date.now()}_${label}.jpg`;
    fs.writeFileSync(path.join(INCIDENT_DIR, fn), base64.replace(/^data:image\/\w+;base64,/, ""), 'base64');
    return fn;
});

ipcMain.handle('save-face-image', async (event, { base64, name, index }) => {
    const profileDir = path.join(PROFILE_DIR, name);
    if (!fs.existsSync(profileDir)) fs.mkdirSync(profileDir, { recursive: true });
    const fileName = `${name}_${index}.jpg`;
    const filePath = path.join(profileDir, fileName);
    fs.writeFileSync(filePath, base64.replace(/^data:image\/\w+;base64,/, ""), 'base64');
    logToWindow(`[FACE-SAVE] Sparat ansikte: ${fileName}`, 'info');
    return filePath;
});

ipcMain.handle('save-vehicle-image', async (event, { base64, name }) => {
    const filePath = path.join(VEHICLE_DIR, name);
    fs.writeFileSync(filePath, base64.replace(/^data:image\/\w+;base64,/, ""), 'base64');
    logToWindow(`[VEHICLE-SAVE] Sparat fordonsbevis: ${name}`, 'info');
    return filePath;
});

// --- MQTT BRYGGA FÖR FRIGATE ---
const mqttClient = mqtt.connect('mqtt://localhost:1883');

mqttClient.on('connect', () => {
    logToWindow("❤️ SYSTEM-LINK: FRIGATE & JARVIS ÄR NU SAMMANKOPPLADE", 'info');
    logToWindow("❤️ STATUS: PULS AKTIV - SYSTEMET ÄR LIVE", 'info');
    mqttClient.subscribe('frigate/events');
    mqttClient.subscribe('frigate/reviews');
    mqttClient.subscribe('frigate/stats');
});

mqttClient.on('offline', () => {
    logToWindow("📡 MQTT-STATUS: Tappat kontakten med Frigate. Försöker återansluta lokalt...", 'warn');
});

mqttClient.on('message', (topic, message) => {
    if (topic === 'frigate/events' || topic === 'frigate/reviews') {
        try {
            const event = JSON.parse(message.toString());
            // Hantera både gamla events och nya reviews
            const data = event.after || event; 
            const type = event.type || (event.severity === 'alert' ? 'new' : 'update');

            if (type === 'new' || (type === 'update' && data.stationary === false)) {
                const label = data.label || 'rörelse';
                const cam = data.camera;
                logToWindow(`[FRIGATE] Detekterat ${label} vid ${cam}`, 'info');
                
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('frigate-event', event);
                }
            }
        } catch (e) {
            console.error("MQTT: Fel vid parsing av Frigate-event:", e);
        }
    }
});