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

        // --- VQA & SYNAUTOMATION (Realtids-scann via Frigate) ---
        const isQueryingOutside = /är (de|det) (nån|någon|något|några)/i.test(lowerText) || 
                                  /nån (ute|utanför|där)/i.test(lowerText) ||
                                  /är de lugnt/i.test(lowerText) ||
                                  /ser du (nåt|något|nån|någon)/i.test(lowerText) ||
                                  /(vad händer|titta|visa) (vid|på|ute|utanför)/i.test(lowerText) ||
                                  /(bilen|trappen|vägen|infarten|garaget|grinden|staketet)/i.test(lowerText);

        if (isQueryingOutside) {
            window.appendMessage('System', `📡 Utför en aktiv genomsökning av alla zoner...`);
            try {
                // --- NYTT: Supersmart AI-Kameraväxel ---
                let targetCams = [];
                // 1. Snabb-fallback (Keywords för hastighet)
                if (lowerText.includes("bil") || lowerText.includes("infart") || lowerText.includes("väg")) targetCams = ["Infarten"];
                else if (lowerText.includes("dörr") || lowerText.includes("trapp")) targetCams = ["Ytterdorren"];
                else if (lowerText.includes("garaget")) targetCams = ["Garaget"];
                else if (lowerText.includes("ute") || lowerText.includes("lugnt") || lowerText.includes("tomten")) targetCams = ["Ytterdorren", "Infarten", "Garaget"];

                // 2. AI-Intention (Om nyckelord saknas eller för mer komplex förståelse)
                if (targetCams.length === 0) {
                    const intentPrompt = `Givet frågan: "${text}". Vilka kameror är relevanta? (Ytterdorren, Infarten, Garaget). Svara ENDAST med namnen separerade med komma.`;
                    const intentRes = await fetch('http://127.0.0.1:11434/api/generate', {
                        method: 'POST',
                        body: JSON.stringify({ model: 'llama3.2-vision', prompt: intentPrompt, stream: false, options: { num_predict: 20, temperature: 0.1 } })
                    });
                    const intentData = await intentRes.json();
                    targetCams = intentData.response.split(',').map(n => n.trim()).filter(n => ["Ytterdorren", "Infarten", "Garaget"].includes(n));
                }

                if (targetCams.length === 0) targetCams = ["Ytterdorren"]; // Default ytterdörr

                window.appendMessage('System', `🔍 Scannar ${targetCams.join(" och ")}...`);

                let multiContext = [];
                for (const camName of targetCams) {
                    const snap = await vision.getLiveSnapshotFromFrigate(camName);
                    if (snap) {
                        const aiReply = await brain.getOllamaResponse(window.brainModel, [
                            { role: 'system', content: `Du är JARVIS. Titta på denna bild från ${camName}. Beskriv kortfattat vad du ser för Andreas på svenska.` },
                            { role: 'user', content: text, images: [snap.split(',')[1]] }
                        ]);
                        multiContext.push(`${camName}: ${aiReply}`);
                    }
                }

                // 3. Generera det slutgiltiga sammanslagna svaret
                const finalPrompt = `Användaren (Andreas) frågar: "${text}". Här är vad jag ser på mina olika kameror:\n${multiContext.join("\n")}\n\nSvara nu Andreas på ett naturligt sätt baserat på all denna info.`;
                const finalReply = await brain.getOllamaResponse(window.brainModel, [{ role: 'user', content: finalPrompt }]);
                
                window.appendMessage('AI', finalReply);
                if (window.canSpeakNow()) audio.speak(finalReply);
            } catch (e) { 
                console.error("Verifieringsfel:", e); 
                window.appendMessage('AI', "Jag kunde inte nå Frigate för att verifiera läget just nu.");
            }
            window.isThinking = false;
            return;
        }

        // --- STANDARD AI RESPONS ---
        const aiMsgDiv = window.appendMessage('AI', '...');
        const safetyTimeout = setTimeout(() => { window.isThinking = false; }, 20000);

        try {
            const timeStr = new Date().toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
            const sitting = Math.floor(brain.brainData.users["Andreas"]?.sittingMinsToday || 0);
            
            let sysHeader = `# DIN ROLL: Övervakningsexpert i ett HUS. Ge en UTFÖRLIG och klinisk rapport på 3-4 meningar på SVENSKA. Klockan: ${timeStr}.\n`;
            sysHeader += "# TRÄDGÅRDS-LAYOUT: Ytterdörren (huset) <-> Garaget (mitten) <-> Infarten (vägen). Dessa tre zoner hänger ihop i serieföljd.\n";
            sysHeader += "# KONTEXT: Du befinner dig i ett HUS. Använd alltid namnet som anges i loggen för att identifiera personer.\n";
            sysHeader += "# RAPPORTERING: Beskriv rörelse mellan zonerna (t.ex. 'rör sig vidare mot...', 'passerar...'). Var detaljerad men 100% ärlig.\n";

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
        // --- SMARTA KNAPPAR (Neon-glöd) ---
        const modes = ['Home', 'Away', 'Sleep'];
        modes.forEach(m => {
            const btn = document.getElementById('btn' + m);
            if (btn) {
                if (m.toLowerCase() === mode.toLowerCase()) {
                    btn.classList.add('active');
                } else {
                    btn.classList.remove('active');
                }
            }
        });

        // Uppdatera interna tillstånd
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
        if (btn) btn.classList.toggle('active', window.isLukasMode);
        
        let msg = window.isLukasMode ? "Lukas-läge aktiverat. Full beskyddar-protokoll online." : "Lukas-läge avaktiverat.";
        audio.speak(msg); window.appendMessage('AI', msg);
        window.syncCloudMemory();
    };

    window.toggleVakt = () => {
        window.vaktMode = !window.vaktMode;
        const btn = document.getElementById('btnVakt');
        if (btn) btn.classList.toggle('active', window.vaktMode);
        
        if (window.vaktMode) {
            window.appendMessage('AI', "Vaktläge aktiverat. Full systemskanning påbörjad.");
        } else {
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
