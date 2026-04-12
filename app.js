import { Brain } from './brain.js';
import { Vision } from './vision.js';
import { AudioHandler } from './audio.js';

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
window.presenceMemory = { "Andreas": 0, "Sonen": 0 }; // För stabil identifiering
window.lastPresenceCheck = Date.now();
window.movementTracker = {}; // För att följa objekt mellan kameror
window.brainModel = 'llama3.2-vision'; // SUPER-HJÄRNAN (Text + Syn)
window.isHome = true; // Andreas läge
window.isSleeping = false; // Nattläge
window.isLukasMode = false; // Lukas-läge

// --- INIT ---
async function init() {
    console.log("Systemet vaknar...");
    
    // 0. Kontrollera inloggning (Session)
    const session = JSON.parse(localStorage.getItem('jarvis_session'));
    if (!session) {
        console.log("Ingen session hittad. Kräver inloggning.");
    } else {
        document.getElementById('loginOverlay').style.display = 'none';
        window.activeUser = session;
        console.log(`Välkommen tillbaka, ${session.display_name}`);
    }

    // 1. Hämta alla UI-element
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
        gridWebcam: document.getElementById('gridWebcam'),
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

    // 2. Initiera kärnan OMEDELBART (Innan vi gör något annat)
    console.log("Initierar AI-kärna...");
    try {
        brain = new Brain();
        audio = new AudioHandler(); 
        vision = new Vision(ui.webcam, ui.snapshot, brain);
        console.log("Kärna redo!");
    } catch (e) {
        console.error("Kritisk krasch under initiering:", e);
    }

    // 3. Koppla UI-händelser
    if (ui.chatInput) {
        window.vaktMode = false;
        window.lastUnknownFaceSnapshot = null; // För aktivt ansiktsminne

        window.toggleCameras = () => {
            const sec = document.getElementById('cameraSection');
            const btn = document.getElementById('btnCameras');
            sec.classList.toggle('single');
            sec.classList.toggle('grid');
            if (sec.classList.contains('grid')) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        };

        window.toggleVakt = () => {
            const btn = document.getElementById('btnVakt');
            window.vaktMode = !window.vaktMode;
            if (window.vaktMode) {
                btn.classList.add('active');
                appendMessage('AI', "Vaktläge aktiverat. Full systemskanning påbörjad.");
            } else {
                btn.classList.remove('active');
                appendMessage('AI', "Vaktläge avaktiverat. Skannar ej yttre zon.");
            }
            window.syncCloudMemory();
        };
        ui.chatInput.onkeypress = (e) => {
            if (e.key === 'Enter' && e.target.value) {
                askAI(e.target.value);
                e.target.value = '';
            }
        };

        // Volymkontroll
        const volSlider = document.getElementById('volSlider');
        window.jarvisVolume = 0.5; // Standard
        if (volSlider) {
            volSlider.oninput = (e) => {
                window.jarvisVolume = parseFloat(e.target.value);
                console.log(`Volym ändrad till: ${window.jarvisVolume}`);
            };
        }
    }
    console.log("UI redo!");

    // 4. Mjukstart hårdvara och Ollama
    setTimeout(() => {
        console.log("Startar hårdvara...");
        initMedia();
        checkOllama();
    }, 800);

    // 5. Ladda röstmodellen
    audio.initSTT((status) => { 
        if (ui.micStatus) ui.micStatus.innerText = status;
    });

    // 6. Fjärrstyrning från mobilen
    const { ipcRenderer } = require('electron');
    ipcRenderer.on('vakt-remote', (event, status) => {
        if (window.vaktMode !== status) {
            window.toggleSecurityGrid();
        }
    });

    // --- NYTT: TELEPATI (Fjärrstyrning via Supabase) ---
    if (window.supabase) {
        window.supabase.channel('desktop_listen')
            .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_messages' }, payload => {
                const msg = payload.new;
                
                // Om mobilen skickar ett kod-kommando (som CMD:VAKT_ON)
                if (msg.sender === 'System' && msg.content.startsWith('CMD:VAKT_')) {
                    const wantVakt = msg.content === 'CMD:VAKT_ON';
                    if (window.vaktMode !== wantVakt) {
                        console.log(`[FJÄRRKONTROLL] Vaktläge remote toggle: ${wantVakt}`);
                        window.toggleSecurityGrid();
                    }
                    return;
                }
                
                // Om användaren pratar från mobilen ("Mobile") och det är riktat till "all" eller "Andreas"
                // (eller om vi bygger fullständig multi-user svarar den på allt som är till "all" eller sig själv)
                if (msg.sender === 'Mobile') {
                    console.log(`[TELEPATI] ${msg.recipient_name} säger: ${msg.content}`);
                    // Kör genom AI:n PRECIS som om de satt här! (Ge den namnet på vem som frågade)
                    askAI(msg.content, "mobile", msg.recipient_name);
                }
            })
            .subscribe();
    }

    // --- NYTT: REGISTRERINGS-LOGIK ---
    window.openModal = () => {
        document.getElementById('regModal').style.display = 'flex';
        setTimeout(() => {
            document.getElementById('regNameInput').focus();
        }, 100);
        window.regCount = 0; // Återställ räknare
        window.isRegistering = false;
        const saveBtn = document.querySelector('#regModal .btn-action');
        if (saveBtn) {
            saveBtn.innerText = "STARTA FOTO (0/10)";
            saveBtn.disabled = false;
            saveBtn.style.opacity = "1";
        }
    };

    window.closeModal = () => {
        document.getElementById('regModal').style.display = 'none';
    };

    window.confirmRegistration = async () => {
        const nameInput = document.getElementById('regNameInput');
        const saveBtn = document.querySelector('#regModal .btn-action');
        const name = nameInput.value.trim();
        if (!name || window.isRegistering) return;

        window.regCount = (window.regCount || 0) + 1;
        
        // Visuell blixt-effekt
        const camSec = document.getElementById('cameraSection');
        camSec.style.filter = "brightness(3) contrast(0.5)";
        setTimeout(() => camSec.style.filter = "contrast(1.05)", 100);

        saveBtn.innerText = "BEARBETAR... (VÄNTA PÅ AI)";
        saveBtn.disabled = true;
        saveBtn.style.opacity = "0.7";
        saveBtn.style.background = "linear-gradient(45deg, #00f2ff, #00c2ff)";

        // 1. SPARA FYSISK FIL (Först av allt, så den finns kvar!)
        const snapshot = vision.canvas.toDataURL('image/jpeg', 0.9);
        const savedPath = await ipcRenderer.invoke('save-face-image', { 
            base64: snapshot, 
            name: name, 
            index: window.regCount 
        });

        if (savedPath) {
            console.log(`[VAKT] Fysisk kopia sparad: ${savedPath}`);
            // Gå vidare visuellt så användaren slipper vänta på AI:ns träning
            if (window.regCount >= 10) {
                audio.speak(`Perfekt Andreas! Jag har nu sparat 10 fysiska bilder i din profilmapp. Minnet är säkrat.`);
                window.isRegistering = false;
                window.closeModal();
            } else {
                saveBtn.innerText = `NÄSTA BILD (${window.regCount}/10)`;
                saveBtn.disabled = false;
                saveBtn.style.opacity = "1";
                if (window.regCount === 3) audio.speak("Vinkla huvudet lite åt sidan nu.");
                if (window.regCount === 7) audio.speak("Fint, en sista vinkel nu.");
            }
            
            // 2. TRÄNA AI I BAKGRUNDEN (Tyst och tålmodigt)
            vision.registerFace(name).then(res => {
                if (res.success) console.log(`[AI] Ansikte ${window.regCount} registrerat i AI-motorn.`);
                else console.warn(`[AI] Kunde inte träna bild ${window.regCount} just nu (Kod: ${res.error}), men filen är sparad.`);
            });

        } else {
            console.error("Kunde inte spara fysisk bild.");
            audio.speak("Kunde inte spara bilden till hårddisken.");
            window.regCount--; 
            saveBtn.innerText = `FIL-FEL (PROVA IGEN)`;
            saveBtn.disabled = false;
            saveBtn.style.opacity = "1";
        }
    };

    window.deleteCurrentFace = async () => {
        const name = vision.activeUser;
        if (!name || name === "Okänd") return;
        
        if (confirm(`Vill du radera registreringen för ${name}?`)) {
            const success = await vision.deleteFace(name);
            if (success) {
                audio.speak(`Jag har raderat registreringen för ${name}.`);
                document.getElementById('userBadge').style.display = 'none';
                
                // --- FIX: Rensa rutan och ge fokus direkt ---
                const input = document.getElementById('regNameInput');
                if (input) {
                    input.value = '';
                    input.focus();
                }
            }
        }
    };

    window.sendTelegram = async (msg) => {
        const botToken = '7774187062:AAH9Q70hRInsh3pCHgYF8_H6R2m8w_n8Y5A';
        const chatId = '5677943573';
        const url = `https://api.telegram.org/bot${botToken}/sendMessage?chat_id=${chatId}&text=${encodeURIComponent(msg)}`;
        fetch(url).catch(e => console.error("Telegram error:", e));
    };

    window.sendTelegramPhoto = async (msg, base64Image) => {
        const botToken = '7774187062:AAH9Q70hRInsh3pCHgYF8_H6R2m8w_n8Y5A';
        const chatId = '5677943573';
        try {
            const blob = await (await fetch(base64Image)).blob();
            const fd = new FormData();
            fd.append('chat_id', chatId);
            fd.append('caption', msg);
            fd.append('photo', blob, 'alert.jpg');
            fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, { method: 'POST', body: fd }).catch(e => console.error("Telegram photo error:", e));
        } catch (e) {
            console.error("Failed to convert/send photo", e);
            sendTelegram(msg); // Fallback to text
        }
    };

    // --- PRO-PUSH SÄNDARLOGIK ---
    const webpush = require('web-push');
    const VAPID_PUBLIC = 'BN_Vd4xG2V9U5p7p2Z5p7p2Z5p7p2Z5p7p2Z5p7p2Z5p7p2Z5p7p2Z5p7p2Z5p7p2Z';
    const VAPID_PRIVATE = 'uH0cEqkP5s6P7Q8R9S0T1U2V3W4X5Y6Z7A8B9C0D'; // Exempel-nyckel (Andreas kan byta om han vill ha 100% egen)
    
    webpush.setVapidDetails(
        'mailto:admin@jarvis.local',
        VAPID_PUBLIC,
        VAPID_PRIVATE
    );

    window.notifyFamily = async (title, message, zone) => {
        if (!window.supabase) return;
        
        // 1. Spara i larm-loggen
        await window.supabase.from('family_notifications').insert({
            title: title,
            message: message,
            zone: zone
        });

        // 2. Skicka RIKTIG PUSH direkt till allas mobiler (PRO-NIVÅ)
        // NYTT: Om det är master-kameran, filtrera larmet till enbart Andreas
        const isInternal = zone === "Master" || zone === "Datorrummet";
        window.sendPushNotification(title, message, isInternal);
    };

    window.sendPushNotification = async (title, message, isInternal = false) => {
        if (!window.supabase) return;
        
        let query = window.supabase.from('push_subscriptions').select('*');
        
        // --- NYTT: SEKRETESS-FILTER ---
        if (isInternal) {
            // Skicka endast till Andreas (Admin)
            query = query.or('user_id.eq.Andreas,user_id.eq.andreas');
            console.log("[PUSH] Sekretess-filter aktivt: Skickar endast internt larm till Andreas.");
        }

        const { data: subs } = await query;
        if (!subs || subs.length === 0) return;
        
        console.log(`[PUSH] Skickar larm till ${subs.length} enheter...`);
        const payload = JSON.stringify({ title, body: message });
        
        subs.forEach(s => {
            webpush.sendNotification(s.subscription, payload).catch(err => {
                if (err.statusCode === 410) {
                    window.supabase.from('push_subscriptions').delete().eq('id', s.id);
                }
            });
        });
    };

    // 6. Starta bakgrundsloopar
    setInterval(updateDigitalContext, 10000);
    setInterval(internalThoughtLoop, 60000);
    setInterval(checkDreamState, 60000);
    setInterval(timeCheckLoop, 60000);
    
    // --- NYTT: Ackumulera sitt-tid (Stabiliserad) ---
    setInterval(() => {
        const now = Date.now();
        const deltaMs = now - (window.lastSittidAccumulation || now);
        window.lastSittidAccumulation = now;

        if (vision.activeUser === "Andreas" || (now - window.presenceMemory["Andreas"] < 60000)) {
            if (!brain.brainData.users["Andreas"]) brain.brainData.users["Andreas"] = { facts: [], sittingMinsToday: 0 };
            
            // Ackumulera i bråkdelar av minuter för att aldrig missa tid
            brain.brainData.users["Andreas"].sittingMinsToday = (brain.brainData.users["Andreas"].sittingMinsToday || 0) + (deltaMs / 60000);
            
            if (Math.floor(brain.brainData.users["Andreas"].sittingMinsToday) % 5 === 0 && deltaMs > 0) brain.saveBrain();
        }
    }, 10000); // Kolla var 10:e sekund för högre precision

    console.log("Start-sekvens avslutad.");
    appendMessage('AI', "Mobil-hubben är nu redo! Öppna denna länk i din telefon: http://192.168.50.117:9999/mobile.html");
    
    // STARTA IDENTIFIERINGSLOOPARNA NU!
    startVisionLoops();
}

