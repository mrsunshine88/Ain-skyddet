import { Brain } from './brain.js';
import { Vision } from './vision.js';
import { AudioHandler } from './audio.js';
import { initSecurity } from './app_security.js';
import { initLogic } from './app_logic.js';

const { ipcRenderer } = window.require('electron');
window.ipcRenderer = ipcRenderer;

// --- GLOBALA VARS ---
let brain, vision, audio;
let ui = {};

window.isOllamaBusy = false;
window.isThinking = false;
window.activeTimers = [];
window.lastInteractionTime = Date.now();
window.lastThoughtTime = Date.now();
window.currentWindow = "Skrivbord";
window.incidents = []; 
window.lastSeenUsersArr = [];
window.lastDreamDate = null;
window.roomState = "Normal";
window.sessionStartTime = Date.now();
window.presenceMemory = { "Andreas": 0, "Sonen": 0 };
window.lastPresenceCheck = Date.now();
window.movementTracker = {};
window.brainModel = 'llama3.2-vision';
window.isHome = true;
window.isSleeping = false;
window.isLukasMode = false;
window.vaktMode = false;

window.checkHealth = async () => {
    try {
        const res = await fetch(`/api/health`); 
        if (!res.ok) throw new Error("Health check failed");
        const data = await res.json();
        
        // Uppdatera status-pillen
        const pillText = document.getElementById('pillText');
        if (pillText) {
            if (data.server === 'online') {
                pillText.innerText = data.frigate === 'online' ? "SYSTEMET LIVE" : "VÄNTAR PÅ FRIGATE...";
                pillText.parentElement.style.borderColor = data.frigate === 'online' ? "#00ff88" : "#ffcc00";
            }
        }

        for (const camId in data.cameras) {
            const status = data.cameras[camId];
            const led = document.getElementById(`led-${camId}`);
            if (led) led.className = `status-led status-${status}`;
        }
    } catch (e) {
        console.error("[HEALTH] Ingen kontakt med JARVIS-motor:", e);
        const pillText = document.getElementById('pillText');
        if (pillText) pillText.innerText = "SYSTEMET OFFLINE";
    }
};

