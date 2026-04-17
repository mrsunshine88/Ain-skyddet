/**
 * VISION.JS - Hanterar kamera, ansiktsigenkänning och humöranalys
 * 
 * ⚠️ SYSTEM ARKITEKTUR VARNING (RIDDAR-PROTOKOLLET)
 * JARVIS/Travis ska vara BLIND i viloläge. 
 * Denna modul får aldrig användas för att tjuvlyssna på live-strömmar i bakgrunden.
 * Travis får endast se bilder som skickas explicit från Frigate efter en bekräftad händelse.
 * Inga modifieringar av denna arkitektur utan föregående plan och godkännande.
 */

export class Vision {
    constructor(videoElement, canvasElement, brain) {
        this.video = videoElement || null;
        this.canvas = canvasElement;
        this.brain = brain;
        this.visionModel = 'llama3.2-vision:latest';
        this.isOllamaBusy = false;
        this.activeUser = null;
        this.lastObservedUser = "none";
        this.lastSeenTime = 0; // Tidpunkt då användaren senast sågs med säkerhet
        this.presenceBuffer = 10000; // 10 sekunders minne
        this.externalSources = {}; // För D-Link kameror
    }

    async analyzeMood(sourceElement = null) {
        const source = sourceElement || this.video;
        // Behåll tänk-spärr för tyngre vision-analys (mood)
        if (window.isThinking || (source instanceof HTMLVideoElement && source.readyState !== 4)) return null;

        const off = document.createElement('canvas');
        off.width = 320;
        off.height = 240;
        off.getContext('2d').drawImage(source, 0, 0, 320, 240);
        const img = off.toDataURL('image/jpeg', 0.5).split(',')[1];

        try {
            const host = window.location.hostname || '127.0.0.1';
            const res = await fetch(`http://${host}:11434/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: this.visionModel,
                    messages: [
                        { role: 'user', content: "Beskriv personens humör och fokus med en naturlig svensk mening (max 15 ord). INSTRUKTION: Skriv naturligt och vänligt på svenska.", images: [img] }
                    ],
                    options: { keep_alive: "5m", temperature: 0.1, num_predict: 20 },
                    stream: false
                })
            });
            const data = await res.json();
            let insight = data.message?.content || "";

            // --- SANERING: Ta bort eventuell arabiska/skräptecken ---
            insight = insight.replace(/[\u0600-\u06FF]/g, '').trim();

            // --- BUGGFIX: Tvinga 2:a person (Du istället för Andreas/Han/Hon) ---
            insight = insight.toLowerCase()
                .replace(/\b(han|hon)\b/g, 'du')
                .replace(/\bandreas\b/g, 'du')
                .replace(/ ser /g, ' ser ut ')
                .trim();

            // Stor bokstav i början
            insight = insight.charAt(0).toUpperCase() + insight.slice(1);

            if (this.activeUser && this.activeUser !== "Okänd") {
                this.brain.addInsight(this.activeUser, insight);

                // --- NYTT: Uppdatera globalt humör för spegling ---
                if (insight.toLowerCase().includes("stress") || insight.toLowerCase().includes("trött")) {
                    this.brain.brainData.general.current_mood = "Stressed";
                } else if (insight.toLowerCase().includes("glad") || insight.toLowerCase().includes("positiv")) {
                    this.brain.brainData.general.current_mood = "Happy";
                } else {
                    this.brain.brainData.general.current_mood = "Neutral";
                }

                return insight;
            }
        } catch (e) {
            console.error("Vision-analysfel:", e);
        }
        return null;
    }

    getBrightness(ctx, width, height) {
        const imageData = ctx.getImageData(0, 0, width, height);
        const data = imageData.data;
        let r, g, b, avg;
        let colorSum = 0;

        for (let x = 0, len = data.length; x < len; x += 4) {
            r = data[x];
            g = data[x + 1];
            b = data[x + 2];
            avg = Math.floor((r + g + b) / 3);
            colorSum += avg;
        }

        return Math.floor(colorSum / (width * height));
    }



    // recognizeFace raderad enligt RIDDAR-PROTOKOLLET. JARVIS får inte identifiera själv.


    async registerFace(imageSource, name) {
        // Om imageSource är en base64-sträng, använd den. Annars ta en snapshot från videon.
        let base64 = imageSource;
        if (!imageSource.startsWith('data:image')) {
            const source = document.getElementById('academyPreview') || this.video || document.querySelector('video');
            const off = document.createElement('canvas');
            off.width = 640;
            off.height = 480;
            const ctx = off.getContext('2d');
            ctx.drawImage(source, 0, 0, 640, 480);
            base64 = off.toDataURL('image/jpeg', 0.95);
        }

        return new Promise((resolve) => {
            const globalTimeout = setTimeout(() => {
                console.error("Registrering avbruten: Servern svarade inte inom 60s.");
                resolve({ success: false, error: "AI_SERVER_OVERLOAD" });
            }, 60000);

            const rawBase64 = base64.replace(/^data:image\/jpeg;base64,/, "");
            const binaryString = window.atob(rawBase64);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }
            const blob = new Blob([bytes], { type: 'image/jpeg' });

            if (!blob) {
                clearTimeout(globalTimeout);
                resolve({ success: false, error: "IMAGE_FAIL" });
                return;
            }

            const fd = new FormData();
            fd.append('image', blob, 'face.jpg');
            fd.append('userid', name);

            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 55000);

                fetch('http://127.0.0.1:32168/v1/vision/face/register', {
                    method: 'POST',
                    body: fd,
                    signal: controller.signal
                }).then(async (res) => {
                    clearTimeout(timeoutId);
                    clearTimeout(globalTimeout);

                    if (res.ok) {
                        this.activeUser = name;
                        // Spara fysiskt till disk
                        window.ipcRenderer.invoke('save-face-image', {
                            base64: base64,
                            name: name
                        }).catch(e => console.error("Kunde inte spara fysisk träningsbild:", e));

                        resolve({ success: true });
                    } else {
                        resolve({ success: false, error: `SERVER_ERR_${res.status}` });
                    }
                }).catch(e => {
                    clearTimeout(timeoutId);
                    clearTimeout(globalTimeout);
                    resolve({ success: false, error: "CONNECTION_FAIL" });
                });
            } catch (e) {
                clearTimeout(globalTimeout);
                resolve({ success: false, error: "CONNECTION_FAIL" });
            }
        });
    }

    // --- NYTT: BURST-REGISTRERING (5 foton) ---
    async registerFaceBurst(name, onProgress) {
        let successCount = 0;
        const source = document.getElementById('academyPreview') || this.video || document.querySelector('video');

        for (let i = 0; i < 5; i++) {
            if (onProgress) onProgress(i + 1);

            // Pausa 800ms för att låta renderingen hinna med och undvika svarta bilder från nystartad kamera
            await new Promise(r => setTimeout(r, 800));

            const snap = await this.captureSnapshot(source);
            if (snap) {
                // 1. Spara till AI-motorns minne
                const ok = await this.registerFace(snap, name);
                if (ok) {
                    successCount++;
                    // 2. Spara fysiskt till disk (profiles-mappen)
                    try {
                        const { ipcRenderer } = require('electron');
                        await ipcRenderer.invoke('save-face-image', { name, base64: snap });
                    } catch (e) {
                        console.warn("Kunde inte spara Academy-bild till disk:", e);
                    }
                }
            }
            await new Promise(r => setTimeout(r, 600));
        }
        return successCount >= 3;
    }

    // recognizePlate raderad enligt RIDDAR-PROTOKOLLET.


    // recognizeFaceFromBase64 raderad enligt RIDDAR-PROTOKOLLET.




    async deleteFace(name) {
        if (!name || name === "Okänd") return false;
        const fd = new FormData();
        fd.append('userid', name);

        try {
            await fetch('http://localhost:32168/v1/vision/face/delete', {
                method: 'POST',
                body: fd
            });
            this.activeUser = "Okänd";
            return true;
        } catch (e) {
            console.error("Kunde inte radera ansikte:", e);
            return false;
        }
    }

    async detectObjects(sourceElement = null) {
        const source = sourceElement || this.video;
        if (source instanceof HTMLVideoElement && source.readyState !== 4) return [];

        const off = document.createElement('canvas');
        off.width = 640;
        off.height = 480;
        const ctx = off.getContext('2d');
        ctx.drawImage(source, 0, 0, 640, 480);

        return new Promise((resolve) => {
            off.toBlob(async (blob) => {
                if (!blob) { resolve([]); return; }
                const fd = new FormData();
                fd.append('image', blob, 'surveillance.jpg');
                fd.append('min_confidence', '0.15');

                try {
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), 20000); // 20 sekunder. CP AI behöver tid första gången en modell startas.

                    const res = await fetch('http://127.0.0.1:32168/v1/vision/detection', {
                        method: 'POST',
                        body: fd,
                        signal: controller.signal
                    });
                    clearTimeout(timeoutId);
                    const data = await res.json();
                    if (!data.success) {
                        console.error("[DEBUG YOLO] API Error:", data.error || data);
                        window.lastYoloError = data.error || "Okänt fel";
                    } else if (data.predictions) {
                        window.lastYoloSuccess = true;
                    }
                    resolve(data.success ? data.predictions : []);
                } catch (e) {
                    console.error("Objektsdetektering misslyckades:", e);
                    window.lastYoloError = e.message;
                    resolve([]);
                }
            }, 'image/jpeg', 0.82);
        });
    }

    // detectPlate raderad enligt RIDDAR-PROTOKOLLET.


    // --- NYTT: Ta en ögonblicksbild för notiser ---
    async captureSnapshot(sourceElement = null) {
        const source = sourceElement || this.video;
        if (source instanceof HTMLVideoElement && source.readyState !== 4) return null;

        const off = document.createElement('canvas');
        const w = source.videoWidth || source.naturalWidth || 1280;
        const h = source.videoHeight || source.naturalHeight || 720;
        off.width = w;
        off.height = h;
        const ctx = off.getContext('2d');
        ctx.drawImage(source, 0, 0, w, h);

        // Ögonblicksbilder får också natt-boost om det behövs
        const brightness = this.getBrightnessFromCanvas(off);
        if (brightness < 80) {
            ctx.filter = 'contrast(1.2) brightness(1.2)';
            ctx.drawImage(off, 0, 0);
            ctx.filter = 'none';
        }

        return off.toDataURL('image/jpeg', 0.85);
    }

    getBrightnessFromCanvas(canvas) {
        const ctx = canvas.getContext('2d');
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let sum = 0;
        for (let i = 0; i < data.length; i += 4) {
            sum += (data[i] + data[i + 1] + data[i + 2]) / 3;
        }
        return sum / (canvas.width * canvas.height);
    }

    async scanExternal(imgSource, zoneName) {
        // Kan ta emot antingen ett HTML-element eller en base64-sträng
        let blob;
        if (typeof imgSource === 'string' && imgSource.startsWith('data:')) {
            const rawBase64 = imgSource.split(',')[1];
            const binary = atob(rawBase64);
            const array = [];
            for (let i = 0; i < binary.length; i++) array.push(binary.charCodeAt(i));
            blob = new Blob([new Uint8Array(array)], { type: 'image/jpeg' });
        } else if (imgSource) {
            const off = document.createElement('canvas');
            const w = imgSource.videoWidth || imgSource.naturalWidth || 1280;
            const h = imgSource.videoHeight || imgSource.naturalHeight || 720;
            off.width = w; off.height = h;
            off.getContext('2d').drawImage(imgSource, 0, 0, w, h);
            blob = await new Promise(r => off.toBlob(r, 'image/jpeg', 0.8));
        }

        if (!blob) return null;

        return new Promise((resolve) => {
            const fd = new FormData();
            fd.append('image', blob, `${zoneName}.jpg`);
            fd.append('min_confidence', '0.15');

            fetch('http://127.0.0.1:32168/v1/vision/face/recognize', { method: 'POST', body: fd })
                .then(res => res.json())
                .then(data => {
                    if (data.success && data.predictions?.length > 0) {
                        const users = data.predictions.map(p => p.userid || p.label || "Okänd");
                        resolve({ zone: zoneName, users });
                    } else resolve({ zone: zoneName, users: [] });
                })
                .catch(e => { console.error("Face scan fail:", e); resolve(null); });
        });
    }

    // --- NYTT: SMART GUARD VISION ---
    async getSnapshotFromFrigate(eventId, crop = false) {
        if (!eventId) return null;

        // --- FAS 1: INITIAL PAUS (1.5 sekunder) ---
        // För att ge Frigate tid att buffra och skriva ner händelse-bilden på hårddisken.
        console.log(`[JARVIS-RETRY] Väntar 1.5s innan första hämtningsförsöket...`);
        await new Promise(r => setTimeout(r, 1500));

        const host = window.location.hostname || 'localhost';
        // bbox=1&crop=1 klipper ut HELA människan/bilen från trädgården
        const url = `http://${host}:5050/api/events/${eventId}/snapshot.jpg?bbox=1&crop=1`;

        // --- FAS 2: RETRY-LOOP (5 försök) ---
        for (let i = 1; i <= 5; i++) {
            try {
                console.log(`[JARVIS-RETRY] Försök ${i}/5 att hämta utklipp: ${url}`);
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 10000);

                const res = await fetch(url, { signal: controller.signal });
                clearTimeout(timeoutId);

                if (res.ok) {
                    console.log(`[JARVIS-RETRY] ✅ Utklipp hämtat på försök ${i}!`);
                    const blob = await res.blob();
                    return new Promise((resolve) => {
                        const reader = new FileReader();
                        reader.onloadend = () => resolve(reader.result);
                        reader.readAsDataURL(blob);
                    });
                }

                console.warn(`[JARVIS-RETRY] ⚠️ Försök ${i} misslyckades (Status: ${res.status}). Väntar 1s...`);
            } catch (e) {
                console.error(`[JARVIS-RETRY] ❌ Nätverksfel vid försök ${i}:`, e.message);
            }

            if (i < 5) await new Promise(r => setTimeout(r, 1000));
        }

        console.error(`[JARVIS-RETRY] 💀 Gav upp efter 5 försök. Inget utklipp hittades.`);
        return null;
    }


    // --- NYTT: TRÄNA ANSIKTE ---
    async registerFaceFromBase64(name, base64Image) {
        if (!base64Image) return false;
        try {
            // Stabil metod: Skapa blob manuellt för att undvika nätverksfel i Electron
            const rawBase64 = base64Image.replace(/^data:image\/\w+;base64,/, "");
            const binaryString = window.atob(rawBase64);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }
            const blob = new Blob([bytes], { type: 'image/jpeg' });

            const fd = new FormData();
            fd.append('image', blob, `${name}.jpg`);
            fd.append('userid', name);
            fd.append('name', name);
            fd.append('id', name);

            const host = '127.0.0.1';
            const res = await fetch(`http://${host}:32168/v1/vision/face/register`, {
                method: 'POST',
                body: fd
            });

            const data = await res.json();
            console.log(`[ACADEMY] Registreringssvar för ${name}:`, data);
            return data.success === true || data.code === 200;
        } catch (e) {
            console.error("[ACADEMY] Fel vid ansiktsregistrering:", e);
            return false;
        }
    }

