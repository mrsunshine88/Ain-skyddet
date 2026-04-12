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
    async transcribeFromElement(mediaElement, durationMs = 5000) {
        if (!mediaElement || !this.transcriber) return null;
        
        console.log(`[AVLYSSNING] Startar 5s inspelning av ${mediaElement.id}...`);
        
        return new Promise((resolve) => {
            const tempCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
            const source = tempCtx.createMediaElementSource(mediaElement);
            const processor = tempCtx.createScriptProcessor(4096, 1, 1);
            
            const chunks = [];
            source.connect(processor);
            processor.connect(tempCtx.destination);
            
            processor.onaudioprocess = (e) => {
                const input = e.inputBuffer.getChannelData(0);
                chunks.push(new Float32Array(input));
            };
            
            setTimeout(async () => {
                processor.disconnect();
                source.disconnect();
                
                const totalLength = chunks.reduce((acc, curr) => acc + curr.length, 0);
                const buf = new Float32Array(totalLength);
                let offset = 0;
                for (const chunk of chunks) { buf.set(chunk, offset); offset += chunk.length; }
                
                try {
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
}