// --- INIT ---
async function init() {
    if (window.jarvisInitialized) {
        console.log("[INIT] Systemet är redan aktivt. Avbryter dubbelinitiering.");
        return;
    }
    window.jarvisInitialized = true;
    console.log("JARVIS vaknar...");
    
    const session = JSON.parse(localStorage.getItem('jarvis_session'));
    if (session) {
        document.getElementById('loginOverlay').style.display = 'none';
        window.activeUser = session;
        console.log(`Välkommen tillbaka, ${session.display_name}`);
    }

    ui = {
        chatMessages: document.getElementById('chatMessages'),
        chatInput: document.getElementById('chatInput'),
        pillText: document.getElementById('pillText'),
        micStatus: document.getElementById('micStatus'),
        micBar: document.getElementById('micBar'),
        voiceBtn: document.getElementById('voiceBtn'),
        statusText: document.getElementById('statusText'),
        userBadge: document.getElementById('userBadge'),
        webcam: document.getElementById('webcam'),
        snapshot: document.getElementById('snapshot'),
        extCams: [
            document.getElementById('extCam1'),
            document.getElementById('extCam2'),
            document.getElementById('extCam3')
        ],
        extAuds: [
            document.getElementById('extAud1'),
            document.getElementById('extAud2'),
            document.getElementById('extAud3')
        ]
    };

    try {
        brain = new Brain();
        audio = new AudioHandler(); 
        vision = new Vision(ui.webcam, ui.snapshot, brain);
        
        // Initiera under-moduler
        initSecurity(ui, vision, audio, brain);
        initLogic(ui, brain, vision, audio);
        
        console.log("Systemkärna redo!");
    } catch (e) {
        console.error("Kritisk krasch under initiering:", e);
    }

    // Koppla UI-händelser
    if (ui.chatInput) {
        ui.chatInput.onkeypress = (e) => {
            if (e.key === 'Enter' && e.target.value) {
                window.askAI(e.target.value);
                e.target.value = '';
            }
        };

        const volSlider = document.getElementById('volSlider');
        window.jarvisVolume = 0.5;
        if (volSlider) {
            volSlider.oninput = (e) => {
                window.jarvisVolume = parseFloat(e.target.value);
            };
        }
    }

    // Bridge-funktioner för HTML-knappar
    window.toggleCameras = () => {
        const sec = document.getElementById('cameraSection');
        const btn = document.getElementById('btnCameras');
        sec.classList.toggle('single');
        sec.classList.toggle('grid');
        btn?.classList.toggle('active', sec.classList.contains('grid'));
    };

    setTimeout(() => {
        initMedia();
        window.checkOllama();

        // --- FORDONS-LOGIK (ALPR) ---
        const saveVehicleBtn = document.getElementById('saveVehicleBtn');
        if (saveVehicleBtn) {
            saveVehicleBtn.onclick = async () => {
                const owner = document.getElementById('vehicleOwnerInput').value.trim();
                const plate = document.getElementById('vehiclePlateInput').value.trim().toUpperCase();
                const snap = document.getElementById('vehicleSnap').src;
                
                if (owner && plate && snap) {
                    brain.registerVehicle(plate, { owner, hasImage: true });
                    const filename = `${owner}_${plate}.jpg`;
                    await ipcRenderer.invoke('save-vehicle-image', { base64: snap, name: filename });
                    window.appendMessage('AI', `✅ Klart! Fordonet ${plate} tillhör nu ${owner}. Bild sparad i 'profiles/Vehicles'.`);
                    audio.speak(`Uppfattat, Andreas. Jag har lagt till ${owner}s fordon i mitt arkiv.`);
                    window.sendTelegram(`[FORDON-REG] ${owner}s fordon (${plate}) har registrerats.`);
                    brain.saveBrain();
                }
            };
        }
    }, 800);

    audio.initSTT((status) => { 
        if (ui.micStatus) ui.micStatus.innerText = status;
    });

    // Starta loopar
    setInterval(updateDigitalContext, 10000);
    setInterval(window.internalThoughtLoop, 600000);
    setInterval(checkDreamState, 60000);
    setInterval(timeCheckLoop, 60000);
    setInterval(accumulateSittingTime, 10000);
    setInterval(window.checkHealth, 3000); 

    console.log("Start-sekvens avslutad.");
    window.appendMessage('AI', "Återställd! Alla system är nu uppdelade och online.");
}

window.checkOllama = async () => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000); 

    try {
        let host = '127.0.0.1';
        let res = await fetch(`http://${host}:11434/api/tags`, { signal: controller.signal }).catch(() => null);
        if (!res || !res.ok) {
            host = window.location.hostname || '127.0.0.1';
            res = await fetch(`http://${host}:11434/api/tags`, { signal: controller.signal });
        }
        clearTimeout(timeoutId);
        const data = await res.json();
        const found = data.models.find(m => m.name.includes('llama3.2-vision')) || data.models[0];
        window.brainModel = found.name;
        if (ui.pillText) {
            ui.pillText.innerText = `JARVIS ONLINE (${window.brainModel.toUpperCase()})`;
            ui.pillText.style.borderColor = "#00f2ff";
            ui.pillText.style.opacity = "1";
        }
    } catch (e) { 
        clearTimeout(timeoutId);
        if (ui.pillText) {
            ui.pillText.innerText = window.isThinking ? "JARVIS (ARBETAR...)" : "JARVIS (AUTO-LÄGE)";
            ui.pillText.style.borderColor = window.isThinking ? "#eab308" : "#f43f5e";
        }
    }
}

window.internalThoughtLoop = async () => {
    if (window.isThinking || !window.isHome) return;
    const thought = await brain.generateInternalThought({ window: window.currentWindow, user: vision.activeUser });
    if (thought) console.log(`[TANKAR] ${thought}`);
};

