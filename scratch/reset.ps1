$lines = @(
    "mqtt:"
    "  host: 192.168.176.1"
    "frigate:"
    "  url: http://192.168.176.1:5000"
    "detectors:"
    "  deepstack:"
    "    url: http://192.168.176.1:32168"
)

Set-Content -Path 'C:\Users\perss\Desktop\Frigate\config.yml' -Value $lines
docker restart double-take-final
