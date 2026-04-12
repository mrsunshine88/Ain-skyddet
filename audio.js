/**
 * AUDIO.JS - Hanterar röst (STT), tal (TTS) och ljudnivåer
 */

export class AudioHandler {
    constructor() {
        this.transcriber = null;
        this.audioContext = null;
        this.isCapturing = false;
        this.chunks = [];
        this.lastAudioTime = Date.now();
    }

    async initSTT(onStatusUpdate) {
        try {
            const transformers = await import('https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2');
            const { pipeline, env } = transformers;
            env.allowLocalModels = false;
            this.transcriber = await pipeline('speech-to-text', 'Xenova/whisper-tiny');
            onStatusUpdate("Hörsel redo");
            return true;
        } catch (e) {
            console.error("Kunde inte ladda Whisper:", e);
            onStatusUpdate("Hörsel-fel");
            return false;
        }
    }

    setupAudioProcessor(stream, callbacks) {
        this.audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
        const source = this.audioContext.createMediaStreamSource(stream);
        
        this.analyser = this.audioContext.createAnalyser();
        this.analyser.fftSize = 256;
        source.connect(this.analyser);
        
        const processor = this.audioContext.createScriptProcessor(2048, 1, 1);
        this.analyser.connect(processor);
        processor.connect(this.audioContext.destination);

        processor.onaudioprocess = (e) => {
            if (window.isThinking) return;
            
            const input = e.inputBuffer.getChannelData(0);
            let sum = 0;
            for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
            const vol = Math.sqrt(sum / input.length);
            this.currentVolume = vol;
            
            if (callbacks.onLevel) callbacks.onLevel(vol);
            
            if (this.isCapturing) {
                this.chunks.push(new Float32Array(input)); 
                
                // --- BUGGFIX: Sänkt tröskel (0.002 istället för 0.01) för bättre känslighet ---
                if (vol < 0.002 && (Date.now() - this.lastAudioTime > 2000)) {
                    this.stopCapture(callbacks.onStop, callbacks.onText);
                }
                if (vol > 0.002) this.lastAudioTime = Date.now();
            }
        };
    }

    getVolume() {
        return this.currentVolume || 0;
    }

    startCapture(onStart) {
        if (this.audioContext && this.audioContext.state === 'suspended') {
            this.audioContext.resume();
        }
        this.chunks = [];
        this.isCapturing = true;
        this.lastAudioTime = Date.now();
        if (onStart) onStart();
    }

    async stopCapture(onStop, onText) {
        if (!this.isCapturing) return;
        this.isCapturing = false;
        if (onStop) onStop();
        
        if (!this.transcriber || this.chunks.length === 0) return;

        const totalLength = this.chunks.reduce((acc, curr) => acc + curr.length, 0);
        const buf = new Float32Array(totalLength);
        let offset = 0;
        for (const chunk of this.chunks) { buf.set(chunk, offset); offset += chunk.length; }

        try {
            // --- BUGGFIX: Ändrat 'swedish' till 'sv' för bättre modellstöd ---
            const res = await this.transcriber(buf, { language: 'sv', task: 'transcribe' });
            const text = res.text.trim();
            
            if (text.length > 2) {
                if (onText) onText(text);
            }
        } catch (e) {
            console.error("Transkriberingsfel:", e);
        }
    }

    speak(text, options = {}) {
        window.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.lang = 'sv-SE'; 
        u.pitch = options.pitch || 0.9; 
        u.rate = options.rate || 1.0;
        u.volume = window.jarvisVolume !== undefined ? window.jarvisVolume : 0.5; // Respektera inställd volym
        window.speechSynthesis.speak(u);
    }

    // --- NYTT: TAKTISK AVLYSSNING ---
    async transcribeFromElement(mediaElement, durationMs = 20000) { // Standard 20s
        if (!mediaElement || !this.transcriber) return null;
        
        console.log(`[AVLYSSNING] Startar ${durationMs/1000}s inspelning av ${mediaElement.id}...`);
        
        return new Promise((resolve) => {
            const tempCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
            
            // Vi skapar en GainNode för att kunna kontrollera volymen under inspelningen om det behövs
            const gain = tempCtx.createGain();
            const source = tempCtx.createMediaElementSource(mediaElement);
            const processor = tempCtx.createScriptProcessor(4096, 1, 1);
            
            const chunks = [];
            source.connect(gain);
            gain.connect(processor);
            processor.connect(tempCtx.destination);
            
            processor.onaudioprocess = (e) => {
                const input = e.inputBuffer.getChannelData(0);
                chunks.push(new Float32Array(input));
            };
            
            setTimeout(async () => {
                try {
                    processor.disconnect();
                    source.disconnect();
                    
                    if (chunks.length === 0) {
                        resolve(null);
                        return;
                    }

                    const totalLength = chunks.reduce((acc, curr) => acc + curr.length, 0);
                    const buf = new Float32Array(totalLength);
                    let offset = 0;
                    for (const chunk of chunks) { buf.set(chunk, offset); offset += chunk.length; }
                    
                    // Transkribera med Whisper
                    const res = await this.transcriber(buf, { language: 'sv', task: 'transcribe' });
                    resolve(res.text.trim());
                } catch (e) {
                    console.error("Extern transkriberingsfel:", e);
                    resolve(null);
                } finally {
                    tempCtx.close();
                }
            }, durationMs);
        });
    }

    // --- NYTT: LJUD-KLASSIFICERING (CodeProject.AI) ---
    async classifySound(audioBuffer) {
        // Konvertera Float32Array till WAV-blob för CodeProject.AI
        const wavBlob = this.float32ToWav(audioBuffer, 16000);
        const formData = new FormData();
        formData.append("audio", wavBlob, "capture.wav");

        try {
            const response = await fetch("http://localhost:32168/v1/audio/classify", {
                method: "POST",
                body: formData
            });
            const data = await response.json();
            return data.success ? data.predictions : [];
        } catch (e) {
            console.error("[AUDIO] Kunde inte klassificera ljud:", e);
            return [];
        }
    }

    // Hjälpmetod för att skapa WAV-filer (Behövs för CP.AI API)
    float32ToWav(buffer, sampleRate) {
        const length = buffer.length * 2;
        const view = new DataView(new ArrayBuffer(44 + length));
        
        // RIFF chunk descriptor
        const writeString = (view, offset, string) => {
            for (let i = 0; i < string.length; i++) view.setUint8(offset + i, string.charCodeAt(i));
        };
        
        writeString(view, 0, 'RIFF');
        view.setUint32(4, 36 + length, true);
        writeString(view, 8, 'WAVE');
        writeString(view, 12, 'fmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true); // PCM
        view.setUint16(22, 1, true); // Mono
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * 2, true);
        view.setUint16(32, 2, true);
        view.setUint16(34, 16, true);
        writeString(view, 36, 'data');
        view.setUint32(40, length, true);
        
        // Skriv PCM-data
        let offset = 44;
        for (let i = 0; i < buffer.length; offset += 2, i++) {
            let s = Math.max(-1, Math.min(1, buffer[i]));
            view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
        }
        
        return new Blob([view], { type: 'audio/wav' });
    }
}
