import { Brain } from './brain.js';
import { Vision } from './vision.js';
import { AudioHandler } from './audio.js';
import { initSecurity } from './app_security.js';
import { initLogic } from './app_logic.js';

const { ipcRenderer } = window.require('electron');

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
        const res = await fetch('http://127.0.0.1:9999/api/health'); // Ändrat till 127.0.0.1 för högre stabilitet
        if (!res.ok) throw new Error("Health check failed");
        const data = await res.json();
        
        for (const camId in data.cameras) {
            const status = data.cameras[camId];
            const led = document.getElementById(`led-${camId}`);
            if (led) {
                led.className = `status-led status-${status}`;
            }
        }
        
        if (data.frigate !== 'online') {
            console.warn(`[FRIGATE] Status: ${data.frigate}`);
        }
    } catch (e) {
        console.error("[HEALTH] Kunde inte nå JARVIS-servern:", e);
        for (let i = 1; i <= 3; i++) {
            const led = document.getElementById(`led-cam${i}`);
            if (led) led.className = `status-led status-offline`;
        }
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
    setInterval(window.checkHealth, 3000); // Kolla hälsan var 3:e sekund

    console.log("Start-sekvens avslutad.");
    window.appendMessage('AI', "Återställd! Alla system är nu uppdelade och online.");
}

window.checkOllama = async () => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000); 

    try {
        const res = await fetch('http://127.0.0.1:11434/api/tags', { signal: controller.signal });
        clearTimeout(timeoutId);
        
        if (!res.ok) {
            const errorText = await res.text();
            console.warn(`[OLLAMA-CHECK] Servern svarade med felkod ${res.status}: ${errorText.substring(0, 50)}...`);
            throw new Error(`HTTP ${res.status}`);
        }
        
        const contentType = res.headers.get("content-type");
        if (!contentType || !contentType.includes("application/json")) {
            throw new Error("Svaret är inte JSON");
        }

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
        console.warn("[OLLAMA-CHECK] Kunde inte verifiera AI-status:", e.message);
        
        if (ui.pillText) {
            if (window.isThinking) {
                ui.pillText.innerText = "JARVIS (ARBETAR...)";
                ui.pillText.style.borderColor = "#eab308";
            } else {
                ui.pillText.innerText = "JARVIS (AUTO-LÄGE)";
                ui.pillText.style.borderColor = "#f43f5e";
            }
        }
    }
}
;

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
        
        // Öron för utekamerorna
        ui.extAuds.forEach((aud, idx) => {
            if (!aud) return;
            aud.onplay = () => {
                const ctx = new (window.AudioContext || window.webkitAudioContext)();
                const source = ctx.createMediaElementSource(aud);
                const analyser = ctx.createAnalyser();
                source.connect(analyser); source.connect(ctx.destination);
                if (!window.zoneAnalysers) window.zoneAnalysers = [];
                window.zoneAnalysers[idx] = { analyser, dataArray: new Uint8Array(analyser.frequencyBinCount) };
            };
        });

        if (ui.statusText) ui.statusText.innerText = "SENSORER: ONLINE";
        // window.startSecurityLoop(); // AVAKTIVERAD: Vi förlitar oss helt på Frigate för larm nu.
    } catch (e) {
        console.warn("Media init misslyckades:", e);
    }
}

window.appendMessage = (role, text, source = "") => {
    const div = document.createElement('div');
    div.className = `msg msg-${role.toLowerCase()}`;
    div.innerText = (role === 'User' && source === 'röst' ? "🎙️ " : "") + text;
    ui.chatMessages.appendChild(div);
    ui.chatMessages.scrollTop = ui.chatMessages.scrollHeight;
    
    if (window.supabase && role !== 'System') {
        window.supabase.from('chat_messages').insert({
            sender: role, content: text, recipient_name: window.activeUser?.name || 'Andreas'
        });
    }
    return div;
};