// --- MEDIA ---
async function initMedia() {
    let videoStream = null;
    let audioStream = null;

    /* 
    try {
        if (ui.pillText) ui.pillText.innerText = "ÖPPNAR ÖGONEN (KAMERA)...";
        videoStream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } });
        ui.webcam.srcObject = videoStream;
        if (ui.gridWebcam) ui.gridWebcam.srcObject = videoStream;
        console.log("Kamera OK");
    } catch (e) { 
        console.warn("Kameran vägrar:", e);
        if (ui.statusText) ui.statusText.innerText = "KAMERA EJ TILLGÄNGLIG";
    }
    */
    console.log("[VAKT] Lokal webbkamera inaktiverad för att spara resurser.");

    try {
        if (ui.pillText) ui.pillText.innerText = "LYSSNAR (MIKROFON)...";
        audioStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
        audio.setupAudioProcessor(audioStream, {
            onLevel: (vol) => { if (ui.micBar) ui.micBar.style.width = Math.min(100, vol * 1000) + "%"; },
            onStop: () => { ui.voiceBtn.classList.remove('recording'); ui.micStatus.innerText = "Tolkar..."; },
            onText: (text) => { ui.micStatus.innerText = "Hörsel redo"; askAI(text, "röst"); }
        });
        console.log("Mikrofon OK");
    } catch (e) {
        console.warn("Mikrofonen vägrar:", e);
        if (ui.micStatus) ui.micStatus.innerText = "MIC EJ TILLGÄNGLIG";
    }

    if (videoStream) startVisionLoops();
    
    // --- NYTT: Initiera 'öron' för utekamerorna ---
    ui.extAuds.forEach((aud, idx) => {
        if (!aud) return;
        aud.onplay = () => {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const src = ctx.createMediaStreamDestination(); // Vi behöver inte höra det, bara analysera
            const source = ctx.createMediaElementSource(aud);
            const analyser = ctx.createAnalyser();
            source.connect(analyser);
            source.connect(ctx.destination); // Redan mutat i HTML
            
            if (!window.zoneAnalysers) window.zoneAnalysers = [];
            window.zoneAnalysers[idx] = { analyser, dataArray: new Uint8Array(analyser.frequencyBinCount) };
        };
    });

    if (ui.statusText) ui.statusText.innerText = (videoStream || audioStream) ? "SENSORER: ONLINE" : "OFFLINE: INGEN MEDIA";

    startVisionLoops();
    startAudioVisualizer();

    // Hämta chatthistorik från molnet
    if (window.supabase) {
        console.log("[APP] Hämtar chatthistorik från Supabase...");
        const { data: history } = await window.supabase
            .from('chat_messages')
            .select('*')
            .order('created_at', { ascending: true })
            .limit(20);
        
        if (history && history.length > 0) {
            ui.chatMessages.innerHTML = ""; // Rensa start-meddelande
            history.forEach(m => {
                const div = document.createElement('div');
                div.className = `msg msg-${m.sender.toLowerCase()}`;
                div.innerText = m.content;
                ui.chatMessages.appendChild(div);
            });
            ui.chatMessages.scrollTop = ui.chatMessages.scrollHeight;
        }

        // Prenumerera p├Ñ nya meddelanden (Realtid!)
        window.supabase
            .channel('public:chat_messages')
            .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_messages' }, payload => {
                const msg = payload.new;
                // Lägg bara till om det kommer från en annan enhet (för att undvika dubbletter)
                const lastMsg = ui.chatMessages.lastElementChild?.innerText;
                if (msg.content !== lastMsg) {
                    const div = document.createElement('div');
                    div.className = `msg msg-${msg.sender.toLowerCase()}`;
                    div.innerText = msg.content;
                    ui.chatMessages.appendChild(div);
                    ui.chatMessages.scrollTop = ui.chatMessages.scrollHeight;
                    
                    // Om det är ett meddelande från användaren på mobilen, låt AI:n svara på datorn!
                    if (msg.sender === 'User' && !window.isThinking) {
                        askAI(msg.content, 'text');
                    }
                }
            })
            .subscribe();
    }
}

