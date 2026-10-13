param(
  # Sin -Apply solo muestra el plan (db push --dry-run). Con -Apply aplica las migraciones.
  [switch]$Apply
)

# Aplica la cadena de supabase/migrations EXCLUSIVAMENTE al proyecto autorizado.
# Requiere que la CLI esté autenticada con la cuenta dueña del proyecto nuevo
# (supabase login o $env:SUPABASE_ACCESS_TOKEN) y vinculada con
# supabase link --project-ref ekepygodvciqnqkrgrsv. Nunca guarda contraseñas ni tokens.
$ErrorActionPreference = 'Stop'
$authorizedRef = 'ekepygodvciqnqkrgrsv'
$workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
Set-Location -LiteralPath $workspace

& (Join-Path $PSScriptRoot 'guard-supabase.ps1') -RequireLinked

# La cuenta de la CLI debe poder ver el proyecto autorizado.
$projects = & supabase projects list 2>&1 | Out-String
if ($LASTEXITCODE -ne 0 -or $projects -notmatch [regex]::Escape($authorizedRef)) {
  throw "La sesión de Supabase CLI no tiene acceso a $authorizedRef. Inicia sesión con la cuenta dueña del proyecto."
}

# Verificación inmediatamente anterior a cada comando remoto (no basta con el vínculo previo).
function Assert-LinkedRef {
  $linked = (Get-Content -LiteralPath (Join-Path $workspace 'supabase\.temp\project-ref') -Raw).Trim()
  if ($linked -ne $authorizedRef) { throw "Destino no autorizado: $linked" }
}

Assert-LinkedRef
& supabase db push --dry-run
if ($LASTEXITCODE -ne 0) { throw 'La simulación de db push falló.' }
if (-not $Apply) {
  Write-Host 'Simulación completada. Revisa el plan y vuelve a ejecutar con -Apply para aplicarlo.'
  exit 0
}

Assert-LinkedRef
& supabase db push
if ($LASTEXITCODE -ne 0) { throw 'db push falló. Revisa el mensaje anterior; no se reintenta automáticamente.' }
Write-Host "Migraciones aplicadas a $authorizedRef."
