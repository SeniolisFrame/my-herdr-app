# Removes the my-herdr layout and the mod links (the repo stays), back to herdr's main layout.
$app = if ($env:HERDR_APP_HOME) { $env:HERDR_APP_HOME } else { Join-Path $HOME ".config\herdr-app" }
& herdr-app do layout.switch --name main 2>&1 | Out-Null
Remove-Item (Join-Path $app "layouts\my-herdr.json") -ErrorAction SilentlyContinue
foreach ($mod in "my-files", "my-changes", "my-board") {
  $item = Get-Item (Join-Path $app "mods\$mod") -ErrorAction SilentlyContinue
  if ($item.LinkType) { $item.Delete() } # a link: never recurse into the repo behind it
  elseif ($item) { Remove-Item -Recurse -Force $item.FullName }
}
Write-Host "Removed."