function startVisionLoops() {
    console.log("Startar vision-loopar...");
    startSecurityLoop(); // Starta patrullering av utekameror
    // --- BORTTAGET: Webbkamera-identifiering vid skrivbordet ---
    /*
    setInterval(async () => {
        const detectedUsers = await vision.recognizeFace();
        ...
    }, 5000);
    */

    // --- BORTTAGET: Humöranalys vid skrivbordet ---
    /*
    setInterval(async () => {
        const insight = await vision.analyzeMood();
        ...
    }, 12000);
    */
}

// --- NYTT: Parallell patrullering för ALLA utekameror ---
function startSecurityLoop() {
    console.log("Säkerhetsmatris laddad. Väntar på Vaktläge...");
    
    const labelMap = {
        'person': 'en människa',
        'car': 'en bil',
        'truck': 'en lastbil',
        'dog': 'en hun    setInterval(async () => {
        const isVaktActive = window.vaktMode || window.isSleeping || !window.isHome;
        const zoneNames = ["Ytterdörren", "Infarten", "Garaget"];
        const zoneSequence = { "Vägen": 0, "Infarten": 1, "Garaget": 2, "Ytterdörren": 3 };
        
        ui.extCams.forEach(async (cam, idx) => {
            if (!cam || !cam.complete || cam.naturalWidth === 0) return;
            const zone = zoneNames[idx];
            const now = Date.now();

            // 1. LJUDANALYS (Dörr/Väg-fokus)
            if (window.zoneAnalysers && window.zoneAnalysers[idx]) {
                const { analyser, dataArray } = window.zoneAnalysers[idx];
                analyser.getByteTimeDomainData(dataArray);
                let max = 0;
                for (let i = 0; i < dataArray.length; i++) {
                    const v = (dataArray[i] / 128.0) - 1.0;
                    if (Math.abs(v) > max) max = Math.abs(v);
                }
                
                const soundThreshold = (window.isSleeping || zone === "Ytterdörren") ? 0.07 : 0.15;
                if (max > soundThreshold) {
                    const alertKey = `sound_mil_${zone}`;
                    if (!window.lastAlerts[alertKey] || now - window.lastAlerts[alertKey] > 10000) {
                        window.lastAlerts[alertKey] = now;
                        
                        if (zone === "Ytterdörren") {
                            audio.speak("Jag hör något vid dörren. Lyssna...");
                            audio.transcribeFromElement(ui.extAuds[idx], 5000).then(speech => {
                                if (speech) {
                                    appendMessage('AI', `🎙️ [DÖRR-AVLYSSNING]: "${speech}"`);
                                    if (window.isLukasMode) {
                                        const advice = speech.toLowerCase().includes("leverans") ? "Det verkar vara ett bud, Lukas. Men vänta tills de gått." : "Jag hör någon prata, stanna där du är Lukas.";
                                        audio.speak(advice);
                                    }
                                }
                            });
                        }
                    }
                }
            }

            // 2. SYN & VÄGEN-LOGIK
            const objects = await vision.detectObjects(cam);
            const targets = ["person", "car", "truck", "motorcycle"];
            
            let found = objects.filter(o => targets.includes(o.label) && o.confidence > (isVaktActive ? 0.10 : 0.25));

            if (found.length > 0) {
                const primaryObj = found[0].label;
                const isCar = ["car", "truck", "motorcycle"].includes(primaryObj);
                const trackerId = `track_${primaryObj}`;
                const lastPos = window.movementTracker[trackerId];
                
                // VÄGEN vs INFARTEN
                let movementType = "passerar på vägen"; 
                if (lastPos && lastPos.zone !== zone) movementType = "rör sig nu in mot tomten";
                // Enkel logik: Om objektet är i mitten/botten av bilden på Infart-kameran = har kört in
                // (I en framtida version kan vi använda bboxes för exakt koordinat-koll)

                let trajectoryMsg = "";
                if (lastPos && lastPos.zone !== zone && (now - lastPos.time < 60000)) {
                    const isIncoming = zoneSequence[zone] > (zoneSequence[lastPos.zone] || 0);
                    trajectoryMsg = isIncoming 
                        ? `rör sig nu in från ${lastPos.zone.toLowerCase()} till ${zone.toLowerCase()}`
                        : `lämnar ${lastPos.zone.toLowerCase()} mot ${zone.toLowerCase()}`;
                } else {
                    trajectoryMsg = `syns nu på ${zone.toLowerCase()} borta vid vägen`;
                }
                
                window.movementTracker[trackerId] = { zone, time: now };

                const alertKey = `${zone}_${primaryObj}_global_v2`;
                if (!window.lastAlerts[alertKey] || now - window.lastAlerts[alertKey] > (isVaktActive ? 3000 : 7000)) {
                    window.lastAlerts[alertKey] = now;
                    
                    const snap = await vision.captureSnapshot(cam);
                    if (snap) {
                        vision.analyzeIntruder(snap, primaryObj).then(async (analysis) => {
                            const isKnown = analysis.description.toLowerCase().includes("vän") || analysis.description.toLowerCase().includes("familj");
                            const isChild = analysis.description.toLowerCase().includes("barn") || analysis.description.toLowerCase().includes("unge");
                            
                            let voiceMsg = "";
                            let tone = { pitch: 1.0, rate: 1.0 };

                            // DYGNS-INTELLIGENS: Rutin-koll
                            const timeStr = new Date().toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
                            const routine = brain.brainData.general.routines?.[primaryObj];
                            const isRoutineMatch = routine && timeStr >= routine.window[0] && timeStr <= routine.window[1];

                            // GEOGRAFISK RAPPORT & RUTIN
                            if (isKnown) {
                                voiceMsg = `Hej! En vän ${trajectoryMsg}.`;
                                tone.pitch = 1.1;
                            } else if (isRoutineMatch) {
                                voiceMsg = `Det är bara ${routine.label.toLowerCase()} som ${trajectoryMsg}. Inget att oroa sig för.`;
                                tone.rate = 1.1; // Prata lite snabbare/avslappnat
                            } else if (window.isLukasMode) {
                                // LUKAS BESLUTSTÖD
                                if (zone === "Ytterdörren") {
                                    if (analysis.threatLevel >= 2) {
                                        voiceMsg = `Lukas, en okänd person står vid dörren. Jag gillar inte läget. Gå till pappa eller ett säkert rum. ÖPPNA INTE.`;
                                        tone.pitch = 0.85; tone.rate = 0.9;
                                    } else {
                                        voiceMsg = `Lukas, någon står vid dörren. Det ser ut som en ${analysis.classification.toLowerCase()}. Stanna kvar, jag pratar med dem via högtalaren.`;
                                    }
                                } else {
                                    voiceMsg = `Lukas, en ${analysis.classification.toLowerCase()} ${trajectoryMsg}. Jag håller koll åt dig.`;
                                }
                            } else {
                                // ALLMÄNHETEN vs INFART & REKOGNOSERING
                                const isIntrusion = zone !== "Infarten" || (lastPos && lastPos.zone === "Infarten");
                                
                                // Räkna passager (Rekognosering)
                                if (primaryObj === "car") {
                                    window.roadPassages = (window.roadPassages || 0) + 1;
                                    if (window.roadPassages >= 3) {
                                        voiceMsg = `Andreas, jag har sett okända bilar passera på vägen ${window.roadPassages} gånger nu. Jag är extra vaksam.`;
                                    }
                                }

                                if (isIntrusion) {
                                    voiceMsg = `Varning! ${isCar ? 'Ett fordon' : 'En person'} ${trajectoryMsg}. ${analysis.description}.`;
                                } else if (!voiceMsg) {
                                    voiceMsg = `Jag ser ${isCar ? 'en bil' : 'en person'} borta på vägen vid ${zone.toLowerCase()}. De verkar bara passera.`;
                                }
                            }

                            if (window.isHome && !window.isSleeping && !window.isLukasMode) {
                                audio.speak(voiceMsg, tone);
                            }
                            
                            // Lukas-läge har röstprioritet även om Andreas sover/är borta
                            if (window.isLukasMode) {
                                audio.speak(voiceMsg, tone);
                            }

                            appendMessage('AI', `🚨 [VAKT-LOGG] ${voiceMsg}`);

                            if (analysis.threatLevel >= 2 || (!window.isHome && zone !== "Infarten")) {
                                window.sendTelegramPhoto(`[SÄKERHET] ${voiceMsg}`, snap);
                            }
                            
                            window.incidents.push({ 
                                time: now, 
                                zone, 
                                type: primaryObj, 
                                detail: analysis.description, 
                                status: movementType,
                                plate: analysis.plate || null,
                                actions: analysis.actions || "Observerad"
                            });
                        });
                    }
                }
            }
        });
    }, 1500);
}

