/**
 * APP_SECURITY.JS - Hanterar kameror, patrullering och larm
 */

export function initSecurity(ui, vision, audio, brain) {
    console.log("[SECURITY] Modul laddad.");

    const fs = require('fs');
    
    const zoneNames = ["Ytterdörren", "Infarten", "Garaget"];
    const zoneSequence = { "Vägen": 0, "Infarten": 1, "Garaget": 2, "Ytterdörren": 3 };
    window.lastAlerts = {};
    window.lastSentMessage = "";
    window.roadPassages = 0;

    // --- [CHECK] LADDA SPARADE POSITIONER FRÅN FIL ---
    try {
        if (fs.existsSync('tracker.json')) {
            window.movementTracker = JSON.parse(fs.readFileSync('tracker.json', 'utf8'));
            console.log("[SECURITY] Rörelse-minne laddat från fil.");
        } else {
            window.movementTracker = {};
        }
    } catch (e) {
        window.movementTracker = {};
    }

    window.startSecurityLoop = () => {
        console.log("Säkerhetsmatris laddad. Väntar på Vaktläge...");
        
        setInterval(async () => {
            // Prioritet 1: Global AI-spärr för att spara GPU (100%-fixen)
            if (window.isOllamaBusy || window.isThinking || window.isAnalyzingIntruder) return;

            const isVaktActive = window.vaktMode || window.isSleeping || !window.isHome;
            
            ui.extCams.forEach(async (cam, idx) => {
                if (!cam || !cam.complete || cam.naturalWidth === 0) return;
                const zone = zoneNames[idx];
                const now = Date.now();

                // 1. LJUDANALYS
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
                                audio.speak("Jag hör något vid dörren.");
                                audio.transcribeFromElement(ui.extAuds[idx], 5000).then(speech => {
                                    if (speech) {
                                        window.appendMessage('AI', `🎙️ [DÖRR-AVLYSSNING]: "${speech}"`);
                                    }
                                });
                            }
                        }
                    }
                }

                // 2. SYN & OBJEKT
                const objects = await vision.detectObjects(cam);
                const targets = ["person", "car", "truck", "motorcycle"];
                // Höjt tröskelvärde till 0.75 / 0.80 för att vara extremt restriktiv (enligt instruktion)
                let found = objects.filter(o => targets.includes(o.label) && o.confidence > (isVaktActive ? 0.75 : 0.80));

                if (found.length > 0) {
                    const currentObj = found[0];
                    const primaryObj = currentObj.label;
                    const trackerId = `track_${zone}_${primaryObj}`;
                    const lastPos = window.movementTracker[trackerId];
                    
                    const centerX = (currentObj.x_min + currentObj.x_max) / 2;
                    const centerY = (currentObj.y_min + currentObj.y_max) / 2;
                    
                    // --- 1. [CHECK] STILLASTÅENDE-SPÄRR (ABSOLUT TOPP) ---
                    if (lastPos && lastPos.pos) {
                        const dist = Math.sqrt(Math.pow(centerX - lastPos.pos.x, 2) + Math.pow(centerY - lastPos.pos.y, 2));
                        if (dist < 20) return; 
                    }

                    // --- 2. REGISTRERA RÖRELSE OCH SPARA MINNE ---
                    window.movementTracker[trackerId] = { zone, time: now, pos: { x: centerX, y: centerY } };
                    fs.writeFileSync('tracker.json', JSON.stringify(window.movementTracker, null, 2));

                    const alertKey = `${zone}_${primaryObj}_global_v4`;
                    if (!window.lastAlerts[alertKey] || now - window.lastAlerts[alertKey] > 60000) {
                        window.lastAlerts[alertKey] = now;
                        
                        const snap = await vision.captureSnapshot(cam);
                        if (snap) {
                            window.lastIntruderSnap = snap;
                            
                            // --- SOCIAL INTELLIGENS (Hela familjen + Vänner) ---
                            const faceNames = await vision.recognizeFace(cam);
                            const family = ["Andreas", "Helena", "Josephine", "Lukas"];
                            const seenFamily = faceNames.filter(name => family.includes(name));
                            const includesUnknown = faceNames.includes("Okänd");

                            if (seenFamily.length > 0 && includesUnknown) {
                                const mood = await vision.analyzeMood(cam);
                                if (mood && !mood.toLowerCase().includes("stress")) {
                                    window.lastFriendSnap = snap;
                                    window.lastFriendSeenWith = seenFamily.join(" och ");
                                    console.log(`[SOCIAL] ${window.lastFriendSeenWith} umgås med okänd. Flaggar som vän.`);
                                }
                            }

                            window.isAnalyzingIntruder = true; 
                            vision.analyzeIntruder(snap, primaryObj).then(async (analysis) => {
                                window.isAnalyzingIntruder = false;
                                let cleanDesc = analysis.description.replace(/\[.*?\]/g, '').replace(/\*\*/g, '').trim();
                                let isIdentified = cleanDesc.includes("Identifierad");

                                // --- 3. [CHECK] TOTAL TYSTNAD VID IDENTIFIERING ---
                                if (isIdentified) {
                                    console.log(`[SECURITY] Identifierad ${primaryObj} vid ${zone}. Ingen logg skapas.`);
                                    return; 
                                }

                                // --- 4. ENDAST SKARPA HÄNDELSER LOGGAS NU ---
                                let isCar = ["car", "truck", "motorcycle"].includes(primaryObj);
                                let trajectoryMsg = "";
                                if (lastPos && lastPos.zone !== zone && (now - lastPos.time < 60000)) {
                                    const isIncoming = zoneSequence[zone] > (zoneSequence[lastPos.zone] || 0);
                                    trajectoryMsg = isIncoming ? "rör sig nu inåt" : "rör sig utåt";
                                } else {
                                    trajectoryMsg = `syns vid ${zone.toLowerCase()}`;
                                }

                                const voiceMsg = `🚨 Varning! ${isCar ? 'Ett fordon' : 'En person'} ${trajectoryMsg}. ${cleanDesc}`;
                                
                                if (voiceMsg === window.lastSentMessage) return;
                                window.lastSentMessage = voiceMsg;

                                if (window.isHome && !window.isSleeping) audio.speak(voiceMsg);
                                window.appendMessage('AI', `🚨 [VAKT-LOGG] ${voiceMsg}`);

                                if (!window.incidents) window.incidents = [];
                                window.incidents.push({ time: new Date().toLocaleTimeString(), detail: voiceMsg });
                                if (window.incidents.length > 20) window.incidents.shift();

                                if (analysis.threatLevel >= 3 || (!window.isHome && zone !== "Infarten")) {
                                    window.sendTelegramPhoto(`[SÄKERHET] ${voiceMsg}`, snap);
                                }
                            });
                        }
                    }
                }
            });
        }, 1500);
    };

    window.handleCameraFailure = (camIdx) => {
        const zones = ["Ytterdörren", "Infarten", "Garaget"];
        window.appendMessage('System', `Kamerafel vid ${zones[camIdx]}. Försöker återansluta...`);
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
            window.sendTelegram(msg); 
        }
    };
}
