# ─────────────────────────────────────────────────────────────────────────────
# generar-certificado.ps1 — Preparación para pruebas de emisión con CAE en ARCA
# (ex AFIP) para InvoTrack.
#
# Genera la clave privada (PKCS#8) y el CSR que se pega en el servicio WSASS
# de ARCA para obtener el certificado de homologación.
#
# Uso (desde PowerShell, en la raíz del repo):
#   .\scripts\arca\generar-certificado.ps1
#
# Resultado:
#   clave-privada.key    → NUNCA se sube ni se comparte. Va como AFIP_KEY.
#   pedido.csr           → se pega en WSASS para generar el certificado.
#
# ─────────────────────────────────────────────────────────────────────────────
# PASO A MANO en ARCA (una sola vez):
#   1. Entrar a https://auth.afip.gob.ar/contribuyente_/login.xhtml con una
#      CUIT de persona física y Clave Fiscal.
#   2. Adherir el servicio "WSASS — Autogestión de certificados para servicios
#      web en ambientes de homologación".
#   3. En WSASS: "Nuevo Certificado", pegar el contenido completo de pedido.csr
#      y obtener el certificado. Guardarlo como certificado.pem.
#   4. En WSASS: "Crear Autorización a Servicio" con el alias elegido,
#      la CUIT que se usará en las pruebas y el servicio de Facturación
#      Electrónica (WSFEv1) de homologación.
#
# Después, subir a Supabase (Project Settings → Edge Functions → Secrets):
#   AFIP_CERT  = contenido base64 de certificado.pem
#   AFIP_KEY   = contenido base64 de clave-privada.key
#   AFIP_CUIT  = CUIT sin guiones que autorizó el certificado
#   AFIP_ENVIRONMENT = "testing"   (no tocar hasta pasar a producción)
# ─────────────────────────────────────────────────────────────────────────────

param(
    [string]$Cuit = $(Read-Host "CUIT para el certificado (solo digitos, ej 20123456789)"),
    [string]$Alias = "InvoTrackTest",
    [string]$OutputDir = $(Join-Path $PSScriptRoot "salida")
)

$ErrorActionPreference = "Stop"

# Validación básica del CUIT: 11 dígitos
$Cuit = $Cuit.Trim()
if ($Cuit -notmatch '^\d{11}$') {
    Write-Error "El CUIT debe tener exactamente 11 dígitos, sin guiones. Recibido: '$Cuit'"
    exit 1
}

# Verificar que OpenSSL esté disponible
if (-not (Get-Command openssl -ErrorAction SilentlyContinue)) {
    Write-Error "No se encontró 'openssl' en el PATH. Instalalo (ej: choco install openssl) y reintentá."
    exit 1
}

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

$KeyPath = Join-Path $OutputDir "clave-privada.key"
$CsrPath = Join-Path $OutputDir "pedido.csr"

Write-Host "→ Generando clave privada RSA 2048 (PKCS#8)..." -ForegroundColor Cyan
# genpkey genera directamente PKCS#8, formato que acepta crypto.subtle en Deno/Node.
& openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out $KeyPath
if ($LASTEXITCODE -ne 0) { Write-Error "Falló la generación de la clave."; exit 1 }

Write-Host "→ Generando CSR para CUIT $Cuit / $Alias..." -ForegroundColor Cyan
# ARCA exige serialNumber="CUIT <11 digitos>" en el subject del CSR.
& openssl req -new -key $KeyPath -subj "/C=AR/O=InvoTrack/CN=$Alias/serialNumber=CUIT $Cuit" -out $CsrPath
if ($LASTEXITCODE -ne 0) { Write-Error "Falló la generación del CSR."; exit 1 }

Write-Host ""
Write-Host "Listo. Archivos generados en: $OutputDir" -ForegroundColor Green
Write-Host "  clave-privada.key  → NUNCA la subas ni la compartas (se usa como AFIP_KEY)"
Write-Host "  pedido.csr         → pegá TODO este archivo en WSASS para obtener certificado.pem"
Write-Host ""
Write-Host "Próximo paso: entrar a ARCA, adherir WSASS y crear el certificado."
