/**
 * APP_LOGIC.JS - Hanterar AI, lägen och systembeslut
 */

export function initLogic(ui, brain, vision, audio) {
    console.log("[LOGIC] Modul laddad.");

    // --- UI HÄNDELSER ---
    if (ui.voiceBtn) {
        ui.voiceBtn.onclick = () => {
            if (audio.isCapturing || audio.recognizing) {
                audio.stopCapture(() => {
                    ui.voiceBtn.classList.remove('recording');
                    ui.micStatus.innerText = "Tolkar...";
                }, (text) => {
                    ui.micStatus.innerText = "Hörsel redo";
                    window.askAI(text, "röst");
                });
            } else {
                audio.startCapture(() => {
                    ui.voiceBtn.classList.add('recording');
                    ui.micStatus.innerText = "Lyssnar...";
                }, (text) => {
                    ui.voiceBtn.classList.remove('recording');
                    ui.micStatus.innerText = "Hörsel redo";
                    window.askAI(text, "röst");
                });
            }
        };
    }

    if (ui.btnHome) ui.btnHome.onclick = () => window.setGuardMode('home');
    if (ui.btnAway) ui.btnAway.onclick = () => window.setGuardMode('away');
    if (ui.btnSleep) ui.btnSleep.onclick = () => window.setGuardMode('sleep');
    if (ui.btnLukas) ui.btnLukas.onclick = () => window.toggleLukasMode();
    if (ui.btnVakt) ui.btnVakt.onclick = () => window.toggleVakt();
    if (ui.btnCameras) ui.btnCameras.onclick = () => (window.toggleCameras ? window.toggleCameras() : console.log("Kameravy ej laddad"));
    if (ui.btnAcademy) ui.btnAcademy.onclick = () => window.toggleAcademy();

    window.askAI = async (text, source = "text", remoteRecipient = null) => {
        if (!text) return;
        if (window.isThinking) return;
        window.isThinking = true;

        const lowerText = text.toLowerCase();
        if (source !== "mobile") window.appendMessage('User', text, source);
        window.lastInteractionTime = Date.now();

        // --- SPECIELLA KOMMANDON ---
        if (lowerText.includes("telegram token")) {
            const token = text.split(" ").pop();
            brain.brainData.general.telegramToken = token;
            brain.saveBrain();
            window.appendMessage('AI', "Tack! Jag har sparat din Telegram Token.");
            window.isThinking = false; return;
        }

        // --- ANSIKTS-IDENTIFIERING FRÅN ANVÄNDARE ---
        if (lowerText.startsWith("det är ")) {
            const name = text.replace(/det är /i, "").replace(".", "").trim();
            const lastSnap = window.lastIntruderSnap;
            
            if (lastSnap) {
                window.ipcRenderer.invoke('save-face-image', { 
                    base64: lastSnap, 
                    name: name, 
                    index: Date.now() 
                }).then(() => {
                    if (!brain.brainData.users[name]) {
                        brain.brainData.users[name] = { facts: [`Bekräftad av Andreas via kamera.`], affinity: 0.8 };
                    } else {
                        brain.brainData.users[name].affinity = 0.8;
                    }
                    brain.saveBrain();
                    window.appendMessage('AI', `Systemet uppdaterat. Jag har sparat en referensbild på ${name} i mitt arkiv.`);
                    audio.speak(`Uppfattat. Jag har sparat bilden på ${name} i mitt arkiv.`);
                });
                window.isThinking = false; return;
            }
        }

        if (text.toLowerCase() === "stopp" || text.toLowerCase() === "tyst" || text.toLowerCase() === "stop") {
            window.speechSynthesis.cancel();
            window.isThinking = false;
            window.appendMessage('AI', "... tystar mig själv.");
            return;
        }

        // --- VQA & SYNAUTOMATION ---
        if ((lowerText.includes("ser du") || lowerText.includes("titta") || lowerText.includes("vad finns")) && 
            (lowerText.includes("infart") || lowerText.includes("garage") || lowerText.includes("ytterdörr"))) {
            
            let targetCam = lowerText.includes("ytterdörr") ? ui.extCams[0] : (lowerText.includes("garage") ? ui.extCams[2] : ui.extCams[1]);
            let camName = lowerText.includes("ytterdörr") ? "Ytterdörren" : (lowerText.includes("garage") ? "Garaget" : "Infarten");

            window.appendMessage('System', `👀 Tittar ut på ${camName}...`);
            try {
                const snap = await vision.captureSnapshot(targetCam);
                if (snap) {
                    const sensed = await vision.detectObjects(targetCam);
                    const aiReply = await brain.getOllamaResponse(window.brainModel, [
                        { role: 'system', content: `Svara kort på svenska om denna bild: ${text}. Jag ser ${sensed.length} objekt.` },
                        { role: 'user', content: text }
                    ]);
                    window.appendMessage('AI', `(Från ${camName}): ${aiReply}`);
                    if (window.isHome) audio.speak(aiReply);
                }
            } catch (e) { console.error("VQA error:", e); }
            window.isThinking = false;
            return;
        }

        // --- STANDARD AI RESPONS ---
        const aiMsgDiv = window.appendMessage('AI', '...');
        const safetyTimeout = setTimeout(() => { window.isThinking = false; }, 20000);

        try {
            const timeStr = new Date().toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
            const sitting = Math.floor(brain.brainData.users["Andreas"]?.sittingMinsToday || 0);
            
            let sysHeader = `# DIN ROLL: Övervakningsexpert. Svara med MAX 2 meningar på SVENSKA. Inget småprat. Klockan: ${timeStr}.\n`;
            if (window.isLukasMode) sysHeader += "# LUKAS-LÄGE: Var beskyddande och saklig.\n";
            if (window.isSleeping) sysHeader += "# SOV-LÄGE: Andreas sover, var viskande och kortfattad.\n";

            const incidents = (window.incidents || []).slice(-3).map(i => i.detail).join(". ");
            const memories = JSON.stringify(brain.brainData.users["Andreas"]?.facts || []);
            
            let statusContext = incidents ? `SENASTE AKTIVITET: ${incidents}` : "Ingen aktivitet har rapporterats nyss.";
            let sysPrompt = `${sysHeader}# SYSTEM-STATUS: ${statusContext}\n# MINNE: ${memories}\n${brain.brainData.general.personality}\nVIKTIGT: Gissa aldrig. Om inget finns i loggen, säg att läget verkar stabilt utifrån de senaste loggarna.`;

            const fullOutput = await brain.getOllamaResponse(window.brainModel, [
                { role: 'system', content: sysPrompt },
                { role: 'user', content: text }
            ], (current) => {
                if (aiMsgDiv) aiMsgDiv.innerText = current.trim();
                ui.chatMessages.scrollTop = ui.chatMessages.scrollHeight;
            });

            if (window.isHome) audio.speak(fullOutput);
        } catch (e) {
            if (aiMsgDiv) aiMsgDiv.innerText = "Hjärnan är upptagen. Försök igen om en sekund.";
        } finally {
            clearTimeout(safetyTimeout);
            window.isThinking = false;
            // Bakgrundsuppgift: Extrahera fakta från samtalet
            brain.extractAndStoreFacts(vision.activeUser || "Andreas", text, aiMsgDiv.innerText);

            // --- NYTT: PROAKTIV SOCIAL FRÅGA (Efter 5 sekunder) ---
            if (window.lastFriendSnap && !window.hasAskedAboutFriend) {
                setTimeout(() => {
                    if (!window.isThinking) { 
                        const person = window.lastFriendSeenWith || "någon i familjen";
                        const msg = `Jag såg att ${person} umgicks med en person tidigare som jag inte känner igen. Ska jag spara bilden som en betrodd vän?`;
                        window.appendMessage('AI', msg);
                        audio.speak(msg);
                        window.hasAskedAboutFriend = true; 
                    }
                }, 5000);
            }
        }
    };

    window.setGuardMode = (mode) => {
        // Återställ alla huvudlägen visuellt
        const modes = ['Home', 'Away', 'Sleep'];
        modes.forEach(m => document.getElementById('btn' + m)?.classList.remove('active'));
        
        // Aktivera det valda läget visuellt
        const activeBtn = document.getElementById('btn' + mode.charAt(0).toUpperCase() + mode.slice(1));
        if (activeBtn) activeBtn.classList.add('active');

        // Uppdatera interna tillstånd för att vara ömsesidigt uteslutande
        if (mode === 'home') {
            window.isHome = true; window.isSleeping = false;
            let msg = window.isLukasMode ? "Välkommen tillbaka Andreas. Jag har vaktat Lukas." : "Välkommen hem Andreas.";
            audio.speak(msg); window.appendMessage('AI', msg);
            window.generateHomecomingReport();
        } else if (mode === 'away') {
            window.isHome = false; window.isSleeping = false;
            let msg = window.isLukasMode ? "Lukas, Andreas har gått. Du är under mitt beskydd." : "Borta-läge aktiverat.";
            audio.speak(msg); window.appendMessage('AI', msg);
        } else if (mode === 'sleep') {
            window.isSleeping = true; window.isHome = true;
            let msg = window.isLukasMode ? "Lukas, Andreas sover. Jag håller vakt med dig." : "Nattvakt aktiverad.";
            audio.speak(msg); window.appendMessage('AI', msg);
        }
        window.syncCloudMemory();
    };

    window.toggleLukasMode = () => {
        window.isLukasMode = !window.isLukasMode;
        const btn = document.getElementById('btnLukas');
        btn?.classList.toggle('active', window.isLukasMode);
        let msg = window.isLukasMode ? "Lukas-läge aktiverat. Full beskyddar-protokoll online." : "Lukas-läge avaktiverat.";
        audio.speak(msg); window.appendMessage('AI', msg);
        window.syncCloudMemory();
    };

    window.toggleVakt = () => {
        const btn = document.getElementById('btnVakt');
        window.vaktMode = !window.vaktMode;
        if (window.vaktMode) {
            btn?.classList.add('active');
            window.appendMessage('AI', "Vaktläge aktiverat. Full systemskanning påbörjad.");
        } else {
            btn?.classList.remove('active');
            window.appendMessage('AI', "Vaktläge avaktiverat. Skannar ej yttre zon.");
        }
        window.syncCloudMemory();
    };

    window.generateHomecomingReport = async (emptyMsg = "Lugnt sedan sist.") => {
        const incidents = window.incidents || [];
        if (incidents.length === 0) { audio.speak(emptyMsg); return; }
        const summary = `Senaste loggen: ${incidents.slice(-5).map(i => i.detail).join(". ")}`;
        window.appendMessage('AI', "📋 [RAPPORT]\n" + summary);
        audio.speak("Här är vad som hänt medan du var borta.");
    };

    window.toggleAcademy = () => {
        const overlay = document.getElementById('academyOverlay');
        if (overlay) overlay.style.display = overlay.style.display === 'none' ? 'flex' : 'none';
    };

    window.trainPerson = async (name) => {
        if (!name) return;
        window.appendMessage('AI', `Aktiverar sensorer... Titta in i kameran, ${name}. Jag tar 5 snabba bilder för att aldrig glömma dig.`);
        const ok = await vision.registerFaceBurst(name, (count) => {
            window.appendMessage('System', `📸 Bild ${count}/5 sparad...`);
        });
        
        if (ok) {
            if (!brain.brainData.users[name]) brain.brainData.users[name] = { facts: [], affinity: 1.0 };
            brain.brainData.users[name].facts.push(`${name} är en identifierad vän till familjen.`);
            brain.saveBrain();
            window.appendMessage('AI', `Träning slutförd. ${name} är nu en del av mitt långtidsminne.`);
            audio.speak(`Klart! Jag känner igen ${name} i alla lägen nu.`);
        } else {
            window.appendMessage('AI', "Kunde inte slutföra träning. Kontrollera att kameran ser ansiktet tydligt.");
        }
    };

    window.registerCar = (plate, owner) => {
        if (!plate || !owner) return;
        const cleanPlate = plate.toUpperCase().replace(/\s/g, '');
        if (!brain.brainData.general.familyCars) brain.brainData.general.familyCars = {};
        brain.brainData.general.familyCars[cleanPlate] = owner;
        
        // Spara även som en faktum för AI:n
        if (!brain.brainData.users["Andreas"].facts.includes(`Bilen med regnummer ${cleanPlate} tillhör ${owner}.`)) {
            brain.brainData.users["Andreas"].facts.push(`Bilen med regnummer ${cleanPlate} tillhör ${owner}.`);
        }
        
        brain.saveBrain();
        window.appendMessage('AI', `Fordonet ${cleanPlate} är nu registrerat på ${owner}. Jag kommer aldrig glömma bort den.`);
        audio.speak(`Fordonet registrerat. Jag håller utkik efter ${owner}s bil.`);
    };

    window.syncCloudMemory = async () => {
        if (!window.supabase) return;
        window.supabase.from('jarvis_state').upsert({
            id: 'desktop_main', vakt_mode: window.vaktMode, is_home: window.isHome, active_user: vision.activeUser
        });
    };
}