function accumulateSittingTime() {
    const now = Date.now();
    const deltaMs = now - (window.lastSittidAccumulation || now);
    window.lastSittidAccumulation = now;

    if (vision.activeUser === "Andreas" || (now - (window.presenceMemory?.["Andreas"] || 0) < 60000)) {
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

window.processLogin = async () => {
    const userCode = document.getElementById('loginUser').value;
    const passCode = document.getElementById('loginPass').value;
    if (userCode && passCode && window.supabase) {
        const { data } = await window.supabase.from('app_users').select('*').eq('username', userCode).eq('password', passCode).single();
        if (data) {
            localStorage.setItem('jarvis_session', JSON.stringify({ name: data.username, display_name: data.display_name, role: data.role }));
            location.reload();
        }
    }
};

// --- SMARTARE NOTISER - FRIGATE INTEGRATION ---
ipcRenderer.on('frigate-event', async (event, data) => {
    const after = data.after;
    if (!after || !after.id) return;

    const visionTargets = ["person", "car", "motorcycle", "dog", "cat"];
    const audioTargets = ["scream", "bark", "glass_break", "speech"];
    if (!visionTargets.includes(after.label) && !audioTargets.includes(after.label)) return;

    const alertKey = `mqtt_${after.id}`;
    if (window.lastAlerts[alertKey]) return;
    window.lastAlerts[alertKey] = true;
    setTimeout(() => { delete window.lastAlerts[alertKey]; }, 30000);

    console.log(`[FRIGATE-MQTT] Händelse: ${after.label} vid ${after.camera}`);

    // --- STEG 1: PANG-LARM (Omedelbar reflex med Zon-intelligens & Minne) ---
    const snap = await vision.getSnapshotFromFrigate(after.id);
    const knownName = after.label === 'person' ? await vision.recognizeFaceFromBase64(snap) : null;
    
    const soundMap = { "glass_break": "glaskross", "scream": "skrik", "bark": "hundskall", "speech": "tal", "person": "en person", "car": "ett fordon", "motorcycle": "en motorcykel", "dog": "ett djur", "cat": "ett djur" };
    let labelSwe = knownName || soundMap[after.label] || "aktivitet";
    
    // Zon-analys
    const zones = after.entered_zones || [];
    let zoneContext = "";
    if (after.camera === "Infarten") {
        if (zones.includes('uppfart')) zoneContext = "in på uppfarten";
        else if (zones.includes('vagen')) zoneContext = "förbi på gatan";
    }

    // Omedelbart röstmeddelande
    const place = zoneContext || `vid ${after.camera}`;
    const instantMsg = knownName ? `${knownName} är ${place}!` : `Larm! ${labelSwe} ${place}!`;
    
    // Gör larmet mindre "skrikigt" om det bara är på gatan
    const isQuietAlert = zones.includes('vagen') && !zones.includes('uppfart');
    const alertPrefix = isQuietAlert ? "ℹ️ [INFO]" : "⚡ [PANG-LARM]";

    window.appendMessage('System', `${alertPrefix}: ${instantMsg}`);
    audio.speak(instantMsg);

    // --- STEG 2: ASYNKRON ANALYS (Hjärnan jobbar i bakgrunden) ---
    (async () => {
        // Ljudhantering (STT)
        if (audioTargets.includes(after.label)) {
            if (after.label === "speech") {
                const camIdx = after.camera === "Ytterdorren" ? 0 : (after.camera === "Garaget" ? 2 : 1);
                const audioElem = ui.extAuds[camIdx];
                if (audioElem) {
                    const text = await audio.transcribeFromElement(audioElem, 7000);
                    if (text && text.length > 2) {
                        const report = `📢 [TJUVLYSSNING]: "${text}"`;
                        window.appendMessage('AI', report);
                        audio.speak(`De sa: ${text}`);
                    }
                }
            }
        }

        // Visuell analys (Kläder, färger, etc.)
        if (visionTargets.includes(after.label)) {
            const snap = await vision.getSnapshotFromFrigate(after.id);
            if (!snap) return;
            window.lastIntruderSnap = snap;

            // --- NYTT: Skicka med namnet om vi vet vem det är ---
            const targetLabel = knownName || after.label;
            const analysis = await vision.analyzeIntruder(snap, targetLabel, after.camera);
            
            // --- KRAFTFULL SANITERING (Tar bort eko och robot-taggar) ---
            let cleanDesc = analysis.description;
            if (cleanDesc.includes("Resultat:")) cleanDesc = cleanDesc.split("Resultat:").pop();
            
            // Rensa bort stjärnor, instruktioner och skräp
            cleanDesc = cleanDesc.replace(/\*/g, '')
                                .replace(/Uppgift:.*?word\./gi, '')
                                .replace(/Bilden är uppladdad.*?\./gi, '') // Specifik loop-fix
                                .trim();
            
            // --- LOOP-SKYDD: Ta bort upprepade meningar ---
            const sentences = cleanDesc.split('.');
            cleanDesc = [...new Set(sentences)].join('.').trim();

            // Kolla om vi fick ett giltigt svar
            if (cleanDesc && cleanDesc.length > 5) {
                const msgDiv = window.appendMessage('AI', `🚨 [BEVAKNING]: ${cleanDesc}`);
                
                // --- NYTT: Lägg till IDENTIFIERA-knapp ---
                const btn = document.createElement('button');
                btn.className = 'btn-outline';
                btn.style.marginTop = '8px';
                btn.style.fontSize = '9px';
                btn.innerText = '🏷️ NAMNGE OBJEKT';
                btn.onclick = () => window.openIdentifyModal(snap, after.label);
                msgDiv.appendChild(btn);

                audio.speak(cleanDesc);
                
                if (!window.incidents) window.incidents = [];
                window.incidents.push({ time: new Date().toLocaleTimeString(), detail: cleanDesc, snap: snap });
            }
        }
    })();
});



window.onload = init;
window.pendingIdentifySnap = null;
window.pendingIdentifyLabel = null;

window.openIdentifyModal = (snap, label) => {
    window.pendingIdentifySnap = snap;
    window.pendingIdentifyLabel = label;
    document.getElementById('identifySnap').src = snap;
    document.getElementById('identifyOverlay').style.display = 'flex';
    document.getElementById('identifyNameInput').value = '';
    document.getElementById('identifyNameInput').focus();
};

window.confirmIdentification = async () => {
    const name = document.getElementById('identifyNameInput').value.trim();
    if (!name || !window.pendingIdentifySnap) return;

    window.appendMessage('System', `⌛ Tränar JARVIS: Lägger till "${name}" i minnet...`);
    document.getElementById('identifyOverlay').style.display = 'none';

    try {
        const success = await vision.registerFaceFromBase64(name, window.pendingIdentifySnap);
        if (success) {
            window.appendMessage('AI', `✅ Klart! Jag kommer nu ihåg att detta är ${name}. Tack för hjälpen, Andreas.`);
        } else {
            window.appendMessage('System', `⚠️ Kunde inte spara i minnet. Kontrollera att bilden visar ett tydligt ansikte.`);
        }
    } catch (e) {
        console.error("Identifiering misslyckades:", e);
    }
};
