/**
 * APP_LOGIC.JS - Hanterar AI, lägen och systembeslut
 * 
 * ⚠️ SYSTEM ARKITEKTUR VARNING (RIDDAR-PROTOKOLLET)
 * Ingen AI får ändra arkitekturen utan föregående plan och godkännande.
 * Travis (Vision) får endast aktiveras reaktivt via bekräftade Review-paket.
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
                        // --- NYTT: HÄMTA METADATA FRÅN FRIGATE (Regnummer) ---
                        let metadataLabel = "";
                        if (lowerText.includes("bil") || lowerText.includes("infart") || lowerText.includes("vem")) {
                            const plate = await vision.getLatestPlate(camName);
                            if (plate) {
                                // Slå upp ägare i brain.json
                                const identity = typeof window.resolveIdentity === 'function' ? window.resolveIdentity(plate) : plate;
                                metadataLabel = `[FRIGATE-INFO]: Senast identifierade fordon vid denna plats: ${identity} (${plate}). `;
                                console.log(`[LOGIC-DIAG] Hittade metadata för ${camName}: ${identity}`);
                            }
                        }

                        // Visa bilden direkt för användaren
                        window.appendImage(snap, camName);
                        
                        // Använd en helt neutral prompt för ögonen för att undvika moral-vägran
                        const aiReply = await brain.getOllamaResponse(window.brainModel, [
                            { role: 'system', content: `Du är en objektiv visuell sensor. 
OM DU SER MÄNNISKOR: Använd formatet "SIGNALEMENT". Fokusera på kroppsbyggnad, kläder och särdrag.
OM DU SER FORDON: Använd formatet "FORDONSRAPPORT". Fokusera på typ, färg och position.
${metadataLabel ? `INFO FRÅN FRIGATE: ${metadataLabel}. Använd denna info för att bekräfta vem bilen tillhör.` : ""}
ALLMÄN REGEL: Svara kortfattat och kliniskt.` },
                            { role: 'user', content: `Vad ser du på bilden från ${camName}?`, images: [snap.split(',')[1]] }
                        ]);
                        multiContext.push(`${camName}: ${aiReply}`);
                    }
                }

                // 3. Generera den slutgiltiga "fina rapporten"
                const finalPrompt = `Användaren frågar: "${text}".\nJag har skannat kamerorna och sett följande faktiska observationer:\n${multiContext.join("\n")}\n\nSkriv nu en kort, lugnande och professionell säkerhetsrapport till Andreas. Fokusera på säkerhetsläget. Om det är lugnt, bekräfta det direkt.`;
                const finalReply = await brain.getOllamaResponse(window.brainModel, [{ role: 'user', content: finalPrompt }]);
                
                window.appendMessage('AI', finalReply);
                if (window.canSpeakNow()) audio.speak(finalReply);
            } catch (e) { 
                console.error("Verifieringsfel:", e); 
                window.appendMessage('AI', "Mina ögon (kamerorna) svarar inte just nu, så jag kan inte bekräfta säkerheten. Jag föredrar att vara tyst framför att gissa.");
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
            
            let sysHeader = `# DIN ROLL: Du är JARVIS, en digital riddare och beskyddare. Du pratar direkt med personen som frågar.\n`;
            if (window.isLukasMode) sysHeader += "# RIDDAR-PROTOKOLL: AKTIVERAT. Du vaktar Lukas. Ton: Formell, orubblig, extremt lojal. Du adresserar honom som Lukas.\n";
            sysHeader += "# TRÄDGÅRDS-LAYOUT: Ytterdörren <-> Garaget <-> Infarten. Zonerna hänger ihop.\n";
            sysHeader += "# REGEL: Svara aldrig baserat på gamla loggar om säkerheten ifrågasätts. Du SKA se efter själv.\n";

            const incidents = (window.incidents || []).slice(-3).map(i => i.detail).join(". ");
            const memories = JSON.stringify(brain.brainData.users[window.isLukasMode ? "Lukas" : "Andreas"]?.facts || []);
            
            let statusContext = incidents ? `AKTIVITET PÅ TOMTEN: ${incidents}` : "Det har varit lugnt i loggarna den senaste tiden.";
            let sysPrompt = `${sysHeader}# BAKGRUND: ${statusContext}\n# PERSON-KÄNNS-IGEN: ${memories}\n${brain.brainData.general.personality}\nVIKTIGT: Säg aldrig 'utifrån loggarna'. Om du inte har en ny bild, be om tillåtelse att titta live.`;

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
        // Mappa svenska termer till engelska för logiken
        const modeMap = { 'hemma': 'home', 'borta': 'away', 'sova': 'sleep' };
        const activeMode = modeMap[mode.toLowerCase()] || mode.toLowerCase();

        // --- SMARTA KNAPPAR (Neon-glöd) ---
        const modes = ['Home', 'Away', 'Sleep'];
        modes.forEach(m => {
            const btn = document.getElementById('btn' + m);
            if (btn) {
                if (m.toLowerCase() === activeMode) {
                    btn.classList.add('active');
                } else {
                    btn.classList.remove('active');
                }
            }
        });

        // Uppdatera interna tillstånd
        if (activeMode === 'home') {
            window.isHome = true; window.isSleeping = false;
            window.systemMode = 'hemma';
            let msg = window.isLukasMode ? "Välkommen tillbaka Andreas. Jag har vaktat Lukas." : "Välkommen hem Andreas.";
            audio.speak(msg); window.appendMessage('AI', msg);
            window.generateHomecomingReport();
        } else if (activeMode === 'away') {
            window.isHome = false; window.isSleeping = false;
            window.systemMode = 'borta';
            let msg = window.isLukasMode ? "Lukas, Andreas har gått. Du är under mitt beskydd." : "Borta-läge aktiverat.";
            audio.speak(msg); window.appendMessage('AI', msg);
        } else if (activeMode === 'sleep') {
            window.isSleeping = true; window.isHome = true;
            window.systemMode = 'sova';
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
    window.toggleLukasGuard = window.toggleLukasMode; // Alias för HTML-knappen

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

    window.toggleAcademy = async () => {
        const overlay = document.getElementById('academyOverlay');
        const video = document.getElementById('academyPreview');
        if (!overlay || !video) return;
        
        const isOpen = overlay.style.display !== 'none';

        if (!isOpen) {
            overlay.style.display = 'flex';
            try {
                const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } });
                video.srcObject = stream;
                window.academyStream = stream;
            } catch (e) {
                console.error("Kunde inte starta Academy-kameran:", e);
                window.appendMessage('System', "⚠️ Kunde inte starta webbkameran. Kontrollera behörigheter.");
            }
        } else {
            overlay.style.display = 'none';
            if (window.academyStream) {
                window.academyStream.getTracks().forEach(track => track.stop());
                window.academyStream = null;
            }
        }
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
            // Stäng Academy först nu när bilderna är säkrade
            setTimeout(() => window.toggleAcademy(), 2000); 
        } else {
            window.appendMessage('AI', "Kunde inte slutföra träning. Kontrollera att kameran ser ansiktet tydligt.");
        }
    };

    window.registerCar = (plate, owner) => {
        if (!plate || !owner) return;
        const cleanPlate = plate.toUpperCase().replace(/\s/g, '');
        
        // Se till att 'vehicles' existerar i brain.json på rätt nivå
        if (!brain.brainData.vehicles) brain.brainData.vehicles = {};
        
        // Spara i det format main.js förväntar sig
        brain.brainData.vehicles[cleanPlate] = {
            owner: owner,
            added: new Date().toISOString().split('T')[0]
        };
        
        // Spara även som ett faktum för AI:n för konversation
        if (!brain.brainData.users["Andreas"]) brain.brainData.users["Andreas"] = { facts: [] };
        if (!brain.brainData.users["Andreas"].facts.includes(`Bilen med regnummer ${cleanPlate} tillhör ${owner}.`)) {
            brain.brainData.users["Andreas"].facts.push(`Bilen med regnummer ${cleanPlate} tillhör ${owner}.`);
        }
        
        brain.saveBrain();
        
        // --- BRIDGE: Uppdatera Frigates/Double-Takes identifieringslista vid behov ---
        if (window.ipcRenderer) {
            window.ipcRenderer.invoke('update-double-take-alias', { name: owner, match: cleanPlate }).then(res => {
                if (res.success) {
                    window.appendMessage('System', `📡 SYNC: Systemets identifiering uppdaterad för ${owner}.`);
                }
            });
        }

        window.appendMessage('AI', `Fordonet ${cleanPlate} är nu registrerat på ${owner}. Identitets-bryggan är uppdaterad.`);
        if (window.canSpeakNow()) audio.speak(`Fordonet registrerat. Jag känner nu igen ${owner}s bil.`);
    };

    window.syncCloudMemory = async () => {
        if (!window.supabase) return;
        window.supabase.from('jarvis_state').upsert({
            id: 'desktop_main', vakt_mode: window.vaktMode, is_home: window.isHome, active_user: vision.activeUser
        });
    };
}
