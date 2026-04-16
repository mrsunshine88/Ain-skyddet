const mqtt = require('mqtt');
const fs = require('fs');
const client = mqtt.connect('mqtt://localhost:1883');

const logFile = 'mqtt_dump.txt';
fs.writeFileSync(logFile, `--- MQTT DUMP START (${new Date().toLocaleString()}) ---\n`);

console.log('LYSSNAR PÅ ALLT... GÅ FÖRBI KAMERAN NU!');

client.on('connect', () => {
    client.subscribe('#');
});

client.on('message', (topic, message) => {
    const payload = message.toString();
    const entry = `\n[${new Date().toLocaleTimeString()}] TOPIC: ${topic}\nPAYLOAD: ${payload}\n`;
    fs.appendFileSync(logFile, entry);
    console.log(`Fångade: ${topic}`);
});

setTimeout(() => {
    console.log('KLART! Analyserar data...');
    client.end();
}, 60000);
