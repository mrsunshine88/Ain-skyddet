import { Brain } from './brain.js';
import { Vision } from './vision.js';
import { AudioHandler } from './audio.js';
import { initSecurity } from './app_security.js';
import { initLogic } from './app_logic.js';

// --- GLOBALA VARS ---
let brain, vision, audio;
let ui = {};

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

// --- INIT ---
async function init() {
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
    setInterval(window.internalThoughtLoop, 60000);
    setInterval(checkDreamState, 60000);
    setInterval(timeCheckLoop, 60000);
    setInterval(accumulateSittingTime, 10000);

    console.log("Start-sekvens avslutad.");
    window.appendMessage('AI', "Återställd! Alla system är nu uppdelade och online.");
}

window.checkOllama = async () => {
    try {
        console.log(`[HÄLSA] Kontrollerar AI-anslutning...`);
        const res = await fetch('http://127.0.0.1:11434/api/tags');
        if (!res.ok) throw new Error(`HTTP Error: ${res.status}`);
        
        const data = await res.json();
        const found = data.models.find(m => m.name.includes('llama3.2-vision')) || data.models[0];
        window.brainModel = found.name;
        
        if (ui.pillText) {
            ui.pillText.innerText = `JARVIS ONLINE (${window.brainModel.toUpperCase()})`;
            ui.pillText.style.display = 'block';
            ui.pillText.parentElement.style.borderColor = "#00f2ff";
            ui.pillText.parentElement.style.opacity = "1";
        }
    } catch (e) { 
        console.error("[HÄLSA] Ollama ej tillgänglig.");
        if (ui.pillText) {
            ui.pillText.innerText = "JARVIS (OFFLINE-LÄGE)";
            ui.pillText.style.display = 'block';
            ui.pillText.parentElement.style.borderColor = "#f43f5e";
        }
    }
};

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
        window.startSecurityLoop();
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

window.onload = init;