async function initMedia() {
    try {
        if (ui.pillText) ui.pillText.innerText = "LYSSNAR (MIKROFON)...";
        const audioStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
        audio.setupAudioProcessor(audioStream, {
            onLevel: (vol) => { if (ui.micBar) ui.micBar.style.width = Math.min(100, vol * 1000) + "%"; },
            onStop: () => { ui.voiceBtn.classList.remove('recording'); ui.micStatus.innerText = "Tolkar..."; },
            onText: (text) => { ui.micStatus.innerText = "Hörsel redo"; window.askAI(text, "röst"); }
        });
        if (ui.statusText) ui.statusText.innerText = "SENSORER: ONLINE";
    } catch (e) {
        console.warn("Media init misslyckades:", e);
    }
}

window.appendMessage = (role, text, source = "", targetCam = null) => {
    const div = document.createElement('div');
    div.className = `msg msg-${role.toLowerCase()}`;
    if (targetCam) {
        div.style.cursor = 'pointer';
        div.title = `Klicka för att se ${targetCam}`;
        div.onclick = () => window.focusCamera(targetCam);
    }
    const prefix = (role === 'User' && source === 'röst' ? "🎙️ " : "");
    div.innerText = prefix + text;
    ui.chatMessages.appendChild(div);
    ui.chatMessages.scrollTop = ui.chatMessages.scrollHeight;
    return div;
};

window.appendImage = (base64, camName = "Kamera") => {
    const div = document.createElement('div');
    div.className = `msg msg-ai`;
    div.style.padding = "5px";
    div.style.background = "var(--accent-dim)";
    div.style.border = "1px solid var(--accent)";
    
    const img = document.createElement('img');
    img.src = base64;
    img.style.width = "100%";
    img.style.borderRadius = "8px";
    img.style.display = "block";
    
    const label = document.createElement('div');
    label.innerText = `📸 SNAPSHOT: ${camName.toUpperCase()} [${new Date().toLocaleTimeString()}]`;
    label.style.fontSize = "9px";
    label.style.marginTop = "5px";
    label.style.textAlign = "center";
    label.style.fontWeight = "900";
    label.style.color = "var(--accent)";

    div.appendChild(img);
    div.appendChild(label);
    ui.chatMessages.appendChild(div);
    ui.chatMessages.scrollTop = ui.chatMessages.scrollHeight;
    return div;
};

function accumulateSittingTime() {
    const now = Date.now();
    const deltaMs = now - (window.lastSittidAccumulation || now);
    window.lastSittidAccumulation = now;
    if (vision.activeUser === "Andreas") {
        if (!brain.brainData.users["Andreas"]) brain.brainData.users["Andreas"] = { facts: [], sittingMinsToday: 0 };
        brain.brainData.users["Andreas"].sittingMinsToday = (brain.brainData.users["Andreas"].sittingMinsToday || 0) + (deltaMs / 60000);
        if (Math.floor(brain.brainData.users["Andreas"].sittingMinsToday) % 5 === 0) brain.saveBrain();
    }
}

async function updateDigitalContext() {
    const { exec } = require('child_process');
    exec('powershell -Command "Get-Process | Where-Object {$_.MainWindowTitle} | Select-Object -ExpandProperty MainWindowTitle -First 1"', (err, stdout) => {
        window.currentWindow = stdout?.trim() || "Skrivbord";
    });
}

function checkDreamState() {
    const now = new Date();
    if (now.getHours() === 3 && window.lastDreamDate !== now.toDateString()) {
        window.lastDreamDate = now.toDateString();
        brain.analyzeRoutines();
    }
}

function timeCheckLoop() {
    const sittingMins = Math.floor((Date.now() - window.sessionStartTime) / 60000);
    if (sittingMins > 0 && sittingMins % 120 === 0) window.askAI("(Andreas har suttit länge)", "time_reminder");
}

