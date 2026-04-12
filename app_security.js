/**
 * APP_SECURITY.JS - Hanterar kameror, patrullering och larm
 */

export function initSecurity(ui, vision, audio, brain) {
    console.log("[SECURITY] Modul laddad.");

    const zoneNames = ["Ytterdörren", "Infarten", "Garaget"];
    const zoneSequence = { "Vägen": 0, "Infarten": 1, "Garaget": 2, "Ytterdörren": 3 };
    window.lastAlerts = {};
    window.roadPassages = 0;

    window.startSecurityLoop = () => {
        console.log("Säkerhetsmatris laddad. Väntar på Vaktläge...");
        
        setInterval(async () => {
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
                let found = objects.filter(o => targets.includes(o.label) && o.confidence > (isVaktActive ? 0.35 : 0.45));

                if (found.length > 0) {
                    const primaryObj = found[0].label;
                    const isCar = ["car", "truck", "motorcycle"].includes(primaryObj);
                    const trackerId = `track_${primaryObj}`;
                    const lastPos = window.movementTracker[trackerId];
                    
                    let trajectoryMsg = "";
                    if (lastPos && lastPos.zone !== zone && (now - lastPos.time < 60000)) {
                        const isIncoming = zoneSequence[zone] > (zoneSequence[lastPos.zone] || 0);
                        trajectoryMsg = isIncoming 
                            ? `rör sig nu in från ${lastPos.zone.toLowerCase()} till ${zone.toLowerCase()}`
                            : `lämnar ${lastPos.zone.toLowerCase()} mot ${zone.toLowerCase()}`;
                    } else {
                        trajectoryMsg = `syns nu vid ${zone.toLowerCase()}`;
                    }
                    
                    window.movementTracker[trackerId] = { zone, time: now };

                    const alertKey = `${zone}_${primaryObj}_global_v2`;
                    if (!window.lastAlerts[alertKey] || now - window.lastAlerts[alertKey] > (isVaktActive ? 3000 : 7000)) {
                        window.lastAlerts[alertKey] = now;
                        
                        const snap = await vision.captureSnapshot(cam);
                        if (snap) {
                            vision.analyzeIntruder(snap, primaryObj).then(async (analysis) => {
                                let cleanDesc = analysis.description
                                    .replace(/\[.*?\]/g, '') // Ta bort [TAGS]
                                    .replace(/\*\*/g, '')    // Ta bort stjärnor
                                    .trim();

                                let voiceMsg = "";

                                if (window.isLukasMode) {
                                    voiceMsg = `Lukas, en ${analysis.classification.toLowerCase()} ${trajectoryMsg}. ${cleanDesc}`;
                                } else {
                                    voiceMsg = `Varning! ${isCar ? 'Ett fordon' : 'En person'} ${trajectoryMsg}. ${cleanDesc}`;
                                }

                                if (window.isHome && !window.isSleeping) audio.speak(voiceMsg);
                                window.appendMessage('AI', `🚨 [VAKT-LOGG] ${voiceMsg}`);

                                if (analysis.threatLevel >= 2 || (!window.isHome && zone !== "Infarten")) {
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