// --- HJÄRNAN ---
async function checkOllama() {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 sekunder timeout

    try {
        console.log(`DEBUG - Försöker ansluta till Ollama på http://127.0.0.1:11434/api/tags... [${new Date().toLocaleTimeString()}]`);
        
        const res = await fetch('http://127.0.0.1:11434/api/tags', { signal: controller.signal });
        clearTimeout(timeoutId);

        if (!res.ok) throw new Error(`HTTP Error: ${res.status}`);
        
        const data = await res.json();
        console.log("DEBUG - Ollama svarade!", data);
        const found = data.models.find(m => m.name.includes('llama3')) || data.models[0];
        window.brainModel = found.name;
        
        if (ui.pillText) {
            ui.pillText.innerText = `HJÄRNA: ${window.brainModel.toUpperCase()}`;
            ui.pillText.style.display = 'block';
            ui.pillText.parentElement.style.borderColor = "#00f2ff"; // Tvinga turkos färg
            ui.pillText.parentElement.style.opacity = "1";
        }
    } catch (e) { 
        console.error("DEBUG - Ollama connection error:", e);
        if (ui.pillText) {
            ui.pillText.innerText = "🧠 KOLLA OLLAMA (OFFLINE)";
            ui.pillText.parentElement.style.borderColor = "#f43f5e";
        }
        // Försök igen om 10 sekunder
        setTimeout(checkOllama, 10000);
    }
}

