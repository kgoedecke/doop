# Tauri's bundle.windows.signCommand for release builds: signs one file (the
# app .exe, the NSIS installer, its uninstaller) with Azure Artifact Signing.
# desktop-release.yml sets the three paths below after logging the Azure CLI in
# through OIDC; the signing library authenticates through that CLI session.
param([Parameter(Mandatory = $true)][string]$File)

$ErrorActionPreference = 'Stop'

& $env:SIGNTOOL_PATH sign /v /fd SHA256 `
  /tr http://timestamp.acs.microsoft.com /td SHA256 `
  /dlib $env:ARTIFACT_SIGNING_DLIB /dmdf $env:ARTIFACT_SIGNING_METADATA `
  /d doop $File
exit $LASTEXITCODE
