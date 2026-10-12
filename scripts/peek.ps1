# Dev aid: photograph the island exactly as it is on screen.
# DPI-aware and cropped to the island's own window, so what is on top of it on
# screen does not matter. Pass -Open to hover it first and wait for it to settle.
param([switch]$Open)

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices;
public class Peek {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; } }
"@
[void][Peek]::SetProcessDPIAware()

$p = Get-Process ryfe -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $p) { Write-Output 'ryfe is not running'; exit 1 }

if ($Open) { [void][Peek]::SetCursorPos(200, 25) } else { [void][Peek]::SetCursorPos(700, 700) }
Start-Sleep -Seconds 9   # long enough for hover-open, fold, and window resize

# Measure only once everything has stopped moving.
$before = 0; $r = New-Object Peek+RECT
for ($i = 0; $i -lt 20; $i++) {
  [void][Peek]::GetWindowRect($p.MainWindowHandle, [ref]$r)
  $now = ($r.R - $r.L) * 10000 + ($r.B - $r.T)
  if ($now -eq $before) { break }
  $before = $now
  Start-Sleep -Milliseconds 400
}

$w = $r.R - $r.L; $h = $r.B - $r.T
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.L, $r.T, 0, 0, (New-Object System.Drawing.Size $w, $h))
$name = if ($Open) { 'open' } else { 'compact' }
$out = "C:\elezen_ryfe-github\ryfe\.shots\$name.png"
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Output "$out  window $($r.L),$($r.T) ${w}x${h}"