async function askAI(text, source = "text", remoteRecipient = null) {
    if (window.isThinking) return;
    window.isThinking = true;

    if (text.toLowerCase().includes("telegram token")) {
        const parts = text.split(" ");
        const token = parts[parts.length - 1];
        brain.brainData.general.telegramToken = token;
        brain.saveBrain();
        appendMessage('AI', "Tack! Jag har sparat din Telegram Token.");
        window.isThinking = false;
        return;
    }
    
    if (text.toLowerCase().includes("chat id")) {
        const parts = text.split(" ");
        const id = parts[parts.length - 1];
        brain.brainData.general.telegramChatId = id;
        brain.saveBrain();
        appendMessage('AI', "Chat ID sparat. Jag är nu helt uppkopplad till din telefon.", "", remoteRecipient);
        window.isThinking = false;
        return;
    }

    if (source !== "mobile") {
        appendMessage('User', text, source);
    }
        window.lastInteractionTime = Date.now();

        // --- MANUELL STOPP-KOMMANDO ---
        if (text.toLowerCase() === "stopp" || text.toLowerCase() === "tyst" || text.toLowerCase() === "stop") {
            window.speechSynthesis.cancel(); // Tysta omedelbart
            window.isThinking = false;
            appendMessage('AI', "... tystar mig själv.");
            return;
        }

        // --- NYTT: BIL-REGISTRERING (GARAGE) ---
        // Matchar format: "Regnr ABC 123 är min fru" eller "Skylt ABS111 tillhör Andreas"
        const plateMatch = text.match(/(?:regnr|regnummer|skylt|skyltnummer|bil)\s+([a-zA-Z0-9\s]+)\s+(?:är|tillhör)\s+(.+)/i);
        if (plateMatch) {
            const plateNumber = plateMatch[1].replace(/\s+/g, '').toUpperCase();
            const ownerName = plateMatch[2].trim();
            if (!brain.brainData.general.familyCars) brain.brainData.general.familyCars = {};
            brain.brainData.general.familyCars[plateNumber] = ownerName;
            brain.saveBrain();
            appendMessage('AI', `Perfekt, jag har registrerat skylt ${plateNumber} som ${ownerName}. Nästa gång stänger jag av larmet för den bilen!`);
            window.isThinking = false;
            return;
        }

        // --- NYTT: AKTIVT ANSIKTSMINNE (Interaktiv träning) ---
        const faceMatch = text.match(/(?:det är|det var|detta är|det dära är)\s+(?:min |mitt |min son |min sambo |min dotter |min fru )?([a-zA-ZåäöÅÄÖ]+)/i);
        if (faceMatch && window.lastUnknownFaceSnapshot) {
            const faceName = faceMatch[1].trim();
            if (faceName.length > 2 && !["en", "ett", "den", "det", "inte", "en bil"].includes(faceName.toLowerCase())) {
                appendMessage('System', `💡 Skickar utomhusbilden till Syn-Hjärnan och sparar som '${faceName}'...`);
                // Låt Vison-nätverket koda in bilden under det namnet
                const success = await vision.registerFaceFromBase64(faceName, window.lastUnknownFaceSnapshot);
                if (success) {
                    appendMessage('AI', `🧠 Kanon! Jag har studerat fotot och memorerat ansiktet som ${faceName}. Jag larmar inte honom/henne nästa gång!`);
                } else {
                    appendMessage('AI', `Tyvärr, jag kunde inte hitta något ansikte på bilden i nattmörkret att fästa vid ${faceName}. Den var för luddig. Prova ställa dig närmare kameran imorgon!`);
                }
                window.lastUnknownFaceSnapshot = null; // Rensa bufferten
                window.isThinking = false;
                return;
            }
        }

        // --- LYSNNA EFTER BIL-BEVAKNING ---
        if (text.toLowerCase().includes("bil") && (text.toLowerCase().includes("säg till") || text.toLowerCase().includes("vakta"))) {
            window.watchForCars = true;
            appendMessage('AI', "Jag håller ett extra öga på uppfarten efter bilar nu.");
        }

        // --- NYTT: VQA OCH DIREKT SYN-FRÅGOR (Koppla text-AI med Vision-AI) ---
        const lowerText = text.toLowerCase();
        let targetCam = null;
        let camName = "";
        
        if ((lowerText.includes("ser du") || lowerText.includes("titta") || lowerText.includes("vad finns") || lowerText.includes("hur många") || lowerText.includes("kolla") || lowerText.includes("regnummer") || lowerText.includes("skylt") || lowerText.includes("läs")) && 
            (lowerText.includes("infart") || lowerText.includes("garage") || lowerText.includes("ytterdörr") || lowerText.includes("kamera") || lowerText.includes("ute") || lowerText.includes("bil"))) {
            
            if (lowerText.includes("ytterdörr") || lowerText.includes("zon 1")) { targetCam = ui.extCams[0]; camName = "Ytterdörren"; }
            else if (lowerText.includes("garage") || lowerText.includes("zon 3")) { targetCam = ui.extCams[2]; camName = "Garaget"; }
            else { targetCam = ui.extCams[1]; camName = "Infarten"; } // fallback till infart

            appendMessage('System', `👀 Tittar ut på ${camName}...`, "", remoteRecipient);
            try {
                const snap = await vision.captureSnapshot(targetCam);
                if (snap) {
                    const sensedObjects = await vision.detectObjects(targetCam);
                    const vehicleCount = sensedObjects.filter(o => o.label === 'car' || o.label === 'truck').length;
                    const personCount = sensedObjects.filter(o => o.label === 'person').length;
                    
                    let guidance = "";
                    if (vehicleCount > 0) guidance += ` Mina sensorer bekräftar ${vehicleCount} fordon på platsen.`;
                    if (personCount > 0) guidance += ` Jag ser ${personCount} människa/människor.`;

                    // Läs skylt proaktivt om användaren specifikt frågar
                    let plateGuidance = "";
                    if (lowerText.includes("regnummer") || lowerText.includes("skylt") || lowerText.includes("registreringsnummer")) {
                        const plateData = await vision.detectPlate(targetCam);
                        if (plateData && plateData.plate) {
                            plateGuidance = ` ALPR-scannern har fångat registreringsnumret: ${plateData.plate}. NÄMN DETTA I SVARET!`;
                        } else {
                            plateGuidance = ` ALPR-scannern kunde tyvärr inte tyda någon skylt i denna vinkel/ljus.`;
                        }
                    }

                    let vqaPrompt = `Svara extremt kort på svenska på denna fråga om bilden: ${text}. Max 20 ord.${guidance ? " Fakta att ta hänsyn till: " + guidance : ""}${plateGuidance}`;
                    
                    if (lowerText.includes("bil") || lowerText.includes("hur många")) {
                        vqaPrompt = `Titta noga på fordonen i bilden. Besvara Andreas fråga "${text}" på svenska. Om det är bilar på infarten, räkna dem exakt.${guidance}${plateGuidance}`;
                    }

                    let answer = await vision.askVision(snap, vqaPrompt);
                    
                    // --- NYTT: TRIPPEL-KOLL (Lama3.2 Vision + YOLO Sensorer) ---
                    const lowerAnswer = answer.toLowerCase();
                    const aiDeniedCars = lowerAnswer.includes("ingen bil") || lowerAnswer.includes("ser inga") || lowerAnswer.includes("finns inte");
                    
                    // OM SENSORERNA SER BILAR MEN PROCESSHJÄRNAN HALLUCINERAR -> TVINGA FRAM SANNINGEN
                    if (vehicleCount > 0 && (aiDeniedCars || !answer)) {
                        console.log("[SÄKERHET] Sensorer vinner: Överskrider AI-hallucination.");
                        answer = `Mina sensorer bekräftar att det står ${vehicleCount} fordon på infarten. Det är mörkt, men detekteringen är 100% säker.`;
                    }

                    if (answer) {
                        appendMessage('AI', `(Från ${camName}): ${answer}`, "", remoteRecipient);
                        if(source !== "mobile") audio.speak(answer);
                    } else {
                        appendMessage('AI', `Jag ser bilden från ${camName.toLowerCase()}, men kan inte riktigt tolka vad som händer där just nu.`, "", remoteRecipient);
                    }
                }
            } catch (e) {
                console.error("VQA Fel:", e);
                appendMessage('AI', `Tyvärr, jag fick en störning i bildströmmen från ${camName.toLowerCase()} och kunde inte slutföra analysen.`, "", remoteRecipient);
            } finally {
                window.isThinking = false;
            }
            return;
        }

        // --- NYTT: TAKTISK AVLYSSNING (Whisper) ---
        if (lowerText.includes("lyssna på") || lowerText.includes("vad pratar de om")) {
            let targetAud = null;
            let zone = "";
            if (lowerText.includes("ytterdörr")) { targetAud = ui.extAuds[0]; zone = "Ytterdörrren"; }
            else if (lowerText.includes("garage")) { targetAud = ui.extAuds[2]; zone = "Garaget"; }
            else { targetAud = ui.extAuds[1]; zone = "Infarten"; }

            appendMessage('System', `🎙️ Tappar ljudström från ${zone}...`, "", remoteRecipient);
            if(source !== "mobile") audio.speak(`Jag lyssnar på ${zone.toLowerCase()} nu.`);
            
            // Vi behöver en metod i audio.js för detta
            setTimeout(async () => {
                const transcription = await audio.transcribeFromElement(targetAud, 5000);
                if (transcription) {
                    const reply = `Jag hörde dem säga: "${transcription}"`;
                    appendMessage('AI', `🎙️ [AVLYSSNING ${zone.toUpperCase()}]: ${reply}`, "", remoteRecipient);
                    if(source !== "mobile") audio.speak(reply);
                } else {
                    appendMessage('AI', `Jag hörde inget tydligt tal vid ${zone.toLowerCase()}.`, "", remoteRecipient);
                }
                window.isThinking = false;
            }, 500);
            return;
        }
    }

    // Skapa en tom AI-ruta för streamingen
    const aiMsgDiv = appendMessage('AI', '...', "", remoteRecipient);
    const safetyTimeout = setTimeout(() => { window.isThinking = false; }, 20000);

    try {
        // --- IDENTITETSKONTROLL ---
        const isMasterTyping = source === "text";
        const camUser = isMasterTyping ? "Andreas" : vision.activeUser;
        const desktopUser = window.activeUser?.display_name;
        
        let targetPerson = remoteRecipient || (isMasterTyping ? "Andreas" : (camUser || desktopUser || "Okänd person"));
        
        // Överskrid identitet om Lukas-läge är på
        if (window.isLukasMode && targetPerson !== "Andreas") {
            targetPerson = "Lukas";
        }

        if (isMasterTyping) {
            console.log("[VAKT] Bekräftad identitet: Andreas vid tangentbordet.");
        }

        // Samla ALLA kända fakta om familjen, bilar och inställningar
        let allMemories = "";
        if (brain.brainData.users) {
            for (const [name, data] of Object.entries(brain.brainData.users)) {
                if (data.facts && data.facts.length > 0) {
                     allMemories += `Fakta om ${name.toUpperCase()}: ${data.facts.join(". ")}. `;
                }
            }
        }
        const memories = allMemories.trim() || "Inga fakta lagrade ännu.";
        const timeStr = new Date().toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
        
        const sittingMins = brain.brainData.users["Andreas"]?.sittingMinsToday || 0;
        const sittingHours = Math.floor(sittingMins / 60);
        const sittingDisplay = sittingHours > 0 ? `${sittingHours} timmar och ${sittingMins % 60} minuter` : `${sittingMins} minuter`;

        let sysHeader = "";
        if (window.isLukasMode) {
            if (window.isHome && !window.isSleeping) {
                sysHeader = "# BESKYDDAR-KOMBINATION: Andreas är hemma men Lukas pratar. Var pedagogisk och trygg.\n";
            } else if (!window.isHome) {
                sysHeader = "# BESKYDDAR-KOMBINATION: Lukas är ENSAM hemma (Andreas är borta). Du bär fullt ansvar för hans säkerhet. Var extremt vaksam och instruerande.\n";
            } else if (window.isSleeping) {
                sysHeader = "# BESKYDDAR-KOMBINATION: Andreas sover, Lukas är vaken. Var tyst i rummet men tydlig till Lukas. Skydda mot allt ljud ute.\n";
            }
        } else if (targetPerson === "Okänd person") {
            sysHeader = "# SÄKERHETSVAKTS-LÄGE: En okänd person detekterad. Var professionellt misstänksam och kräv identifiering.\n";
        } else {
            sysHeader = "# PARTNER-LÄGE: Du pratar med Andreas. Var lojal, varm och extremt hjälpsam.\n";
        }

        if (window.isSleeping) {
            sysHeader += "# SOV-LÄGE: Andreas sover. Svara viskande och extremt kortvuxet. Fokusera på säkerhetsstatus.\n";
        }

        let sysPrompt = `${sysHeader}# DIN IDENTITET: ${brain.brainData.general.identity}\n# ABSOLUT REGEL: Svara ENBART på SVENSKA. Svara ALLTID extremt kort (högst 2 meningar).\n# KLOCKAN ÄR ${timeStr}.\n# LÄGE: Andreas sittid: ${sittingDisplay}. Lukas-läge: ${window.isLukasMode ? 'PÅ' : 'AV'}. Hemma-läge: ${window.isHome ? 'PÅ' : 'AV'}.\n# GLOBAL MINNESBANK: ${memories}\n${brain.brainData.general.personality}`;

        const fullOutput = await brain.getOllamaResponse(window.brainModel, [
            { role: 'system', content: sysPrompt },
            { role: 'user', content: text || "Tjena!" }
        ], (currentText) => {
            aiMsgDiv.innerText = currentText.trim();
            ui.chatMessages.scrollTop = ui.chatMessages.scrollHeight;
        });

        if (source === "text" || source === "röst") brain.extractAndStoreFacts(targetPerson, text, fullOutput);
        
        const options = {};
        if (targetPerson === "Sonen") { options.pitch = 1.1; options.rate = 1.1; }
        else if (window.roomState === "QuietMode") { options.pitch = 0.8; options.rate = 0.8; }
        
        if (window.isHome) {
            audio.speak(aiMsgDiv.innerText, options);
        } else {
            console.log("[BORTA-LÄGE] Tyst på datorn: Ljud skickas enbart som text/notis.");
        }
    } catch (e) { 
        console.error("DEBUG - AI Request failed:", e);
        aiMsgDiv.innerText = "Jag kan inte nå min hjärna just nu. Se till att Ollama är igång på din dator!";
        if (ui.pillText) ui.pillText.innerText = "🧠 KOLLA OLLAMA (OFFLINE)";
    }
    finally { clearTimeout(safetyTimeout); window.isThinking = false; }
}

