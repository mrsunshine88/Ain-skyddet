/**
 * APP_LOGIC.JS - Hanterar AI, lägen och systembeslut
 */

export function initLogic(ui, brain, vision, audio) {
    console.log("[LOGIC] Modul laddad.");

    window.askAI = async (text, source = "text", remoteRecipient = null) => {
        if (window.isThinking) return;
        window.isThinking = true;

        // --- SPECIELLA KOMMANDON ---
        if (text.toLowerCase().includes("telegram token")) {
            const token = text.split(" ").pop();
            brain.brainData.general.telegramToken = token;
            brain.saveBrain();
            window.appendMessage('AI', "Tack! Jag har sparat din Telegram Token.");
            window.isThinking = false; return;
        }

        if (source !== "mobile") window.appendMessage('User', text, source);
        window.lastInteractionTime = Date.now();

        if (text.toLowerCase() === "stopp" || text.toLowerCase() === "tyst" || text.toLowerCase() === "stop") {
            window.speechSynthesis.cancel();
            window.isThinking = false;
            window.appendMessage('AI', "... tystar mig själv.");
            return;
        }

        // --- VQA & SYNAUTOMATION ---
        const lowerText = text.toLowerCase();
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
            
            let sysHeader = `# ABSOLUT REGEL: SVENSKA. Max 2 meningar. Använd INGEN markdown (som **). Klockan: ${timeStr}. Sittid: ${sitting}m.\n`;
            if (window.isLukasMode) sysHeader += "# LUKAS-LÄGE AKTIVT: Var pedagogisk och beskyddande.\n";
            if (window.isSleeping) sysHeader += "# SOV-LÄGE: Andreas sover, var viskande och kortfattad.\n";

            const memories = JSON.stringify(brain.brainData.users["Andreas"]?.facts || []);
            let sysPrompt = `${sysHeader}# MINNE: ${memories}\n${brain.brainData.general.personality}`;

            const fullOutput = await brain.getOllamaResponse(window.brainModel, [
                { role: 'system', content: sysPrompt },
                { role: 'user', content: text }
            ], (current) => {
                if (aiMsgDiv) aiMsgDiv.innerText = current.trim();
                ui.chatMessages.scrollTop = ui.chatMessages.scrollHeight;
            });

            if (window.isHome) audio.speak(fullOutput);
        } catch (e) {
            if (aiMsgDiv) aiMsgDiv.innerText = "Systemstörning: Kan inte nå hjärnan.";
        } finally {
            clearTimeout(safetyTimeout);
            window.isThinking = false;
        }
    };

    window.setGuardMode = (mode) => {
        if (mode === 'home') {
            window.isHome = true; window.isSleeping = false;
            let msg = window.isLukasMode ? "Välkommen tillbaka Andreas. Jag har vaktat Lukas." : "Välkommen hem Andreas.";
            audio.speak(msg); window.appendMessage('AI', msg);
            window.generateHomecomingReport();
        } else if (mode === 'away') {
            window.isHome = false;
            let msg = window.isLukasMode ? "Lukas, Andreas har gått. Du är under mitt beskydd." : "Borta-läge aktiverat.";
            audio.speak(msg); window.appendMessage('AI', msg);
        } else if (mode === 'sleep') {
            window.isSleeping = !window.isSleeping;
            if (window.isSleeping) {
                window.isHome = true;
                let msg = window.isLukasMode ? "Lukas, Andreas sover. Jag håller vakt med dig." : "Nattvakt aktiverad.";
                audio.speak(msg); window.appendMessage('AI', msg);
            } else {
                audio.speak("God morgon!"); window.generateHomecomingReport();
            }
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
        window.appendMessage('AI', `Aktiverar kamera... titta in i linsen ${name}.`);
        const ok = await vision.registerFace(name);
        if (ok) {
            window.appendMessage('AI', `Identitet ${name} bekräftad och lagrad.`);
            audio.speak(`Klart! Jag känner igen ${name} nu.`);
        }
    };

    window.registerCar = (plate, owner) => {
        if (!brain.brainData.general.familyCars) brain.brainData.general.familyCars = {};
        brain.brainData.general.familyCars[plate.toUpperCase()] = owner;
        brain.saveBrain();
        window.appendMessage('AI', `Bil ${plate.toUpperCase()} reggad på ${owner}.`);
    };

    window.syncCloudMemory = async () => {
        if (!window.supabase) return;
        window.supabase.from('jarvis_state').upsert({
            id: 'desktop_main', vakt_mode: window.vaktMode, is_home: window.isHome, active_user: vision.activeUser
        });
    };
}
