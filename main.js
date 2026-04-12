const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const os = require('os');
const net = require('net');
const { app, BrowserWindow, ipcMain, powerSaveBlocker } = require('electron');

const FFMPEG_PATH = `C:\\Users\\perss\\Downloads\\ffmpeg-2026-04-09-git-d3d0b7a5ee-full_build\\ffmpeg-2026-04-09-git-d3d0b7a5ee-full_build\\bin\\ffmpeg.exe`;
const INCIDENT_DIR = path.join(__dirname, 'incidents');
if (!fs.existsSync(INCIDENT_DIR)) fs.mkdirSync(INCIDENT_DIR);

const CAMERAS = {
    'cam1': { ip: '192.168.50.44', pass: '260889' },
    'cam2': { ip: '192.168.50.140', pass: '914176' },
    'cam3': { ip: '192.168.50.142', pass: '533493' }
};

// D-Link DCS-8627LH specifika RTSP-sökvägar!
const PATHS = ['/live/profile.0', '/live/profile.1', '/live/profile.2', '/video1.sdp', '/video2.sdp', '/video3.sdp'];

let mainWindow;

function logToWindow(msg, type = 'info') {
    console.log(`[${type.toUpperCase()}] ${msg}`);
    if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.executeJavaScript(`console.log("%c[SERVER-${type.toUpperCase()}] ${msg.replace(/"/g, "'")}", "color: ${type==='err'?'red':'#00ff00'}")`);
    }
}

function startStream(camId, res, req, pathIdx = 0) {
    const cam = CAMERAS[camId];
    if (pathIdx >= PATHS.length) {
        logToWindow(`${camId}: Kameran nekar åtkomst till alla D-Link sökvägar. Kolla om ONVIF är aktiverat i Mydlink-appen.`, 'err');
        return res.end();
    }

    const currentPath = PATHS[pathIdx];
    // D-Link kräver alltid 'admin' som username, och PIN-koden (som du angav) som password.
    const rtspUrl = `rtsp://admin:${cam.pass}@${cam.ip}:554${currentPath}`;
    
    logToWindow(`[${camId}] Ansluter till D-Link: ${currentPath} ...`, 'info');

    // Tillbaka till grundkommandot utan begränsningar för att låta D-link ansluta hur den vill
    const ff = spawn(FFMPEG_PATH, [
        '-i', rtspUrl,
        '-f', 'mpjpeg',
        '-q:v', '5',
        '-'
    ]);

    let hasResponded = false;

    ff.stdout.once('data', () => {
        hasResponded = true;
        logToWindow(`BINGO! Bilden rullar från D-Link på ${currentPath}!`, 'info');
        res.writeHead(200, {
            'Content-Type': 'multipart/x-mixed-replace; boundary=ffmpeg',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
        });
        ff.stdout.pipe(res);
    });

    ff.stderr.on('data', d => {
        const msg = d.toString();
        if ((msg.includes('Not Found') || msg.includes('401') || msg.includes('Invalid data') || msg.includes('404')) && !hasResponded) {
            ff.kill();
            startStream(camId, res, req, pathIdx + 1);
        }
    });

    req.on('close', () => ff.kill());
}

const server = http.createServer((req, res) => {
    const url = req.url;
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    const camId = url.substring(1).split('?')[0]; 
    if (CAMERAS[camId] && !url.includes('/audio/') && !url.includes('/api/')) {
        const cam = CAMERAS[camId];
        const socket = new net.Socket();
        socket.setTimeout(2000);
        socket.on('connect', () => { socket.destroy(); startStream(camId, res, req, 0); });
        socket.on('timeout', () => { logToWindow(`TIMEOUT: No pings from ${cam.ip}`, 'err'); res.writeHead(504); res.end(); });
        socket.on('error', () => { logToWindow(`NÄTVERKSFEL: ${cam.ip} offline`, 'err'); res.writeHead(503); res.end(); });
        socket.connect(554, cam.ip);
        return;
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
    if (url.includes('/audio/')) {
        const aId = url.split('/').pop();
        if (CAMERAS[aId]) {
            res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
            const ff = spawn(FFMPEG_PATH, ['-i', `rtsp://admin:${CAMERAS[aId].pass}@${CAMERAS[aId].ip}:554/live/profile.0`, '-vn', '-acodec', 'libmp3lame', '-ab', '64k', '-f', 'mp3', '-']);
            ff.stdout.pipe(res);
            req.on('close', () => ff.kill());
            return;
        }
    }
    if (url.startsWith('/api/incidents')) {
        const files = fs.readdirSync(INCIDENT_DIR).filter(f => f.endsWith('.jpg')).sort((a,b) => b.localeCompare(a)).slice(0,20);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(files));
        return;
    }
    res.writeHead(404); res.end("Not Found");
});

server.listen(9999, '0.0.0.0', async () => {
    console.log("JARVIS SERVER REDO: 0.0.0.0:9999");
    
    // --- NYTT: STARTA SÄKER HTTPS-TUNNEL ---
    try {
        const localtunnel = require('localtunnel');
        const randid = Math.floor(Math.random() * 90000) + 10000;
        const tunnel = await localtunnel({ port: 9999, subdomain: 'jarvis-vakt-' + randid });
        
        console.log("");
        console.log("==================================================");
        console.log("📱 JARVIS MOBILÅTKOMST (KLAR FÖR PWA/LARM):");
        console.log(`-> ${tunnel.url}`);
        console.log("==================================================");
        console.log("");
        
        tunnel.on('close', () => {
            console.log("Tunneln stängdes.");
        });
    } catch (e) {
        console.error("Kunde inte starta säker HTTPS-tunnel:", e);
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
            backgroundThrottling: false // Fixar "hjärnsläpp" vid inaktivitet
        } 
    });
    
    // Förhindra att Windows försätter appen/systemet i viloläge
    const id = powerSaveBlocker.start('prevent-app-suspension');
    console.log(`POWERSAVE BLOCKER AKTIV: ID ${id}`);

    mainWindow.loadFile('index.html');
    mainWindow.webContents.openDevTools();
});

ipcMain.handle('save-snapshot', async (event, { base64, label }) => {
    const fn = `alert_${Date.now()}_${label}.jpg`;
    fs.writeFileSync(path.join(INCIDENT_DIR, fn), base64.replace(/^data:image\/\w+;base64,/, ""), 'base64');
    return fn;
});

ipcMain.handle('save-face-image', async (event, { base64, name, index }) => {
    const profileDir = path.join(__dirname, 'profiles', name);
    if (!fs.existsSync(profileDir)) fs.mkdirSync(profileDir, { recursive: true });
    
    const fileName = `${name}_${index}.jpg`;
    const filePath = path.join(profileDir, fileName);
    
    fs.writeFileSync(filePath, base64.replace(/^data:image\/\w+;base64,/, ""), 'base64');
    logToWindow(`[FACE-SAVE] Sparade fysisk bild: ${fileName} i profiles/${name}`, 'info');
    return filePath;
});