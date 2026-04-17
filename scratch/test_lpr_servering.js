const mqtt = require('mqtt');
const http = require('http');

// 1. Mock Frigate API
const server = http.createServer((req, res) => {
    console.log(`[MOCK-FRIGATE] Mottog förfrågan: ${req.url}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        id: "TEST_EVENT_123",
        sub_label: "Andreas bil",
        label: "car"
    }));
});

server.listen(5051, () => {
    console.log("[MOCK-FRIGATE] API-server lyssnar på port 5051");
    
    // 2. Skicka MQTT-event
    const client = mqtt.connect('mqtt://localhost:1883');
    client.on('connect', () => {
        console.log("[MOCK-MQTT] Skickar test-event...");
        const payload = {
            after: {
                id: "123456789.000-TEST",
                camera: "Infarten",
                data: {
                    objects: ["car"],
                    detections: ["TEST_EVENT_123"]
                }
            }
        };
        client.publish('frigate/reviews', JSON.stringify(payload));
        console.log("[MOCK-MQTT] Event skickat! Kontrollera JARVIS-loggen.");
        
        setTimeout(() => {
            console.log("[MOCK] Avslutar test...");
            client.end();
            server.close();
            process.exit(0);
        }, 10000);
    });
});
