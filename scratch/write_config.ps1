$config = @"
mqtt:
  host: 192.168.176.1

frigate:
  url: http://192.168.176.1:5000

detectors:
  deepstack:
    url: http://192.168.176.1:32168
"@

$utf8NoBom = New-Object System.Text.UTF8Encoding $False
[System.IO.File]::WriteAllText("C:\Users\perss\Desktop\Frigate\config.yml", $config, $utf8NoBom)
docker restart double-take-final