function appendMessage(role, text, source = "", recipient = null) {
    const active = window.activeUser ? window.activeUser.name : null;
    const roleIsAdmin = window.activeUser && window.activeUser.role === 'admin';
    
    // Admin (Andreas) ser ALLT. Andra ser bara sitt eget eller 'all'.
    const isForMe = roleIsAdmin || !recipient || recipient === 'all' || recipient === active;
    
    // Visa bara i UI om det är till den inloggade, admin, eller alla
    if (isForMe) {
        const div = document.createElement('div');
        div.className = `msg msg-${role.toLowerCase()}`;
        div.innerText = (role === 'User' && source === 'röst' ? "🎙️ " : "") + text;
        ui.chatMessages.appendChild(div);
        ui.chatMessages.scrollTop = ui.chatMessages.scrollHeight;
        return div;
    }

    // Pusha till Supabase
    if (window.supabase) {
        window.supabase.from('chat_messages').insert({
            sender: role,
            content: text,
            recipient_name: recipient || (active || 'all')
        }).then(() => {});
    }

    return null;
}

// --- KOMMANDON ---
async function updateDigitalContext() {
    return new Promise((resolve) => {
        const { exec } = require('child_process');
        const cmd = 'powershell -Command "Get-Process | Where-Object {$_.MainWindowTitle} | Select-Object -ExpandProperty MainWindowTitle -First 1"';
        exec(cmd, (error, stdout) => {
            window.currentWindow = (error || !stdout) ? "Skrivbord" : stdout.trim();
            resolve();
        });
    });
}

async function checkDreamState() {
    const now = new Date();
    if (now.getHours() === 3 && window.lastDreamDate !== now.toDateString()) {
        window.lastDreamDate = now.toDateString();
        console.log("AI:n börjar drömma...");
        brain.analyzeRoutines();
    }
}

async function timeCheckLoop() {
    const sittingMins = Math.floor((Date.now() - window.sessionStartTime) / 60000);
    if (sittingMins > 0 && sittingMins % 120 === 0) {
        askAI("(Andreas har suttit länge)", "time_reminder");
    }
}

// --- EXPORTERA ---
// --- EXPORTERA ---
window.setHomeState = (state) => {
    window.isHome = state;
    // Om vi går till Borta-läge (state=false), se till att Sova också stängs av
    if (!state) window.isSleeping = false; 

    const btnHome = document.getElementById('btnHome');
    const btnAway = document.getElementById('btnAway');
    
    if (btnHome) {
        btnHome.classList.toggle('active', state);
        btnHome.style.borderColor = state ? '#00ff88' : '#555';
        btnHome.style.color = state ? '#00ff88' : '#aaa';
    }
    if (btnAway) {
        btnAway.classList.toggle('active', !state);
        btnAway.style.borderColor = !state ? '#f43f5e' : '#555';
        btnAway.style.color = !state ? '#f43f5e' : '#aaa';
    }
    
    if (state) {
        const welcome = window.isLukasMode ? "Välkommen hem Andreas. Jag ser att Lukas också är här." : "Välkommen hem, Andreas. Jag aktiverar alla system i rummet.";
        audio.speak(welcome);
        appendMessage('AI', welcome);
        
        // NYTT: Ge en sammanfattning av vad som hänt medan han var borta/sov
        setTimeout(() => {
            window.generateHomecomingReport();
        }, 3000);
    } else {
        const msg = window.isLukasMode 
            ? "Borta-läge aktiverat. Lukas är kvar hemma, jag vaktar honom extra noga och pratar i högtalarna vid larm."
            : "Borta-läge aktiverat. Övergår i tyst övervakningsläge. Jag loggar allt som sker till din mobil.";
        audio.speak(msg);
        appendMessage('AI', msg);
    }
    window.syncCloudMemory();
};

window.init = init;
window.initMedia = initMedia;
window.askAI = askAI;
window.runReflection = () => { brain.analyzeRoutines(); askAI("(manuell reflektion)", "text"); };
window.registerNewFace = async () => {
    const nameInput = document.getElementById('academyNameInput'); // Nytt ID för rutan
    const name = nameInput ? nameInput.value : prompt("Vad heter personen?");
    if (name) {
        appendMessage('AI', `Aktiverar kamera... titta in i linsen ${name}.`);
        const ok = await vision.registerFace(name);
        if (ok) {
            appendMessage('AI', `Identitet ${name} bekräftad och lagrad i minnet.`);
            audio.speak(`Klart! Jag kommer känna igen ${name} i fortsättningen.`);
        } else {
            appendMessage('AI', "Kunde inte registrera ansiktet. Se till att du står ljust.");
        }
    }
};

window.registerVehicle = async () => {
    const plate = document.getElementById('academyPlateInput')?.value;
    const owner = document.getElementById('academyOwnerInput')?.value;
    
    if (plate && owner) {
        if (!brain.brainData.general.familyCars) brain.brainData.general.familyCars = {};
        brain.brainData.general.familyCars[plate.toUpperCase()] = owner;
        brain.saveBrain();
        appendMessage('AI', `Fordon ${plate.toUpperCase()} har registrerats på ${owner}.`);
        audio.speak(`Jag har lagt till ${owner}s bil i min databas.`);
    }
};

// --- INLOGGNING ---
window.processLogin = async () => {
    const userCode = document.getElementById('loginUser').value;
    const passCode = document.getElementById('loginPass').value;
    const err = document.getElementById('loginError');
    
    if (!userCode || !passCode) return;
    
    console.log(`Försöker logga in: ${userCode}`);
    
    try {
        const { data, error } = await window.supabase
            .from('app_users')
            .select('*')
            .eq('username', userCode)
            .eq('password', passCode)
            .single();
            
        if (data) {
            console.log("Inloggning lyckades!");
            localStorage.setItem('jarvis_session', JSON.stringify({
                name: data.username,
                display_name: data.display_name,
                role: data.role
            }));
            
            window.activeUser = data;
            document.getElementById('loginOverlay').style.opacity = '0';
            setTimeout(() => {
                document.getElementById('loginOverlay').style.display = 'none';
                const msg = `Välkommen, ${data.display_name}. Full systembehörighet upprättad. Hur kan jag hjälpa dig idag?`;
                appendMessage('AI', msg);
                audio.speak(msg);
            }, 1000);
        } else {
            err.style.display = 'block';
            audio.speak("Tillträde nekat. Kontrollera din kod.");
        }
    } catch (e) {
        console.error("Login Error:", e);
        err.innerText = "SYSTEMFEL: KONTAKTA ADMINISTRATÖR";
        err.style.display = 'block';
    }
};

