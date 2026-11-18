# Installs the my-herdr layout into herdr-app: copies the two mods and the layout,
# then switches to it. Run it again after every change or pull (herdr-app reloads
# copied files at once; it doesn't see edits through a link).
$ErrorActionPreference = "Stop"
$app = if ($env:HERDR_APP_HOME) { $env:HERDR_APP_HOME } else { Join-Path $HOME ".config\herdr-app" }
if (-not (Test-Path $app)) { throw "herdr-app folder not found: $app (start herdr-app once first)" }

foreach ($mod in "my-files", "my-changes") {
  # A mod can't import from outside its folder: each gets its own copy of shared/common.js
  # (in the repo too, git-ignored, so the repo's mod folders run as they are).
  Copy-Item (Join-Path $PSScriptRoot "shared\common.js") (Join-Path $PSScriptRoot "mods\$mod") -Force
  $link = Join-Path $app "mods\$mod"
  $item = Get-Item $link -ErrorAction SilentlyContinue
  if ($item -and $item.LinkType) { $item.Delete() } # an older install linked it
  New-Item -ItemType Directory -Force $link | Out-Null
  Copy-Item (Join-Path $PSScriptRoot "mods\$mod\*") $link -Force -Exclude *.test.mjs
  # herdr-app is a GUI exe: PowerShell only waits for it (and its output) through a pipe.
  $ErrorActionPreference = "Continue"
  $out = & herdr-app check $link 2>&1 | Out-String
  $ErrorActionPreference = "Stop"
  if ($out -notmatch "check passed") { throw "check failed: $mod`n$out" }
}

Copy-Item (Join-Path $PSScriptRoot "layouts\my-herdr.json") (Join-Path $app "layouts\my-herdr.json") -Force
$ErrorActionPreference = "Continue"
& herdr-app do layout.switch --name my-herdr 2>&1 | Out-Null
Write-Host "Installed. ctrl+shift+L switches layouts; uninstall.ps1 removes it."