    async analyzeIntruder(snap, label, identity = null, camera = "", movementContext = "") {
        this.isOllamaBusy = true;
        try {
            const labelMap = { "person": "person", "car": "bil", "motorcycle": "motorcykel", "dog": "hund", "cat": "katt" };
            const labelSwe = labelMap[label] || label;

            // Separata instruktioner för person vs bil
            const personInstructions = `BESKRIV ENDAST OM DU SER EN PERSON. Om ingen person syns, skriv "Ingen person syns".

FORMAT: [Namn/Okänd] [kille/tjej] med/utan glasögon syns vid [plats]. Personen har [färg] tröja och [färg] byxor.

REGLER:
- Använd namnet från DATA om det är känt (t.ex. Andreas)
- Om ingen person syns, skriv "Ingen person syns"
- Beskriv ENDAST det du faktiskt ser
- Max 15 ord`;

            const carInstructions = `BESKRIV ENDAST BILEN. Om ingen bil syns, skriv "Ingen bil syns".

FORMAT: [Ägare/Namn] en [färg] bil. [Märke ENDAST om namn/logotyp syns tydligt].

REGLER:
- Använd ägare från DATA om det är känt (t.ex. Andreas bil)
- Om ingen bil syns, skriv "Ingen bil syns"
- Skriv aldrig "modell okänd"
- Max 10 ord`;

            // Välj rätt instruktioner baserat på label
            const reportInstructions = label === 'person' ? personInstructions : carInstructions;

            const finalPrompt = label === 'person'
                ? `${reportInstructions}\n\nDATA: Namn: ${identity || 'Okänd'}, Plats: ${camera || 'Utomhus'}. Analysera bilden.`
                : `${reportInstructions}\n\nDATA: Ägare: ${identity || 'Okänd'}, Plats: ${camera || 'Utomhus'}. Analysera bilden.`;


            // Robust bildrensning (Hämta ren base64)
            const img = (typeof snap === 'string' && snap.includes(',')) ? snap.split(',')[1] : snap;
            if (!img) return { description: "Bildfel: Kunde inte avkoda fotot.", classification: "Okänd", threatLevel: 1 };

            console.log(`[VISION-DIAG] Skickar analys till GPU (Modell: ${this.visionModel})...`);

            const host = window.location.hostname || '127.0.0.1';
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 90000); // 90s timeout för llama3.2-vision

            const res = await fetch(`http://${host}:11434/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: this.visionModel,
                    messages: [
                        { role: 'user', content: finalPrompt, images: [img] }
                    ],
                    stream: false
                }),
                signal: controller.signal
            });

            clearTimeout(timeoutId);
            const data = await res.json();
            const content = data.message?.content || "Analys misslyckades.";

            return { description: content, classification: "Bevakning", threatLevel: 1 };
        } catch (e) {
            console.error("[VISION-DIAG] VLM-Beskrivning misslyckades:", e);
            return { description: "Analys misslyckades på grund av tekniskt fel.", classification: "Okänd", threatLevel: 1 };
        } finally {
            this.isOllamaBusy = false;
        }
    }

    // --- NYTT: VQA OCH DIREKT SYN-FRÅGOR ---
    async askVision(base64Image, questionText) {
        if (!base64Image) return "";
        try {
            const rawBase64 = base64Image.replace(/^data:image\/jpeg;base64,/, "");
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 60000);

            // NEUTRALISERAD SYSTEM-PROMPT (För att undvika AI-vägran)
            const systemPrompt = "Du är en assistent som beskriver bilder objektivt på svenska. Titta noga på bilden och svara kortfattat på användarens fråga. Beskriv färger, former och handlingar utan att nämna övervakning eller säkerhet.";

            const host = window.location.hostname || '127.0.0.1';
            const res = await fetch(`http://${host}:11434/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: this.visionModel,
                    messages: [
                        { role: 'user', content: `INSTRUKTION: Svara på svenska. ${questionText}`, images: [rawBase64] }
                    ],
                    options: { num_predict: 250, temperature: 0.0, keep_alive: "5m" },
                    stream: false
                }),
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            const data = await res.json();
            let content = data.message?.content || "";

