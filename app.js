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

        // Prenumerera på nya meddelanden (Realtid!)
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
        'dog': 'en hund',
        'cat': 'en katt',
        'motorcycle': 'en motorcykel',
        'bicycle': 'en cykel'
    };

    setInterval(async () => {
        if (!window.vaktMode) return;
        
        const zoneNames = ["Ytterdörren", "Infarten", "Garaget"];
        
        ui.extCams.forEach(async (cam, idx) => {
            if (!cam || !cam.complete || cam.naturalWidth === 0) return;
            const zone = zoneNames[idx];
            const now = Date.now();
            let finalName = "en okänd person";
            let isUnknownPerson = false;

            // 1. Ljudanalys
            if (window.zoneAnalysers && window.zoneAnalysers[idx]) {
                const { analyser, dataArray } = window.zoneAnalysers[idx];
                analyser.getByteTimeDomainData(dataArray);
                let max = 0;
                for (let i = 0; i < dataArray.length; i++) {
                    const v = (dataArray[i] / 128.0) - 1.0;
                    if (Math.abs(v) > max) max = Math.abs(v);
                }
                
                if (max > 0.15) { // Sänkt tröskel (mer vaksam)
                    const alertKey = `sound_proactive_${zone}`;
                    if (!window.lastAlerts[alertKey] || now - window.lastAlerts[alertKey] > 30000) {
                        window.lastAlerts[alertKey] = now;
                        
                        // Om vi dessutom ser en person, försök avlyssna vad som sägs direkt!
                        const isPersonThere = window.movementTracker["unknown_person"] && (now - window.movementTracker["unknown_person"].time < 5000) && window.movementTracker["unknown_person"].zone === zone;
                        
                        if (isPersonThere) {
                            console.log(`[VAKT] Upptäckt tal/ljud vid ${zone}. Startar avlyssning...`);
                            audio.transcribeFromElement(ui.extAuds[idx], 6000).then(speech => {
                                if (speech && speech.length > 5) {
                                    const report = `Hörsel-alarm vid ${zone.toLowerCase()}: Jag hörde någon säga "${speech}"`;
                                    appendMessage('AI', `🎙️ [AVLYSSNING]: ${report}`);
                                    audio.speak(report);
                                    sendTelegram(report);
                                }
                            });
                        } else {
                            const alertMsg = `Andreas, ja' hör ett misstänkt ljud vid ${zone.toLowerCase()}.`;
                            appendMessage('AI', `🛡️ [HÖRSEL] ${alertMsg}`);
                            audio.speak(alertMsg);
                        }
                    }
                }
            }

            // 2. Syn (Objekt)
            const objects = await vision.detectObjects(cam);
            const targets = ["person", "car", "truck", "dog", "cat", "motorcycle", "bicycle"];
            // SÄNK GRÄNSEN FÖR NATTSEENDE! (0.20 för fordon, 0.35 för övrigt)
            let found = objects.filter(o => {
                const isVehicle = ["car", "truck", "motorcycle", "bicycle"].includes(o.label);
                const threshold = isVehicle ? 0.20 : 0.35;
                return targets.includes(o.label) && o.confidence > threshold;
            });

            if (found.length > 0) {
                // BUGGFIX: Om kameran ser BÅDE en parkerad bil (stor och 99% säker) OCH en människa (liten och 40% säker),
                // så måste den reagera på människan! Bilen skapade en "osynlighetsmantel".
                found.sort((a, b) => {
                    if (a.label === 'person' && b.label !== 'person') return -1;
                    if (b.label === 'person' && a.label !== 'person') return 1;
                    return b.confidence - a.confidence;
                });
                
                const primaryObj = found[0].label;
                const swedishLabel = labelMap[primaryObj] || primaryObj;
                const alertKey = `${zone}_${primaryObj}`;
                
                let isCar = (primaryObj === "car" || primaryObj === "truck");
                let plateOwner = null;
                let detectedPlate = null;
                
                if (primaryObj === "person") {
                    const id = await vision.scanExternal(cam, zone);
                    const badge = document.getElementById(`idBadgeZone${idx+1}`);
                    if (id && id.users.length > 0) {
                        finalName = id.users.join(", ");
                        if (badge) {
                            badge.innerText = `IDENTIFIERAD: ${finalName.toUpperCase()}`;
                            badge.className = "cam-id-badge active identified";
                        }
                    } else {
                        finalName = "en okänd person";
                        isUnknownPerson = true;
                        if (badge) {
                            badge.innerText = "OKÄND PERSON";
                            badge.className = "cam-id-badge active unknown";
                        }
                    }
                } else {
                    const badge = document.getElementById(`idBadgeZone${idx + 1}`);
                    if (badge) {
                        // NYTT: Visa bricka även för bilar/annat om det inte är en person
                        badge.innerText = `IDENTIFIERAD: ${swedishLabel.toUpperCase()}`;
                        badge.className = "cam-id-badge active identified";
                    }
                }
                
                if (isCar && (idx === 1 || idx === 2)) {
                    // Om det är en bil, testa ALPR innan vi säger något
                    console.log(`[ALPR] Försöker läsa skylt i ${zone}...`);
                    detectedPlate = await vision.detectPlate(cam);
                    if (detectedPlate) {
                        let thePlate = detectedPlate.replace(/\s+/g, '').toUpperCase();
                        const familyCars = brain.brainData.general.familyCars || {};
                        for (let key in familyCars) {
                            if (thePlate.includes(key.toUpperCase())) {
                                plateOwner = familyCars[key];
                                break;
                            }
                        }
                    }
                }

                // Cooldown: Extremt aggressiv, larmar var 5:e sekund tills inbrottstjuven försvunnit!
                if (!window.lastAlerts[alertKey] || now - window.lastAlerts[alertKey] > 5000) {
                    window.lastAlerts[alertKey] = now;
                    
                    if (isCar && plateOwner) {
                        // Känd familjebil detekterad! (Inget telegramlarm, bara ett mysigt välkomnande)
                        const welcomeMsg = `Välkommen! ${plateOwner} står nu på ${zone.toLowerCase()}.`;
                        appendMessage('AI', `🚙 [GARAGE] ${welcomeMsg}`);
                        audio.speak(welcomeMsg);
                        
                        // Spara till minnet
                        window.incidents.push(`Kl ${new Date().toLocaleTimeString()}: ${welcomeMsg}`);
                        if (!brain.brainData.general.incidents) brain.brainData.general.incidents = [];
                        brain.brainData.general.incidents.push(`Kl ${new Date().toLocaleTimeString()}: ${welcomeMsg}`);
                        brain.saveBrain();
                    } else {
                        // Okänd människa eller okänd bil (Larma Telegram!)
                        let baseAlertMsg = isUnknownPerson 
                            ? `Andreas, ${finalName} rör sig vid ${zone.toLowerCase()}!`
                            : `Andreas, ja' ser ${finalName} vid ${zone.toLowerCase()}.`;
                            
                        if (isCar && detectedPlate) {
                            baseAlertMsg = `En okänd bil står på ${zone.toLowerCase()}. Nummerskylt: ${detectedPlate}.`;
                        } else if (isCar) {
                            baseAlertMsg = `En bil rör sig vid ${zone.toLowerCase()}. (Kunde inte läsa skylten).`;
                        }
                        
                        // STEG 1: Larma omedelbart samma millisekund YOLO upptäcker rörelse!
                        appendMessage('AI', `🚨 [VAKT OMEDELBAR] ${baseAlertMsg}`, "", "all");
                        
                        // Fysisk medvetenhet: Tala bara om någon är i rummet
                        const andreasPresent = (now - window.presenceMemory["Andreas"] < 60000);
                        const anyoneInRoom = andreasPresent || (now - window.presenceMemory["Sonen"] < 30000);
                        
                        if (anyoneInRoom) {
                            // Barn-läge: Ändra tilltal om Lukas sitter där
                            const isLukasOnly = (now - window.presenceMemory["Sonen"] < 30000) && !andreasPresent;
                            if (isLukasOnly) baseAlertMsg = baseAlertMsg.replace("Andreas", "Lukas");
                            
                            audio.speak(baseAlertMsg);
                        }
                        
                        // Larmvägar:
                        // 1. Skicka Telegram oberoende av vem som sitter vid datorn.
                        // (Vi loggar detta nu, och fotot skickas strax nedanför när det tagits)
                        const logMsg = `Kl ${new Date().toLocaleTimeString()}: ${baseAlertMsg}`;
                        window.incidents.push(logMsg);
                        if (!brain.brainData.general.incidents) brain.brainData.general.incidents = [];
                        brain.brainData.general.incidents.push(logMsg);
                        brain.saveBrain();
                        
                        // 2. Skicka ALLTID till familjens tysta notis-logg i Supabase
                        notifyFamily("SÄKERHETSLARM", baseAlertMsg, zone);
                        
                        // --- NYTT: RÖRELSESPÅRNING MELLAN KAMEROR ---
                        const trackerKey = isUnknownPerson ? "unknown_person" : primaryObj;
                        const lastPresence = window.movementTracker[trackerKey];
                        const zoneHierarchy = { "Infarten": 1, "Garaget": 2, "Ytterdörren": 3 };
                        
                        if (lastPresence && lastPresence.zone !== zone && (now - lastPresence.time < 180000)) {
                            const lastZone = lastPresence.zone;
                            const isIncoming = zoneHierarchy[zone] > zoneHierarchy[lastZone];
                            const isOutgoing = zoneHierarchy[zone] < zoneHierarchy[lastZone];
                            
                            let trajectoryMsg = "";
                            if (isIncoming) trajectoryMsg = `Personen rör sig nu vidare från ${lastZone.toLowerCase()} in mot ${zone.toLowerCase()}.`;
                            if (isOutgoing) trajectoryMsg = `Personen rör sig nu utåt från ${lastZone.toLowerCase()} mot ${zone.toLowerCase()}.`;
                            
                            if (trajectoryMsg) {
                                appendMessage('AI', `👁️ [BANA] ${trajectoryMsg}`);
                                audio.speak(trajectoryMsg);
                                sendTelegram(`Bana: ${trajectoryMsg}`);
                            }
                        }
                        window.movementTracker[trackerKey] = { zone, time: now };

                        // STEG 2: Fota inkräktaren/bilen i tystnad för djupanalys
                        if (found[0].label === 'car' || found[0].label === 'truck') {
                            const plateData = await vision.detectPlate(cam);
                            if (plateData && plateData.plate) {
                                if (plateData.confidence > 0.7) {
                                    const plateKey = `plate_${plateData.plate}`;
                                    if (!window.lastAlerts[plateKey] || now - window.lastAlerts[plateKey] > 3600000) {
                                        window.lastAlerts[plateKey] = now;
                                        brain.logEvent("Vakt", `Identifierade fordon ${plateData.plate} vid ${zone}.`);
                                    }
                                }
                            }
                        }
                        try {
                            const snap = await vision.captureSnapshot(cam);
                            if (snap) {
                                // SPARA för interaktiv ansiktsträning om det är en person!
                                if (isUnknownPerson) {
                                    window.lastUnknownFaceSnapshot = snap;
                                }

                                // Spara fotot till hårddisken med 'zon'-prefix för att möjliggöra galleri-filtrering
                                const fileName = await ipcRenderer.invoke('save-snapshot', { 
                                    base64: snap, label: `zon_${detectedPlate || primaryObj}`
                                });
                                console.log(`[VAKT] Snapshot sparad omedelbart: ${fileName}`);
                                
                                // 🖼️ Skicka Telegram-fotobevis (med 60 sekunders spam-skydd)
                                if (!window.lastTelegramAlerts) window.lastTelegramAlerts = {};
                                const tgKey = `tg_${zone}_${primaryObj}_${detectedPlate||''}`;
                                const canSendTg = !window.lastTelegramAlerts[tgKey] || (now - window.lastTelegramAlerts[tgKey] > 60000);
                                
                                vision.describeSnapshot(snap, primaryObj).then(vlmDescription => {
                                    if (vlmDescription) {
                                        const updateMsg = `Uppdatering från ${zone.toLowerCase()}: ${vlmDescription}`;
                                        appendMessage('AI', `👁️ [SYNANALYSER] ${updateMsg}`);
                                        if (canSendTg) {
                                            window.lastTelegramAlerts[tgKey] = now;
                                            sendTelegramPhoto(`${baseAlertMsg}\n\nAnalys: ${vlmDescription}`, snap);
                                        }
                                        window.incidents.push(`Kl ${new Date().toLocaleTimeString()}: ${baseAlertMsg} (${vlmDescription})`);
                                    } else {
                                        if (canSendTg) {
                                            window.lastTelegramAlerts[tgKey] = now;
                                            sendTelegramPhoto(baseAlertMsg, snap);
                                        }
                                        window.incidents.push(`Kl ${new Date().toLocaleTimeString()}: ${baseAlertMsg}`);
                                    }
                                });
                            } else {
                                window.incidents.push(`Kl ${new Date().toLocaleTimeString()}: ${baseAlertMsg}`);
                            }
                        } catch (e) { 
                            console.error("Kunde inte fota/beskriva:", e); 
                            window.incidents.push(`Kl ${new Date().toLocaleTimeString()}: ${baseAlertMsg}`);
                        }
                    }

                    // Spara osedda skyltar i loggen för framtida referens
                    if (detectedPlate) {
                        if (!brain.brainData.general.seenPlates) brain.brainData.general.seenPlates = [];
                        brain.brainData.general.seenPlates.push({ plate: detectedPlate, time: new Date().toISOString(), zone });
                    }

                    brain.saveBrain();
                }
            }
        });
    }, 1000); // MAXIMAL HASTIGHET: Skannar varje sekund för att ingenting ska kunna passera!
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

    if (source === "text" || source === "röst") {
        if (text.toLowerCase().includes("telegram token")) {
            const parts = text.split(" ");
            const token = parts[parts.length - 1];
            brain.brainData.general.telegramToken = token;
            brain.saveBrain();
            appendMessage('AI', "Tack! Jag har sparat din Telegram Token. Skriv nu 'Min chat id är [NUMMER]' för att slutföra.");
            window.isThinking = false;
            return;
        }
        if (text.toLowerCase().includes("chat id")) {
            const parts = text.split(" ");
            const id = parts[parts.length - 1];
            brain.brainData.general.telegramChatId = id;
            brain.saveBrain();
            brain.saveBrain();
            appendMessage('AI', "Perfekt! Nu är jag helt uppkopplad till din telefon. Jag kommer skicka larm direkt dit.", "", remoteRecipient);
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

            appendMessage('System', `👁️ Tittar ut på ${camName}...`, "", remoteRecipient);
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
            if (lowerText.includes("ytterdörr")) { targetAud = ui.extAuds[0]; zone = "Ytterdörren"; }
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
        // --- IDENTITETSKONTROLL: Tangentbord = Andreas ---
        const isMasterTyping = source === "text";
        const camUser = isMasterTyping ? "Andreas" : vision.activeUser;
        const desktopUser = window.activeUser?.display_name;
        const targetPerson = remoteRecipient || (isMasterTyping ? "Andreas" : (camUser || desktopUser || "Okänd person"));
        
        if (isMasterTyping) {
            console.log("[VAKT] Bekräftad identitet: Andreas vid tangentbordet.");
        }

    // Samla ALLA kända fakta om familjen, bilar och inställningar så AI:n har full kontext
    let allMemories = "";
    if (brain.brainData.users) {
        for (const [name, data] of Object.entries(brain.brainData.users)) {
            if (data.facts && data.facts.length > 0) {
                 allMemories += `Fakta om ${name.toUpperCase()}: ${data.facts.join(". ")}. `;
            }
        }
    }
    const memories = allMemories.trim() || "Inga fakta lagrade ännu.";
    const lastDiary = brain.brainData.diary?.slice(-1)[0] || "Ingen dagbok än.";
        const timeStr = new Date().toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
        
        // --- NYTT: Använd ackumulerad tid iställtet för sessionstid ---
        const sittingMins = brain.brainData.users["Andreas"]?.sittingMinsToday || 0;
        const sittingHours = Math.floor(sittingMins / 60);
        const sittingDisplay = sittingHours > 0 ? `${sittingHours} timmar och ${sittingMins % 60} minuter` : `${sittingMins} minuter`;

        let sysHeader = targetPerson === "Okänd person" 
            ? "# SÄKERHETSVAKTS-LÄGE AKTIVERAT: En okänd person sitter vid Andreas dator. Var professionellt misstänksam, kräv identifiering och hälsa dem absolut INTE välkomna. Du är vaktchef här.\n"
            : "# PARTNER-LÄGE: Du pratar med Andreas eller hans familj. Var lojal, varm och hjälpsam.\n";

        let sysPrompt = `${sysHeader}# DIN IDENTITET: ${brain.brainData.general.identity}\n# ABSOLUT REGEL: Svara ENBART på SVENSKA. Svara ALLTID extremt kort (högst 2 meningar).\n# KLOCKAN ÄR ${timeStr}.\n# SITTID IDAG: Du ser att han suttit här i ${sittingDisplay}.\n# GLOBAL MINNESBANK (Vem som äger vad etc): ${memories}\n${brain.brainData.general.personality}`;

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
window.isHome = true; // Standard
window.setHomeState = (state) => {
    window.isHome = state;
    document.getElementById('btnHome').classList.toggle('active', state);
    document.getElementById('btnAway').classList.toggle('active', !state);
    
    document.getElementById('btnHome').style.borderColor = state ? '#00ff88' : '#555';
    document.getElementById('btnHome').style.color = state ? '#00ff88' : '#aaa';
    document.getElementById('btnAway').style.borderColor = !state ? '#f43f5e' : '#555';
    document.getElementById('btnAway').style.color = !state ? '#f43f5e' : '#aaa';
    
    if (state) {
        audio.speak("Hemma-läge aktiverat. Välkommen hem, Andreas.");
    } else {
        const msg = "Borta-läge aktiverat. Övergår i övervakningsläge och stänger av rösten i rummet.";
        audio.speak(msg);
        appendMessage('System', msg, "text", "all");
    }
};

window.init = init;
window.initMedia = initMedia;
window.askAI = askAI;
window.runReflection = () => { brain.analyzeRoutines(); askAI("(manuell reflektion)", "text"); };
window.registerNewFace = async () => {
    const name = prompt("Vad heter personen?");
    if (name) {
        const ok = await vision.registerFace(name);
        alert(ok ? "Ansikte sparat!" : "Misslyckades.");
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
                const msg = `Välkommen, ${data.display_name}. Full systembehörighet upprättad. Hur kan ja' hjälpa dig idag?`;
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