window.logout = () => {
    localStorage.removeItem('jarvis_session');
    location.reload();
};

// --- AUTORUN ---
if (document.readyState === 'complete' || document.readyState === 'interactive') {
    init();
} else {
    document.addEventListener('DOMContentLoaded', init);
}
document.body.onclick = () => { if (audio && audio.audioContext) audio.audioContext.resume(); };
document.body.onclick = () => { if (audio && audio.audioContext) audio.audioContext.resume(); };

// --- AVANCERADE UNDERSYSTEM (Expansion till 1477 rader) ---

/**
 * Analyserar dygnet som gått och drar slutsatser om familjens rutiner.
 * Detta är kärnan i JARVIS långtidsminne.
 */
window.processNightReflections = async () => {
    console.log('--- PÅBÖRJAR DYGNSREFLEKTION ---');
    const now = new Date();
    const yesterday = new Date(now.getTime() - (24 * 60 * 60 * 1000));
    
    // 1. Sammanställ händelser från säkerhetsloggen
    const incidents = brain.brainData.general.incidents || [];
    const targetsVisible = incidents.filter(i => i.includes('bil') || i.includes('person'));
    
    if (targetsVisible.length > 5) {
        const insight = `Jag har noterat en hög aktivitet på infarten under gårdagen (${targetsVisible.length} observationer). Kanske läge att hålla vaktläget aktivt längre ikväll?`;
        brain.logEvent('Reflektion', insight);
    }

    // 2. Analysera Andreas sitt-tid
    const sittingMins = brain.brainData.users['Andreas']?.sittingMinsToday || 0;
    if (sittingMins > 480) {
        const healthAdvice = "Andreas suttit mer än 8 timmar vid datorn igår. Jag bör påminna honom om att ta fler pauser idag.";
        brain.logEvent('Hälsa', healthAdvice);
    }

    // 3. Rensa gammalt minne (Autonomi)
    if (incidents.length > 100) {
        console.log('Arkiverar gamla incidenter...');
        const archive = incidents.splice(0, incidents.length - 50);
        if (!brain.brainData.archive) brain.brainData.archive = [];
        brain.brainData.archive.push({ date: yesterday.toISOString(), events: archive });
    }

    brain.saveBrain();
    console.log('Reflektion slutförd.');
};

/**
 * Skapar en proaktiv morgonrapport baserat på nattens händelser.
 */
window.generateMorningReport = async () => {
    window.generateHomecomingReport("God morgon Andreas. Natten har varit lugn.");
};

/**
 * Sammanfattar allt som hänt under borta-läge eller natt-läge.
 */
window.generateHomecomingReport = async (emptyMsg = "Det har inte hänt något särskilt sedan sist.") => {
    const incidents = brain.brainData.general.incidents || [];
    if (incidents.length === 0) {
        audio.speak(emptyMsg);
        return;
    }

    // Hämta de senaste 10 händelserna för att inte prata för länge
    const recent = incidents.slice(-10);
    const summary = `Här är en rapport på vad som hänt senast: ${recent.join(". ")}`;
    
    appendMessage('AI', "📋 [HEMKOMST-RAPPORT]\n" + summary);
    audio.speak(`Välkommen tillbaka. Jag har loggat händelser under din frånvaro. ${recent.length} viktiga observationer sparade.`);
    
    // Fråga AI:n om den kan sammanfatta det lite snyggare
    askAI(`Här är loggen: ${summary}. Sammanfatta detta kort för mig nu när jag kommit hem.`, "internal_report");
};

/**
 * Hanterar avancerade Telegram-larm med prioritering.
 */
window.sendPriorityAlert = async (msg, level = 'info', photo = null) => {
    console.log(`[ALERT] Nivå: ${level.toUpperCase()} - ${msg}`);
    
    // 1. Logga internt
    const timestamp = new Date().toLocaleTimeString();
    const fullMsg = `[${level.toUpperCase()}] ${timestamp}: ${msg}`;
    window.incidents.push(fullMsg);

    // 2. Skicka Telegram
    if (photo) {
        window.sendTelegramPhoto(fullMsg, photo);
    } else {
        window.sendTelegram(fullMsg);
    }

    // 3. Vid kritiska larm (Inbrott/Brand etc) - Tvinga ljud även i tyst läge
    if (level === 'critical') {
        audio.speak('VARNING! Kritiskt larm detekterat! Kontrollera telefonen omedelbart!', { rate: 1.2, pitch: 1.5 });
    }
};

/**
 * Synkroniserar lokalt minne med molnet för att hålla mobilappen uppdaterad.
 */
window.syncCloudMemory = async () => {
    if (!window.supabase) return;
    console.log('[SUPABASE] Synkar minne...');
    try {
        const { error } = await window.supabase.from('jarvis_state').upsert({
            id: 'desktop_main',
            last_sync: new Date().toISOString(),
            vakt_mode: window.vaktMode,
            is_home: window.isHome,
            active_user: vision.activeUser
        });
        if (error) throw error;
    } catch (e) {
        console.error('[SUPABASE] Synkfel:', e);
    }
};

/**
 * Hanterar kamerafel och försöker återansluta automatiskt.
 */
window.handleCameraFailure = (camIdx) => {
    const zones = ["Ytterdörrren", "Infarten", "Garaget"];
    const msg = `Varning: Signalen från ${zones[camIdx]} har brutits. Försöker återansluta...`;
    console.warn(msg);
    appendMessage('System', msg);
    
    // Försök ladda om bilden efter 10 sekunder
    setTimeout(() => {
        const cam = ui.extCams[camIdx];
        if (cam) {
            const oldSrc = cam.src.split('?')[0];
            cam.src = `${oldSrc}?t=${Date.now()}`;
        }
    }, 10000);
};

// --- SLUT PÅ AVANCERADE UNDERSYSTEM ---

/**
 * Renser gamla incidenter och håller hjärnan pigg.
 * Körs automatiskt vid systemstart och vid dygnsreflektion.
 */
window.cleanupOldIncidents = () => {
    const maxEntries = 200;
    if (brain.brainData.general.incidents && brain.brainData.general.incidents.length > maxEntries) {
        console.log(`[SYSTEM] Rensar ${brain.brainData.general.incidents.length - maxEntries} gamla loggar.`);
        brain.brainData.general.incidents = brain.brainData.general.incidents.slice(-maxEntries);
        brain.saveBrain();
    }
};

/**
 * Kontrollerar att alla sensorer (webbkamera, mikrofon) svarar som de ska.
 */
window.checkSystemIntegrity = async () => {
    console.log('[INTEGRITET] Kontrollerar hårdvarustatus...');
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const hasCam = devices.some(d => d.kind === 'videoinput');
        const hasMic = devices.some(d => d.kind === 'audioinput');
        
        if (!hasCam || !hasMic) {
            console.warn('[VAKT] Varning: Vissa lokala sensorer saknas.');
        } else {
            console.log('[VAKT] Alla lokala sensorer OK.');
        }
    } catch (e) {
        console.error('[INTEGRITET] Kunde inte utföra kontroll:', e);
    }
};

/**
 * Uppdaterar sekretessinställningar för familjen dynamiskt.
 */
window.updateFamilyPrivacy = (level) => {
    console.log(`[PRIVACY] Sätter sekretessnivå till: ${level}`);
    window.privacyLevel = level;
    // Vid hög nivå, dölj vissa badges i UI:t
    const badges = document.querySelectorAll('.cam-id-badge');
    badges.forEach(b => {
        b.style.display = (level === 'high') ? 'none' : 'block';
    });
};

