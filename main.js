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


const FFMPEG_PATH = `C:\\Users\\perss\\Downloads\\ffmpeg-2026-04-09-git-d3d0b7a5ee-full_build\\ffmpeg-2026-04-09-git-d3d0b7a5ee-full_build\\bin\\ffmpeg.exe`;
const INCIDENT_DIR = path.join(__dirname, 'incidents');
const VEHICLE_DIR = path.join(INCIDENT_DIR, 'vehicles');
const PROFILE_DIR = path.join(__dirname, 'profiles');

if (!fs.existsSync(INCIDENT_DIR)) fs.mkdirSync(INCIDENT_DIR);
if (!fs.existsSync(VEHICLE_DIR)) fs.mkdirSync(VEHICLE_DIR, { recursive: true });
if (!fs.existsSync(PROFILE_DIR)) fs.mkdirSync(PROFILE_DIR);

const CAMERAS = {
    'cam1': { ip: '192.168.50.44', pass: '260889' },
    'cam2': { ip: '192.168.50.140', pass: '914176' },
    'cam3': { ip: '192.168.50.142', pass: '533493' }
};

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

const streams = {}; // camId -> { process: ChildProcess, listeners: Set<Response>, lastAttempt: number, lastDataTime: number }

function getStream(camId) {
    const now = Date.now();
    const s = streams[camId] || { listeners: new Set(), lastAttempt: 0 };
    streams[camId] = s;

    if (s.process && !s.process.killed) {
        return s;
    }
    
    // Förhindra "spawning loop" pga cooldown
    if (now - s.lastAttempt < 5000) {
        return null;
    }
    
    s.lastAttempt = now;
    logToWindow(`[${camId}] Ansluter till kamera...`, 'info');
    const cam = CAMERAS[camId];
    const rtspUrl = `rtsp://admin:${cam.pass}@${cam.ip}:554/live/profile.1`;
    
    const ff = spawn(FFMPEG_PATH, [
        '-rtsp_transport', 'tcp',
        '-i', rtspUrl,
        '-f', 'mpjpeg',
        '-q:v', '5',
        '-'
    ]);

    s.process = ff;

    ff.stdout.on('data', data => {
        s.lastDataTime = Date.now();
        for (const res of s.listeners) {
            try {
                res.write(data);
            } catch (e) {
                s.listeners.delete(res);
            }
        }
    });

    ff.on('exit', () => {
        logToWindow(`[${camId}] Kamera tappade anslutningen. Försöker igen om 5 sek...`, 'warn');
        s.process = null;
    });

    return s;
}

const server = http.createServer((req, res) => {
    const url = req.url;
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    const camId = url.substring(1).split('?')[0]; 
    if (CAMERAS[camId] && !url.includes('/audio/') && !url.startsWith('/api/')) {
        res.writeHead(200, {
            'Content-Type': 'multipart/x-mixed-replace; boundary=ffmpeg',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
        });

        const stream = getStream(camId);
        if (!stream) {
            res.writeHead(503);
            return res.end("Kameran startar om. Vänta...");
        }

        stream.listeners.add(res);

        req.on('close', () => {
            stream.listeners.delete(res);
            if (stream.listeners.size === 0 && stream.process) {
                logToWindow(`[${camId}] Inga tittare kvar, stänger ström.`, 'info');
                stream.process.kill();
            }
        });
        return;
    }

    if (url.includes('/audio/')) {
        const aId = url.split('/').pop();
        if (CAMERAS[aId]) {
            res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
            const ff = spawn(FFMPEG_PATH, [
                '-rtsp_transport', 'tcp',
                '-i', `rtsp://admin:${CAMERAS[aId].pass}@${CAMERAS[aId].ip}:554/live/profile.1`, 
                '-vn', '-acodec', 'libmp3lame', '-ab', '64k', '-f', 'mp3', '-'
            ]);
            ff.stdout.pipe(res);
            req.on('close', () => ff.kill());
            return;
        }
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
    powerSaveBlocker.start('prevent-app-suspension');
    mainWindow.loadFile('index.html');
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
    logToWindow("MQTT: Ansluten till mäklaren (localhost:1883)", 'info');
    mqttClient.subscribe('frigate/events');
});

mqttClient.on('message', (topic, message) => {
    if (topic === 'frigate/events') {
        try {
            const event = JSON.parse(message.toString());
            // Skicka bara vidare intressanta händelser (nya eller stora ändringar)
            if (event.type === 'new' || (event.type === 'update' && event.after.stationary === false)) {
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('frigate-event', event);
                }
            }
        } catch (e) {
            console.error("MQTT: Fel vid parsing av Frigate-event:", e);
        }
    }
});