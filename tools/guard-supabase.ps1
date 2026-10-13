param(
  [string]$ExpectedRef = 'ekepygodvciqnqkrgrsv',
  [switch]$RequireLinked
)

$ErrorActionPreference = 'Stop'
$workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$expectedUrl = "https://$ExpectedRef.supabase.co"
$configPath = Join-Path $workspace 'js\config.js'
$config = Get-Content -LiteralPath $configPath -Raw

if ($ExpectedRef -ne 'ekepygodvciqnqkrgrsv') { throw 'El ref solicitado no coincide con el destino autorizado.' }
if ($config -notmatch [regex]::Escape($expectedUrl)) { throw "El frontend no apunta a $expectedUrl" }
if ($config -match 'gacqqaimdfvkmznsglpg') { throw 'Se detectó el ref heredado en la configuración ejecutable.' }

if ($env:SUPABASE_PROJECT_REF -and $env:SUPABASE_PROJECT_REF -ne $ExpectedRef) {
  throw 'SUPABASE_PROJECT_REF no coincide con el destino autorizado.'
}
if ($env:SUPABASE_URL -and $env:SUPABASE_URL.TrimEnd('/') -ne $expectedUrl) {
  throw 'SUPABASE_URL no coincide con el destino autorizado.'
}

$linkedRefPath = Join-Path $workspace 'supabase\.temp\project-ref'
if (Test-Path -LiteralPath $linkedRefPath) {
  $linkedRef = (Get-Content -LiteralPath $linkedRefPath -Raw).Trim()
  if ($linkedRef -ne $ExpectedRef) { throw "La CLI está vinculada a un proyecto no autorizado: $linkedRef" }
} elseif ($RequireLinked) {
  throw 'La CLI todavía no está vinculada al proyecto nuevo.'
}

$status = & curl.exe -sS -o NUL -w '%{http_code}' --max-time 15 -H 'apikey: sb_publishable_bhVzuCy3cuF2JlPjdsDsiA_j-Rkb-dh' "$expectedUrl/auth/v1/settings"
if ($LASTEXITCODE -ne 0 -or $status -ne '200') { throw 'No se pudo verificar el host del proyecto nuevo.' }

Write-Host "AISLAMIENTO VERIFICADO: $ExpectedRef"
Write-Host "Destino: $expectedUrl"
Write-Host 'La ejecución remota aún requiere vínculo CLI y contraseña/token suministrados por un canal seguro.'