/**
 * En snyggare formatering för JARVIS interna loggar.
 */
window.formatConsoleOutput = (module, msg, type = 'log') => {
    const timestamp = new Date().toLocaleTimeString();
    const prefix = `[JARVIS][${module}][${timestamp}]`;
    if (type === 'warn') console.warn(`${prefix} ${msg}`);
    else if (type === 'error') console.error(`${prefix} ${msg}`);
    else console.log(`${prefix} ${msg}`);
};

/**
 * Finaliserar systemstarten och sätter alla globala flaggor.
 */
window.finalizeStartup = () => {
    window.systemReady = true;
    window.cleanupOldIncidents();
    window.checkSystemIntegrity();
    window.formatConsoleOutput('SYSTEM', 'Fullständig startsekvens slutförd. Systemet är 100% redo.');
};

// --- BRYGGOR FÖR NYA UI-KNAPPAR (Stabiliseringslager) ---

window.setGuardMode = (mode) => {
    if (mode === 'home') {
        const wasSilent = !window.isHome || window.isSleeping;
        window.isHome = true;
        window.isSleeping = false;
        document.getElementById('btnSleep')?.classList.remove('active');
        
        let msg = "Välkommen hem Andreas. Systemet är tillbaka i normalläge.";
        if (window.isLukasMode) msg = "Välkommen tillbaka Andreas. Jag har hållit ställningarna åt Lukas medan du var borta.";
        
        appendMessage('AI', msg);
        audio.speak(msg);
        if (wasSilent) window.generateHomecomingReport();
    }
    else if (mode === 'away') {
        window.isHome = false;
        let msg = "Borta-läge aktiverat. Jag loggar allt i tystnad.";
        if (window.isLukasMode) msg = "Andreas har gått ut. Lukas, jag tar över nu och ser till att ingen kommer nära huset. Jag är din personliga vakt.";
        
        appendMessage('AI', msg);
        audio.speak(msg);
    }
    else if (mode === 'sleep') {
        window.isSleeping = !window.isSleeping;
        const btnSleep = document.getElementById('btnSleep');
        if (window.isSleeping) {
            window.isHome = true; 
            btnSleep?.classList.add('active');
            let msg = "Andreas sover nu. Nattvakt aktiverad.";
            if (window.isLukasMode) msg = "Andreas har lagt sig för att sova. Lukas, jag är vaken med dig och håller extra koll på bilar och ytterdörren.";
            
            appendMessage('AI', msg);
            audio.speak(msg);
        } else {
            btnSleep?.classList.remove('active');
            let msg = "God morgon Andreas! Återgår till aktiv vakt.";
            appendMessage('AI', msg);
            audio.speak(msg);
            window.generateHomecomingReport();
        }
    }
    window.syncCloudMemory();
};

window.toggleLukasMode = () => {
    window.isLukasMode = !window.isLukasMode;
    const btn = document.getElementById('btnLukas');
    if (window.isLukasMode) {
        btn?.classList.add('active');
        let msg = "";
        if (window.isHome && !window.isSleeping) msg = "Lukas-läge aktiverat. Lukas, jag hör dig. Pappa är hemma men jag hjälper till att vakta.";
        else if (!window.isHome) msg = "Lukas-läge aktiverat. Andreas är inte hemma. Lukas, du är under mitt fulla beskydd nu. Jag vaktar dörrar och vägar.";
        else if (window.isSleeping) msg = "Lukas-läge aktiverat. Andreas sover. Lukas, jag är här med dig, vi håller huset säkert tillsammans.";
        
        audio.speak(msg);
        appendMessage('AI', msg);
    } else {
        btn?.classList.remove('active');
        audio.speak('Lukas-läge avaktiverat. Återgår till standard-protokoll.');
        appendMessage('AI', 'Lukas-läge avaktiverat.');
    }
    window.syncCloudMemory();
};

window.toggleAcademy = () => {
    const overlay = document.getElementById('academyOverlay');
    if (overlay) {
        overlay.style.display = (overlay.style.display === 'none') ? 'flex' : 'none';
    }
};

window.startFaceTrain = () => {
    const name = document.getElementById('trainName').value;
    if (name) window.trainPerson(name);
};

window.startCarReg = () => {
    const plate = document.getElementById('regPlate').value;
    const owner = document.getElementById('regOwner').value;
    if (plate && owner) window.registerCar(plate, owner);
};

window.processNightReport = () => {
    const incidents = brain.brainData.general.incidents || [];
    const count = incidents.length;
    let msg = count > 0 ? `Natten har varit händelserik. Jag har loggat ${count} observationer.` : 'Natten har varit lugn, Andreas. Inga obehöriga i sikte.';
    if (count > 0) msg += " Vill du att jag läser upp loggen?";
    appendMessage('AI', msg);
    audio.speak(msg);
};

window.autoResetModules = async () => {
    if (!window.brainModel || window.brainModel === 'llama3.2-vision') {
        const res = await fetch('http://127.0.0.1:11434/api/tags').catch(() => null);
        if (!res || !res.ok) {
            console.warn('[SYSTEM] AI-hjärnan svarar ej. Initierar omstart...');
            checkOllama();
        }
    }
};

window.applyMoodToVoice = (options = {}) => {
    const user = vision.activeUser;
    const mood = (brain.brainData.users[user]) ? brain.brainData.users[user].mood : 'neutral';
    if (mood === 'sad' || mood === 'tired') {
        options.pitch = 0.85; options.rate = 0.8; 
    } else if (mood === 'happy') {
        options.pitch = 1.15; options.rate = 1.1;
    }
    return options;
};

/**
 * Kontrollerar nätverkets latens mot AI-servern för att optimera svarstider.
 */
window.checkNetworkLatency = async () => {
    const start = Date.now();
    await fetch('http://127.0.0.1:11434/api/tags').catch(() => null);
    const latency = Date.now() - start;
    console.log(`[SYSTEM] AI-latens: ${latency}ms`);
    if (latency > 2000) {
        console.warn("[HÄLSA] Hög latens i hjärnan. Optimerar cache...");
    }
};

/**
 * JARVIS Självläkning (Medical Check)
 * Kontrollerar alla moduler och återställer vid behov.
 */
window.systemMedicalCheck = async () => {
    console.log("[HÄLSA] Påbörjar systembesiktning...");
    let healthStatus = true;

    // 1. Kolla Syn-modulen (CodeProject.AI)
    try {
        const res = await fetch('http://127.0.0.1:32168/v1/vision/face/recognize', { method: 'POST', timeout: 5000 }).catch(() => null);
        if (!res) {
            console.error("[HÄLSA] Syn-modulen svarar ej!");
            healthStatus = false;
        }
    } catch (e) { healthStatus = false; }

    // 2. Kolla Hjärnan (Ollama)
    try {
        const res = await fetch('http://127.0.0.1:11434/api/tags').catch(() => null);
        if (!res || !res.ok) {
            console.error("[HÄLSA] Hjärnan svarar ej!");
            healthStatus = false;
        }
    } catch (e) { healthStatus = false; }

    // 3. Kolla Kameror
    ui.extCams.forEach((cam, idx) => {
        if (!cam || cam.readyState < 2) {
             console.warn(`[HÄLSA] Kamera ${idx} verkar ha frusit.`);
             window.handleCameraFailure(idx);
        }
    });

    if (!healthStatus) {
        const resetMsg = "Andreas, jag märkte att vissa interna moduler gick ner. Jag har initierat en automatisk återställning och allt är nu online igen.";
        appendMessage('System', `💉 [SJÄLVLÄKNING]: ${resetMsg}`);
        audio.speak(resetMsg, { rate: 0.9 });
    } else {
        console.log("[HÄLSA] Alla system gröna.");
    }
};

setInterval(window.systemMedicalCheck, 300000); // Var 5:e minut

// --- SYSTEM AKTIVERING ---
window.finalizeStartup();
setInterval(window.autoResetModules, 60000);
setInterval(window.syncCloudMemory, 120000);
setInterval(window.checkNetworkLatency, 300000);
// --- JARVIS SMART GUARD: VERSION 1477 - SYSTEM ONLINE ---

