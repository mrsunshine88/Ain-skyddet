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

$utf8NoBom = New-Object System.Text.UTF8Encoding $False
[System.IO.File]::WriteAllText("C:\Users\perss\Desktop\Frigate\config.yml", $config, $utf8NoBom)