async function syncProfilesToAI() {
    window.appendMessage('System', '🛰️ JARVIS Aktiverad. Självlärande profilbevakning online.');
    try {
        const archive = await ipcRenderer.invoke('list-profiles');
        let total = 0;
        for (const name in archive) {
            for (const fn of archive[name]) {
                const b64 = await ipcRenderer.invoke('read-profile-image', { name, filename: fn });
                if (b64) {
                    await vision.registerFaceFromBase64(name, `data:image/jpeg;base64,${b64}`);
                    total++;
                }
            }
        }
        window.appendMessage('System', `✅ Synkronisering klar. ${total} ansikten inlärda.`);
    } catch (e) {
        console.error("Arkiv-synk misslyckades:", e);
    }
}

syncProfilesToAI();

// --- EVENT-HANTERARE: FRIGATE LOGIK ---
ipcRenderer.on('frigate-event', async (event, data) => {
    const after = data.after;
    if (!after || !after.id) return;
    
    // --- STRICKT PASSIVITET: Agera endast om Frigate har en bekräftad bild ---
    if (!after.has_snapshot) return;

    // Deduplicering
    if (!window.lastAlerts) window.lastAlerts = {};
    const alertKey = `${after.camera}_${after.id}_${after.label}`;
    if (window.lastAlerts[alertKey]) return; 
    window.lastAlerts[alertKey] = true;
    setTimeout(() => { delete window.lastAlerts[alertKey]; }, 60000);

    // Rörelse
    if (!window.lastSequence) window.lastSequence = { camera: '', time: 0 };
    const now = Date.now();
    let movementContext = (now - window.lastSequence.time < 45000) ? ` (Rör sig vidare från ${window.lastSequence.camera})` : "";
    window.lastSequence = { camera: after.camera, time: now };

    if (after.label === 'car' && after.stationary) return;
    const visionTargets = ["person", "car", "motorcycle", "dog", "cat"];
    if (!visionTargets.includes(after.label) && after.label !== "speech") return;

    (async () => {
        // --- FAS 1: HÄMTA BILD OCH IDENTITET ---
        let knownName = null;
        let snap = null;

        // 1. Försök hitta vem det är (sub_label) 
        const currentEvent = await vision.getEventData(after.id);
        if (currentEvent && currentEvent.sub_label && currentEvent.sub_label !== "unknown") {
            knownName = currentEvent.sub_label;
        }

        // 2. Hämta bilden (ENBART ETT FÖRSÖK - PASIVEN KRÄVER ATT DEN FINNS)
        snap = await vision.getSnapshotFromFrigate(after.id, true);
        if (!snap) snap = await vision.getSnapshotFromFrigate(after.id);

        // --- SPÄRR: Om ingen bild finns trots signal, avbryt allt (Hålla käft!) ---
        if (!snap) return;

        // --- FAS 2: ANNONSERING (Nu när vi vet att det är på riktigt) ---
        
        // Varning 1: Identitet (Enbart det som Frigate serverar)
        if (knownName && knownName !== "unknown") {
            ipcRenderer.send('log-identity', { name: knownName.toUpperCase(), camera: after.camera });
            window.appendMessage('System', `👤 Identifierad: ${knownName} vid ${after.camera}`);
            if (window.canSpeakNow()) audio.speak(`${knownName} vid ${after.camera}.`);
        } else {
            const labelMap = { "person": "Person", "car": "Bil", "motorcycle": "Motorcykel", "dog": "Hund", "cat": "Katt" };
            const labelSwe = labelMap[after.label] || after.label;
            window.appendMessage('System', `⚠️ Identifierad: Okänd ${labelSwe} vid ${after.camera}`);
            if (window.canSpeakNow()) audio.speak(`Okänd ${labelSwe} vid ${after.camera}.`);
        }

        // Varning 2: AI-Beskrivning
        if (visionTargets.includes(after.label)) {
            const analysis = await vision.analyzeIntruder(snap, after.label, knownName, after.camera, movementContext);
            if (analysis && analysis.description) {
                const timestamp = new Date().toLocaleString('sv-SE', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
                const header = `[BEVAKNING]: ${after.camera} (${timestamp})`;
                const msgDiv = window.appendMessage('AI', `🚨 ${header}\n${analysis.description}`, "", after.camera);
                if (window.canSpeakNow()) audio.speak(analysis.description);
                window.sendTelegramPhoto(`🚨 ${header}\n${analysis.description}`, snap);

                const btn = document.createElement('button');
                btn.className = 'btn-outline'; btn.style.fontSize = '9px';
                if (after.label === 'person') {
                    btn.innerText = '👤 NAMNGE';
                    btn.onclick = () => window.openIdentifyModal(after.id, after.label, snap);
                } else {
                    btn.innerText = '🚗 NAMNGE';
                    btn.onclick = () => window.openVehicleModal("", snap);
                }
                msgDiv.appendChild(btn);

                if (window.systemMode !== 'hemma') {
                    if (!window.eventBuffer) window.eventBuffer = [];
                    window.eventBuffer.push(`${new Date().toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' })}: ${analysis.description}`);
                }
            }
        }

        // Röstdetektering
        if (after.label === "speech") {
            const camIdx = after.camera === "Ytterdorren" ? 0 : (after.camera === "Garaget" ? 2 : 1);
            const audioElem = ui.extAuds[camIdx];
            if (audioElem) {
                const text = await audio.transcribeFromElement(audioElem, 7000);
                if (text && text.length > 2) {
                    window.appendMessage('AI', `📢 [TJUVLYSSNING]: "${text}"`);
                    audio.speak(`De sa: ${text}`);
                }
            }
        }
    })();
});

// --- SYSTEM-KOMMANDON ---
window.systemMode = 'hemma';
window.isLukasMode = false;
window.eventBuffer = [];

window.setSystemMode = (mode) => {
    if (window.setGuardMode) window.setGuardMode(mode);
    else window.systemMode = mode;
};

window.playBriefing = async () => {
    if (window.eventBuffer.length === 0) {
        audio.speak("Välkommen hem Andreas. Allt har varit lugnt."); return;
    }
    const prompt = `Sammanfatta händelserna kort på svenska: ${window.eventBuffer.join("\n")}. Max 40 ord.`;
    window.appendMessage('System', "⌛ JARVIS sammanställer briefing...");
    try {
        const res = await fetch(`http://127.0.0.1:11434/api/generate`, {
            method: 'POST', body: JSON.stringify({ model: 'llama3.2-vision', prompt, stream: false })
        });
        const data = await res.json();
        window.appendMessage('AI', `📋 BRIEFING: ${data.response}`);
        audio.speak(data.response);
    } catch (e) { audio.speak("Välkommen hem. Jag har registrerat några händelser."); }
    window.eventBuffer = [];
};

window.focusCamera = (cam) => console.log(`[UI] Fokus: ${cam}`);
window.canSpeakNow = () => window.isLukasMode || window.systemMode === 'hemma';
window.onload = init;

window.openIdentifyModal = async (eventId, label, snap) => {
    window.pendingIdentifySnap = snap;
    window.pendingIdentifyLabel = label;
    document.getElementById('identifySnap').src = snap;
    document.getElementById('identifyOverlay').style.display = 'flex';
    document.getElementById('identifyNameInput').focus();
};

window.confirmIdentification = async () => {
    const name = document.getElementById('identifyNameInput').value.trim();
    if (!name || !window.pendingIdentifySnap) return;
    document.getElementById('identifyOverlay').style.display = 'none';
    try {
        await vision.registerFaceFromBase64(name, window.pendingIdentifySnap);
        await ipcRenderer.invoke('save-face-image', { base64: window.pendingIdentifySnap, name: name, index: Date.now() });
        window.appendMessage('AI', `✅ Klart! Jag har lärt mig ${name}.`);
        audio.speak(`Jag vet hur ${name} ser ut nu.`);
    } catch (e) { console.error(e); }
};

window.openVehicleModal = (plate, snap) => {
    document.getElementById('vehicleSnap').src = snap;
    document.getElementById('vehiclePlateInput').value = plate || "";
    document.getElementById('vehicleModal').style.display = 'flex';
};
