param([int]$Port = 8000)

$root = Split-Path -Parent $MyInvocation.MyCommand.Definition

if (Get-Command node -ErrorAction SilentlyContinue) {
    Write-Host "啟動靜態伺服器： http://localhost:$Port （按 Ctrl+C 停止）" -ForegroundColor Green
    node (Join-Path $root "serve.mjs") $Port
} elseif (Get-Command python -ErrorAction SilentlyContinue) {
    Write-Host "啟動靜態伺服器： http://localhost:$Port （按 Ctrl+C 停止）" -ForegroundColor Green
    Push-Location $root
    python -m http.server $Port
    Pop-Location
} else {
    Write-Host "找不到 node 或 python，請改用其他靜態伺服器開啟此資料夾。" -ForegroundColor Red
}
