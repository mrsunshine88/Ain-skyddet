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
        this.visionModel = 'minicpm-v';
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
                        { role: 'system', content: "Du är en AI-assistent som observerar personen framför dig. Beskriv kortfattat hur personen verkar må och om de ser ut att vara uppmärksamma på dig. Skriv naturligt och vänligt på svenska." },
                        { role: 'user', content: "Beskriv personens humör och fokus med en naturlig svensk mening (max 15 ord).", images: [img] }
                    ],
                    stream: false
                })
            });
            const data = await res.json();
            let insight = data.message?.content || "";

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
        try {
            console.log(`[VISION-DIAG] Hämtar bild från Frigate Review API för ${eventId}...`);
            // VIKTIGT: I Frigate 0.17+ använder vi /api/review för händelser från 'reviews'-kanalen
            // bbox=0 tvingar Frigate att skicka en ren bild utan de rosa rutorna
            const url = `http://localhost:5050/api/review/${eventId}/snapshot.jpg?bbox=0${crop ? '&crop=1' : ''}`;
            const res = await fetch(url);
            
            if (!res.ok) {
                console.warn(`[VISION-DIAG] Review-bild saknas (404). Testar alternativt Event-API...`);
                // Fallback till gamla Event-API ifall det inte var en Review
                const fallbackUrl = `http://localhost:5050/api/events/${eventId}/snapshot.jpg?bbox=0${crop ? '&crop=1' : ''}`;
                const fallbackRes = await fetch(fallbackUrl);
                if (!fallbackRes.ok) return null;
                const blob = await fallbackRes.blob();
                return new Promise((resolve) => {
                    const reader = new FileReader();
                    reader.onloadend = () => resolve(reader.result);
                    reader.readAsDataURL(blob);
                });
            }

            const blob = await res.blob();
            return new Promise((resolve) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result);
                reader.readAsDataURL(blob);
            });
        } catch (e) { return null; }
    }

    // --- NYTT: HÄMTA LIVE-BILD FRÅN FRIGATE (Istället för direkt kamera) ---
    async getLiveSnapshotFromFrigate(cameraName) {
        if (!cameraName) return null;
        try {
            console.log(`[VISION-DIAG] Begär ny bild från Frigate för ${cameraName}...`);
            const host = window.location.hostname || 'localhost';
            const url = `http://${host}:5050/api/${cameraName}/latest.jpg`;
            const res = await fetch(url);
            if (!res.ok) return null;
            const blob = await res.blob();
            return new Promise((resolve) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result);
                reader.readAsDataURL(blob);
            });
        } catch (e) {
            console.error(`[VISION-DIAG] Kunde inte hämta live-bild för ${cameraName}:`, e);
            return null;
        }
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
        try {
            const labelMap = { "person": "person", "car": "bil", "motorcycle": "motorcykel", "dog": "hund", "cat": "katt" };
            const labelSwe = labelMap[label] || label;

            const promptPerson = `Beskriv personen snabbt.\nFORMAT: [Okänd/Namn], [Kläder], [Gör nåt].\nMAX 20 ORD. Inget flum.`;
            const promptVehicle = `Beskriv bilen snabbt.\nFORMAT: [Färg], [Typ/Modell], [Status].\nMAX 8 ORD. Inga gissningar. Om regnummer syns, skriv Plate: [Nummer].`;

            let finalPrompt = promptVehicle;
            if (label === 'person') finalPrompt = promptPerson;

            // Robust bildrensning som hanterar alla format (jpeg, png, webp etc)
            const rawBase64 = snap.replace(/^data:image\/\w+;base64,/, "");

            const host = '127.0.0.1';
            const res = await fetch(`http://${host}:11434/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: this.visionModel,
                    messages: [
                        { role: 'user', content: finalPrompt, images: [rawBase64] }
                    ],
                    options: {
                        num_predict: 80,
                        temperature: 0.1,
                        repeat_penalty: 1.2,
                        presence_penalty: 0.5,
                        repeat_last_n: 64,
                        top_p: 0.1
                    },
                    stream: false
                })
            }).catch(async () => {
                const remoteHost = window.location.hostname || '127.0.0.1';
                return await fetch(`http://${remoteHost}:11434/api/chat`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model: this.visionModel,
                        messages: [
                            { role: 'user', content: finalPrompt, images: [rawBase64] }
                        ],
                        options: {
                            num_predict: 80,
                            temperature: 0.1,
                            repeat_penalty: 1.6,
                            presence_penalty: 0.5,
                            repeat_last_n: 64,
                            top_p: 0.4
                        },
                        stream: false
                    })
                });
            });
            const data = await res.json();
            const content = data.message?.content || "";

            // Analysera innehåll för logik efteråt
            let classification = label === "person" ? "Människa" : "Fordon";
            let threatLevel = 1;
            let isChild = content.toLowerCase().includes("barn") || content.toLowerCase().includes("liten person");

            if (isChild) classification = "Barn";
            if (content.toLowerCase().includes("mask") || content.toLowerCase().includes("bryta") || content.toLowerCase().includes("smid") || content.toLowerCase().includes("hot")) threatLevel = 3;

            return {
                description: content,
                classification: classification,
                isChild: isChild,
                threatLevel: threatLevel,
                isAccident: content.toLowerCase().includes("marken") || content.toLowerCase().includes("skadad")
            };
        } catch (e) {
            console.error("VLM-Beskrivning misslyckades:", e);
            return { description: "Analys misslyckades på grund av tekniskt fel.", classification: "Okänd", threatLevel: 1 };
        }
    }

    // --- NYTT: VQA OCH DIREKT SYN-FRÅGOR ---
    async askVision(base64Image, questionText) {
        if (!base64Image) return "";
        try {
            const rawBase64 = base64Image.replace(/^data:image\/jpeg;base64,/, "");
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 45000);

            // NEUTRALISERAD SYSTEM-PROMPT (För att undvika AI-vägran)
            const systemPrompt = "Du är en assistent som beskriver bilder objektivt på svenska. Titta noga på bilden och svara kortfattat på användarens fråga. Beskriv färger, former och handlingar utan att nämna övervakning eller säkerhet.";

            const host = window.location.hostname || '127.0.0.1';
            const res = await fetch(`http://${host}:11434/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: this.visionModel,
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: questionText, images: [rawBase64] }
                    ],
                    options: { num_predict: 250, temperature: 0.0 },
                    stream: false
                }),
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            const data = await res.json();
            return data.message?.content || "";
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
            const res = await fetch(`http://localhost:5050/api/events/${eventId}`);
            if (!res.ok) return null;
            return await res.json();
        } catch (e) { return null; }
    }
}

