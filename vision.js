/**
 * VISION.JS - Hanterar kamera, ansiktsigenkänning och humöranalys
 */

export class Vision {
    constructor(videoElement, canvasElement, brain) {
        this.video = videoElement || null;
        this.canvas = canvasElement;
        this.brain = brain;
        this.visionModel = 'llama3.2-vision';
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
            const res = await fetch('http://127.0.0.1:11434/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: this.visionModel,
                    messages: [
                        { role: 'system', content: "Du är en AI-assistent som observerar personen framför dig. Beskriv kortfattat hur personen verkar må och om de ser ut att vara uppmärksamma på dig. Skriv naturligt, som en vän." },
                        { role: 'user', content: "Beskriv personen och deras humör/fokus. Max 6 ord.", images: [img] }
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

    getBrightness() {
        const ctx = this.canvas.getContext('2d');
        const imageData = ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
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

        return Math.floor(colorSum / (this.canvas.width * this.canvas.height));
    }

    // --- NYTT: FÖRSTÄRK MÖRKERBILDER ---
    enhanceNightImage(ctx, width, height) {
        const brightness = this.getBrightness();
        if (brightness < 80) {
            // Justerad till 1.2 för att eliminera digitalt brus enligt instruktion
            ctx.filter = 'contrast(1.2) brightness(1.2)';
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = width;
            tempCanvas.height = height;
            tempCanvas.getContext('2d').drawImage(this.canvas, 0, 0);
            ctx.filter = 'none';
            ctx.drawImage(tempCanvas, 0, 0);
            console.log(`[Vision] Natt-optimering (Ljusstyrka: ${brightness})`);
        }
    }

    async recognizeFace(sourceElement = null) {
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
                fd.append('image', blob, 'scan.jpg');
                fd.append('min_confidence', '0.15');
                
                try {
                    const res = await fetch('http://127.0.0.1:32168/v1/vision/face/recognize', { 
                        method: 'POST', 
                        body: fd 
                    });
                    const data = await res.json();
                    let detectedUsers = [];
                    
                    if (data.success && data.predictions?.length > 0) {
                        detectedUsers = data.predictions.map(p => p.userid || p.label || "Okänd");
                    }
                    
                    const primaryName = detectedUsers[0] || "Okänd";
                    const now = Date.now();

                    if (primaryName !== "Okänd") {
                        this.lastSeenTime = now;
                        if (primaryName !== this.activeUser) {
                            if (this.activeUser === "Andreas") this.brain.logEvent("System", "Andreas lämnade.");
                            else this.brain.logEvent(primaryName, "dök upp.");
                        }
                        this.activeUser = primaryName;
                    } else {
                        if (now - this.lastSeenTime > this.presenceBuffer) {
                            this.activeUser = "Okänd";
                        }
                    }
                    
                    this.lastObservedUser = primaryName;
                    resolve(detectedUsers);
                } catch (e) {
                    console.error("Ansiktsigenkänning misslyckades:", e);
                    resolve([]);
                }
            }, 'image/jpeg');
        });
    }

    async registerFace(name) {
        const off = document.createElement('canvas');
        off.width = 640;
        off.height = 480;
        const ctx = off.getContext('2d');
        const source = this.video || document.querySelector('video');
        ctx.drawImage(source, 0, 0, 640, 480);
        
        return new Promise((resolve) => {
            const globalTimeout = setTimeout(() => {
                console.error("Registrering avbruten: Servern svarade inte inom 60s.");
                resolve({ success: false, error: "AI_SERVER_OVERLOAD" });
            }, 60000);

            off.toBlob(async (blob) => {
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

                    const res = await fetch('http://127.0.0.1:32168/v1/vision/face/register', { 
                        method: 'POST', 
                        body: fd,
                        signal: controller.signal
                    });
                    
                    clearTimeout(timeoutId);
                    clearTimeout(globalTimeout);
                    
                    if (res.ok) {
                        this.activeUser = name;
                        resolve({ success: true });
                    } else {
                        resolve({ success: false, error: `SERVER_ERR_${res.status}` });
                    }
                } catch (e) {
                    clearTimeout(globalTimeout);
                    resolve({ success: false, error: e.name === 'AbortError' ? "SERVER_STUCK" : "CONNECTION_FAIL" });
                }
            }, 'image/jpeg', 0.95);
        });
    }

    // --- NYTT: BURST-REGISTRERING (10 foton) ---
    async registerFaceBurst(name, onProgress) {
        let successCount = 0;
        const source = this.video || document.querySelector('video');
        
        for (let i = 0; i < 5; i++) {
            if (onProgress) onProgress(i + 1);
            const snap = await this.captureSnapshot(source);
            if (snap) {
                const ok = await this.registerFace(snap, name);
                if (ok) successCount++;
            }
            await new Promise(r => setTimeout(r, 600)); // 600ms mellanrum för att få olika vinklar
        }
        return successCount >= 3; // Kräver minst 3 lyckade bilder
    }

    // --- NYTT: AKTIVT ANSIKTSMINNE ---
    // Möjliggör The AI att "träna" in ett ansikte i efterhand direkt från utekamerans larmbild
    async recognizeFaceFromBase64(base64) {
        if (!base64) return null;
        try {
            const rawBase64 = base64.replace(/^data:image\/jpeg;base64,/, "");
            const res = await fetch('http://127.0.0.1:32168/v1/vision/face/recognize', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ image: rawBase64, min_confidence: 0.5 })
            });
            const data = await res.json();
            if (data.success && data.predictions && data.predictions.length > 0) {
                const best = data.predictions[0];
                if (best.userid && best.userid !== "unknown") return best.userid;
            }
        } catch (e) {
            console.error("[VISION] Ansiktsigenkänning misslyckades:", e);
        }
        return null;
    }

    async registerFaceFromBase64(name, base64Image) {
        if (!base64Image || !name) return false;
        try {
            const rawBase64 = base64Image.replace(/^data:image\/jpeg;base64,/, "");
            const binaryString = window.atob(rawBase64);
            const len = binaryString.length;
            const bytes = new Uint8Array(len);
            for (let i = 0; i < len; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }
            const blob = new Blob([bytes], { type: 'image/jpeg' });
            
            const fd = new FormData();
            fd.append('image', blob, 'training.jpg');
            fd.append('userid', name);
            
            const res = await fetch('http://localhost:32168/v1/vision/face/register', { 
                method: 'POST', 
                body: fd 
            });
            const data = await res.json();
            return data.success;
        } catch (e) {
            console.error("Aktiv träning misslyckades:", e);
            return false;
        }
    }

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

    async detectPlate(imgSource) {
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
            blob = await new Promise(r => off.toBlob(r, 'image/jpeg', 0.95));
        }

        if (!blob) return null;

        const fd = new FormData();
        fd.append('image', blob, 'plate.jpg');
        
        try {
            const res = await fetch('http://127.0.0.1:32168/v1/vision/alpr', { method: 'POST', body: fd });
            const data = await res.json();
            if (data.success && data.predictions?.length > 0) {
                return { plate: data.predictions[0].plate, confidence: data.predictions[0].confidence };
            }
        } catch (e) { console.error("ALPR fail:", e); }
        return null;
    }

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
            sum += (data[i] + data[i+1] + data[i+2]) / 3;
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
    async getSnapshotFromFrigate(eventId) {
        if (!eventId) return null;
        try {
            console.log(`[VISION-DIAG] Försöker hämta händelse-snapshot för ${eventId}...`);
            const res = await fetch(`http://localhost:5050/api/events/${eventId}/snapshot.jpg`);
            if (!res.ok) return null;
            const blob = await res.blob();
            return new Promise((resolve) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result);
                reader.readAsDataURL(blob);
            });
        } catch (e) { return null; }
    }

    // --- NYTT: Hämta bild i exakt realtid (Strunta i gamla händelser) ---
    async getLiveSnapshotFromFrigate(cameraName) {
        try {
            console.log(`[VISION-DIAG] Tar ett live-foto från ${cameraName} just nu...`);
            const res = await fetch(`http://localhost:5050/api/${cameraName}/latest.jpg`);
            if (!res.ok) return null;
            const blob = await res.blob();
            return new Promise((resolve) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result);
                reader.readAsDataURL(blob);
            });
        } catch (e) { return null; }
    }

    // --- NYTT: TRÄNA ANSIKTE ---
    async registerFace(base64Image, name) {
        if (!base64Image) return false;
        try {
            const rawBase64 = base64Image.replace(/^data:image\/jpeg;base64,/, "");
            const blob = await (await fetch(base64Image)).blob();
            
            const fd = new FormData();
            fd.append('image', blob, `${name}.jpg`);
            fd.append('userid', name);

            const res = await fetch('http://127.0.0.1:32168/v1/vision/face/register', {
                method: 'POST',
                body: fd
            });
            const data = await res.json();
            console.log(`[ACADEMY] Registreringssvar för ${name}:`, data);
            return data.success;
        } catch (e) {
            console.error("[ACADEMY] Fel vid ansiktsregistrering:", e);
            return false;
        }
    }

    async analyzeIntruder(snap, label, camera = "") {
        try {
            let context = "Beskriv vad du ser.";
            if (camera === "Infarten") context = "Gatan är längst upp, uppfarten är i mitten. Ignorera den SILVER-färgade bilen som alltid står parkerad där.";
            else if (camera === "Ytterdorren") context = "Du ser ytterdörren och trappen.";

            const prompt = `Du är JARVIS. Titta på bilden och berätta på naturlig svenska vad du ser.
            Håll det kort (max 20 ord) och undvik listor eller rubriker.
            Kamera: ${camera}. Objekt i rörelse: ${label}. Kontext: ${context}`;
            
            const rawBase64 = snap.replace(/^data:image\/jpeg;base64,/, "");
            
            const res = await fetch('http://127.0.0.1:11434/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: this.visionModel,
                    messages: [
                        { role: 'system', content: prompt },
                        { role: 'user', content: "Statusrapport för bilden.", images: [rawBase64] }
                    ],
                    options: { num_predict: 500, temperature: 0.1 }, // Höjd gräns för att slippa avklippta meningar.
                    stream: false
                })
            });
            const data = await res.json();
            const content = data.message?.content || "";
            
            // Extrahering för intelligenta beslut
            let classification = label === "person" ? "Människa" : "Fordon";
            let threatLevel = 1;

            if (content.toLowerCase().includes("barn")) classification = "Barn";
            if (content.toUpperCase().includes("HOT: HÖG")) threatLevel = 3;
            else if (content.toUpperCase().includes("HOT: MEDEL")) threatLevel = 2;

            return {
                description: content,
                classification: classification,
                threatLevel: threatLevel,
                isAccident: content.toLowerCase().includes("marken") || content.toLowerCase().includes("skadad")
            };
        } catch (e) {
            console.error("VLM-Beskrivning misslyckades:", e);
            return { description: "Analys misslyckades.", classification: "Okänd", threatLevel: 1 };
        }
    }

    // --- NYTT: VQA OCH DIREKT SYN-FRÅGOR ---
    async askVision(base64Image, questionText) {
        if (!base64Image) return "";
        try {
            const rawBase64 = base64Image.replace(/^data:image\/jpeg;base64,/, "");
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 45000);

            // NYTT: System-prompt för att dölja instruktionerna från användaren
            const systemPrompt = "Du är en assistent som analyserar säkerhetskameror. Titta extremt noga på bilden. Om du ser fordon, beskriv deras färg och märke. Svara kortfattat och ta inte med instruktionerna i ditt svar.";

            const res = await fetch('http://127.0.0.1:11434/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: this.visionModel,
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: questionText, images: [rawBase64] }
                    ],
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

    // --- NYTT: TOTAL SCAN (Alla kameror samtidigt) ---
    async checkAllActiveDetections() {
        try {
            const res = await fetch(`http://localhost:5050/api/events?active=1`);
            if (!res.ok) return [];
            return await res.json();
        } catch (e) {
            console.error(`[VISION-DIAG] Kunde inte nå Frigate API för total-scan:`, e);
            return [];
        }
    }
}