            // --- SANERING: Ta bort eventuell arabiska ---
            content = content.replace(/[\u0600-\u06FF]/g, '').trim();

            return content;
        } catch (e) {
            console.error("VQA-fråga misslyckades:", e);
            return "";
        }
    }

    // --- NYTT: FRIGATE SANNINGSLOGIK ---
    async checkActiveDetections(cameraName) {
        try {
            const res = await fetch(`http://localhost:5050/api/events?active=1&camera=${cameraName}`);
            if (!res.ok) {
                console.warn(`[VISION-DIAG] Frigate returnerade felkod ${res.status} för ${cameraName}`);
                return null;
            }
            const events = await res.json();
            return (events && events.length > 0) ? events[0] : null;
        } catch (e) {
            console.error(`[VISION-DIAG] Kunde inte nå Frigate API på 5050 för ${cameraName}:`, e);
            return null;
        }
    }

    // --- NYTT: HÄMTA DATA FÖR SPECIFIKT EVENT (Blixtsnabb identifiering) ---
    async getEventData(eventId) {
        if (!eventId) return null;
        try {
            const host = window.location.hostname || 'localhost';
            const res = await fetch(`http://${host}:5050/api/events/${eventId}`);
            if (!res.ok) return null;
            return await res.json();
        } catch (e) { return null; }
    }

    // --- NYTT: HÄMTA SENAST LÄSTA REGNUMMER (För manuella frågor) ---
    async getLatestPlate(cameraName) {
        if (!cameraName) return null;
        try {
            console.log(`[VISION-DIAG] Aktiv sökning efter regnummer vid ${cameraName}...`);
            const host = window.location.hostname || 'localhost';

            // 1. Kolla först om det finns ett AKTIVT objekt med en skylt just nu
            const activeRes = await fetch(`http://${host}:5050/api/events?camera=${cameraName}&active=1&has_sub_label=1&limit=1`);
            if (activeRes.ok) {
                const activeEvents = await activeRes.json();
                if (activeEvents.length > 0 && activeEvents[0].sub_label) {
                    console.log(`[VISION-DIAG] Hittade aktiv skylt: ${activeEvents[0].sub_label}`);
                    return activeEvents[0].sub_label;
                }
            }

            // 2. Fallback: Kolla det senaste avslutade eventet med skylt
            const res = await fetch(`http://${host}:5050/api/events?camera=${cameraName}&limit=1&has_sub_label=1`);
            if (res.ok) {
                const events = await res.json();
                if (events.length > 0 && events[0].sub_label) {
                    return events[0].sub_label;
                }
            }
            return null;
        } catch (e) {
            console.error(`[VISION-DIAG] Kunde inte hämta LPR-metadata:`, e);
            return null;
        }
    }
}

