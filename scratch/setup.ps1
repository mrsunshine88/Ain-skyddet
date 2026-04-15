docker rm -f double-take-final
Remove-Item -LiteralPath 'C:\Users\perss\Desktop\Frigate\config.yml' -Recurse -Force -ErrorAction SilentlyContinue

$config = @"
mqtt:
  host: 192.168.176.1
confidence: 40

frigate:
  url: http://192.168.176.1:5000
  update_sub_labels: true

train:
  path: /train

detectors:
  deepstack:
    url: http://192.168.176.1:32168
    timeout: 30

outputs:
  mqtt:
    enabled: true

purge:
  images: 1
"@

Set-Content -Path 'C:\Users\perss\Desktop\Frigate\config.yml' -Value $config
Set-Location 'C:\Users\perss\Desktop\Frigate'
docker-compose up -d
