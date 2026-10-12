# Grabs the top strip of the primary screen, where the island lives.
# Development aid only — not part of the app.
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)

$h = [Math]::Min(440, $b.Height)
$crop = New-Object System.Drawing.Bitmap $b.Width, $h
$g2 = [System.Drawing.Graphics]::FromImage($crop)
$src = New-Object System.Drawing.Rectangle 0, 0, $b.Width, $h
$g2.DrawImage($bmp, $src, $src, [System.Drawing.GraphicsUnit]::Pixel)

$out = Join-Path $PSScriptRoot "..\.shots\top.png"
New-Item -ItemType Directory -Force -Path (Split-Path $out) | Out-Null
$crop.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Output "$out ($($b.Width)x$h)"
