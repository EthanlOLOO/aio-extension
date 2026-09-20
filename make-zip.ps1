# 릴리스에 붙일 zip 을 만든다. 압축을 풀면 aio-extension 폴더 하나가 나오고,
# 그 안에 manifest.json 이 있다 — 친구들이 크롬에 그 폴더를 그대로 고르면 된다.
param([Parameter(Mandatory = $true)][string]$Version)

$stage = Join-Path $env:TEMP "aio-extension-zip\aio-extension"
Remove-Item (Split-Path $stage) -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $stage -Force | Out-Null

# 익스텐션이 쓰는 것만 담는다 (.git · zip · 메모는 뺀다)
Get-ChildItem -Path $PSScriptRoot -File |
  Where-Object { $_.Extension -in ".js", ".json", ".html", ".css", ".md" -and $_.Name -ne "make-zip.ps1" } |
  Copy-Item -Destination $stage

$out = Join-Path $PSScriptRoot "aio-extension-v$Version.zip"
Remove-Item $out -Force -ErrorAction SilentlyContinue
Compress-Archive -Path $stage -DestinationPath $out
"만들었습니다: $out"
